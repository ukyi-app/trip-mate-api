import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { UnavailableError } from "../../core/errors.ts";
import { requireAuth, requireTripMember } from "../../core/guards.ts";
import type { MembershipLookup, SessionResolver } from "../../core/guards.ts";
import { errorResponses } from "../../core/http.ts";
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
      responses: { ...ok(usageParseResponseSchema), ...errorResponses(403, 422, 502, 503) },
    }),
    async (c) => {
      if (!deps.parser) throw new UnavailableError("usage parsing not configured");
      const { text, reference_date } = c.req.valid("json");
      const trip = deps.tripContext ? await deps.tripContext(c.req.valid("param").tripId) : null;
      const referenceDate =
        reference_date ?? dateFormatterFor(trip?.timezone).format(deps.now?.() ?? new Date());
      const drafts = await deps.parser.parse({
        text,
        referenceDate,
        ...(trip
          ? { tripTimezone: trip.timezone, tripStart: trip.start_date, tripEnd: trip.end_date }
          : {}),
      });
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
