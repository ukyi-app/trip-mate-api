import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { TooManyRequestsError, UnavailableError } from "../../core/errors.ts";
import { requireAuth, requireTripMember } from "../../core/guards.ts";
import type { MembershipLookup, SessionResolver } from "../../core/guards.ts";
import { errorResponses } from "../../core/http.ts";
import type { UsageMetrics } from "../../core/metrics.ts";
import type { ParserQuotaCheck, ParserQuotaRefund } from "./parser-quota.ts";
import { usageParseRequestSchema, usageParseResponseSchema } from "./usage-imports.schema.ts";
import type { UsageParserPort } from "./usage-parser.port.ts";
import { clampOutOfWindowConfidence } from "./usage-window.ts";

/** 여행 컨텍스트(연도 없는 날짜를 여행 timezone·기간으로 보정). trip repo에서 조회, 없으면 KST 폴백. */
export type TripContext = (
  tripId: string,
) => Promise<{ timezone: string; start_date: string; end_date: string } | null>;

interface Deps {
  parser?: UsageParserPort; // 미설정(graceful off) 시 503 — 라우트는 항상 등록(스펙-런타임 일치)
  resolver: SessionResolver;
  memberLookup: MembershipLookup;
  tripContext?: TripContext; // 여행 timezone·기간(날짜 보정). 없으면 KST 폴백
  quotaCheck?: ParserQuotaCheck; // parse 전용 쿼터 소비(context 후·슬롯 예약 전). 없으면 미적용
  quotaRefund?: ParserQuotaRefund; // 슬롯 예약 실패(busy) 시 쿼터 환불
  metrics?: UsageMetrics; // 파싱 요청·지연 메트릭(없으면 미기록)
  now?: () => Date; // 테스트 결정성 — reference_date 기본값(서버 오늘)
}

/** 유효 IANA timezone이면 그 날짜 포맷터, 아니면 KST 폴백(create 시 검증되지만 방어). */
function dateFormatterFor(timezone: string | undefined): Intl.DateTimeFormat {
  if (!timezone) return KST_DATE;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
  } catch {
    return KST_DATE;
  }
}

const ok = <S extends z.ZodTypeAny>(schema: S) => ({
  200: { description: "ok", content: { "application/json": { schema } } },
});
const jsonBody = <S extends z.ZodTypeAny>(schema: S) => ({
  content: { "application/json": { schema } },
  required: true,
});

// 카드 SMS 타임스탬프는 KST — 기준일 기본값도 KST 날짜로(UTC 자정 경계에 하루 밀림 방지).
const KST_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }); // YYYY-MM-DD

/** 사용내역 텍스트 → 지출 초안(무상태, 저장 없음 — preview 선례: 멱등 불필요). */
export function registerUsageImportRoutes(app: OpenAPIHono, deps: Deps): void {
  const auth = requireAuth(deps.resolver);
  const member = requireTripMember(deps.memberLookup);

  app.openapi(
    createRoute({
      method: "post",
      path: "/trips/{tripId}/usage-imports/parse",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member],
      request: {
        params: z.object({ tripId: z.string().uuid() }),
        body: jsonBody(usageParseRequestSchema),
      },
      responses: { ...ok(usageParseResponseSchema), ...errorResponses(403, 422, 429, 502, 503) },
    }),
    async (c) => {
      const parser = deps.parser;
      if (!parser) {
        deps.metrics?.recordRequest("unavailable");
        throw new UnavailableError("usage parsing not configured");
      }
      const userId = c.get("user").id;
      const tripId = c.req.valid("param").tripId;
      const { text, reference_date } = c.req.valid("json");
      // context·quota는 **슬롯 없이** 먼저 — 느린 DB/Redis가 파서 슬롯을 잡아 false busy를 만들지 않게(리뷰).
      const trip = deps.tripContext ? await deps.tripContext(tripId) : null;
      const referenceDate =
        reference_date ?? dateFormatterFor(trip?.timezone).format(deps.now?.() ?? new Date());
      if (deps.quotaCheck) {
        const q = await deps.quotaCheck(userId, tripId);
        if (!q.ok) {
          deps.metrics?.recordRequest("quota_exceeded");
          throw new TooManyRequestsError("usage parse quota exceeded", {
            retryAfterSeconds: q.retryAfter,
          });
        }
      }
      // parse가 동시성을 자기보호(busy면 UnavailableError). 슬롯은 parse 실행 동안만 → context·quota가 앞이라
      // I/O 동안 슬롯을 잡지 않는다. busy는 LLM 미호출이므로 쿼터 환불(공유 trip 쿼터 고갈 방지).
      const startedAt = deps.now?.() ?? new Date();
      let drafts: Awaited<ReturnType<UsageParserPort["parse"]>>;
      try {
        try {
          drafts = await parser.parse({
            text,
            referenceDate,
            ...(trip
              ? { tripTimezone: trip.timezone, tripStart: trip.start_date, tripEnd: trip.end_date }
              : {}),
          });
        } catch (e) {
          // 미착수(busy·codex spawn 실패=UnavailableError)만 환불. LLM 착수 후 실패(UpstreamError)는 소모 유지.
          // 한계: codex non-zero exit(auth/config 등)이 착수인지 신호 부재 → 보수적 소모(설계 §잔여 한계, outage 한정).
          if (e instanceof UnavailableError) {
            await deps.quotaRefund?.(userId, tripId).catch(() => {}); // best-effort — 실패가 503을 가리지 않게
            deps.metrics?.recordRequest("unavailable");
          } else {
            deps.metrics?.recordRequest("error");
          }
          throw e;
        }
      } finally {
        // 성공·실패 모두 지연 기록 — 느린 timeout 실패가 대시보드에서 사라지지 않게(리뷰).
        deps.metrics?.recordDuration(
          ((deps.now?.() ?? new Date()).getTime() - startedAt.getTime()) / 1000,
        );
      }
      deps.metrics?.recordRequest("ok");
      // LLM 출력 결정적 후검증 — 여행 기간 밖 날짜는 confidence 강제 하향(모델 드리프트·인젝션 방어).
      const checked = trip
        ? clampOutOfWindowConfidence(drafts, {
            tripTimezone: trip.timezone,
            tripStart: trip.start_date,
            tripEnd: trip.end_date,
          })
        : drafts;
      return c.json({ drafts: checked }, 200);
    },
  );
}
