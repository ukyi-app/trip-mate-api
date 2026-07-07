import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  TooManyRequestsError,
  UnavailableError,
  UnsupportedMediaTypeError,
  ValidationError,
} from "../../core/errors.ts";
import { requireAuth, requireTripMember } from "../../core/guards.ts";
import type { MembershipLookup, SessionResolver } from "../../core/guards.ts";
import { errorResponses, idempotencyKeyHeader } from "../../core/http.ts";
import { clientIp } from "../../core/rate-limit.ts";
import { idempotency, type IdempotencyStore } from "../../core/idempotency.ts";
import type { UsageMetrics } from "../../core/metrics.ts";
import { expenseDraftListSchema } from "../expense-drafts/expense-drafts.schema.ts";
import type { ExpenseDraftResponse } from "../expense-drafts/expense-drafts.schema.ts";
import type { ParserQuotaCheck, ParserQuotaRefund } from "./parser-quota.ts";
import { usageParseRequestSchema } from "./usage-imports.schema.ts";
import type { UsageDraft } from "./usage-imports.schema.ts";
import type { UsageImage, UsageParserPort } from "./usage-parser.port.ts";
import { clampOutOfWindowConfidence } from "./usage-window.ts";

/** 파싱 초안 지속 포트 — 저장 후 id 포함 응답 DTO 반환(expense-drafts 서비스 배선).
 *  opts.importKey=Idempotency-Key(크래시-갭 replay), opts.sourceObjectKey=이미지 원본 object key(이미지 소스). */
export type PersistDrafts = (
  tripId: string,
  memberId: string,
  drafts: UsageDraft[],
  source: "text" | "image",
  opts?: { importKey?: string; sourceObjectKey?: string },
) => Promise<ExpenseDraftResponse[]>;

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
  persistDrafts: PersistDrafts; // 파싱 초안 저장(지속형) — id 포함 반환. parser와 함께 배선
  recordDisclosure: (userId: string, opts?: { ip?: string }) => Promise<void>; // PB-1: LLM 전송 전 llm_disclosure 기록(fail-closed, 필수 dep)
  idempotencyStore?: IdempotencyStore | null; // Idempotency-Key 재시도 dedup(없으면 미적용). parse가 저장을 하므로 필요
  maxImageBytes?: number; // 이미지 업로드 상한(기본 8MB)
  now?: () => Date; // 테스트 결정성 — reference_date 기본값(서버 오늘)
}

// 이미지 파싱 허용 타입 — codex·claude 두 엔진 **교집합**(claude 비전은 heic/heif 미지원).
// 라우트가 광고한 타입은 어떤 엔진이든 쿼터 소모 전 통과되도록(리뷰 E). HTML/SVG류 배제(인젝션·XSS, ④ 영수증 선례).
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const DEFAULT_MAX_IMAGE = 8 * 1024 * 1024; // 8MB
// 매직바이트만 유효한 잘린 페이로드(예: FF D8 FF 3바이트)가 파서 쿼터·LLM을 소모하는 것 차단(리뷰 N).
// 완전 디코딩 아닌 하한 휴리스틱 — 실 영수증·스크린샷은 수 KB. 잔여(하한 이상 junk)는 쿼터·인증 게이팅으로 제한.
const MIN_IMAGE_BYTES = 64;

/** 매직바이트로 실제 이미지 여부 검증(쿼터·LLM 소모 전). 선언 content-type과 시그니처 불일치=거부(리뷰 K).
 *  junk 바이트를 image/*로 위장해 파서 쿼터/업스트림 비용을 소모하는 남용 차단. 완전 디코딩 아님(경량 시그니처). */
function matchesImageSignature(b: Uint8Array, contentType: string): boolean {
  switch (contentType) {
    case "image/jpeg": // FF D8 FF
      return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "image/png": // 89 50 4E 47 0D 0A 1A 0A
      return (
        b.length >= 8 &&
        b[0] === 0x89 &&
        b[1] === 0x50 &&
        b[2] === 0x4e &&
        b[3] === 0x47 &&
        b[4] === 0x0d &&
        b[5] === 0x0a &&
        b[6] === 0x1a &&
        b[7] === 0x0a
      );
    case "image/webp": // "RIFF"...."WEBP"
      return (
        b.length >= 12 &&
        b[0] === 0x52 &&
        b[1] === 0x49 &&
        b[2] === 0x46 &&
        b[3] === 0x46 &&
        b[8] === 0x57 &&
        b[9] === 0x45 &&
        b[10] === 0x42 &&
        b[11] === 0x50
      );
    default:
      return false;
  }
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

type TripCtx = { timezone: string; start_date: string; end_date: string };

/** 공용 파싱 파이프라인 — 쿼터(슬롯 없이) → parse 실행(동시성 자기보호) → 후검증 clamp → 지속 저장.
 *  텍스트·이미지 라우트가 run 함수만 바꿔 공유(쿼터 순서·환불·메트릭·clamp를 한 곳에서). */
async function runParsePipeline(
  deps: Deps,
  args: {
    userId: string;
    tripId: string;
    memberId: string;
    trip: TripCtx | null;
    run: () => Promise<UsageDraft[]>;
    source: "text" | "image";
    importKey?: string;
    ip?: string;
  },
): Promise<ExpenseDraftResponse[]> {
  const { userId, tripId, memberId, trip, run, source } = args;
  if (deps.quotaCheck) {
    const q = await deps.quotaCheck(userId, tripId);
    if (!q.ok) {
      deps.metrics?.recordRequest("quota_exceeded");
      throw new TooManyRequestsError("usage parse quota exceeded", {
        retryAfterSeconds: q.retryAfter,
      });
    }
  }
  // PB-1: 외부 LLM 전송 전 llm_disclosure 동의 기록 — fail-closed(기록 실패 시 throw 전파 → 전송 안 함).
  // 쿼터 뒤·run() 앞에 둬 "곧 전송한다"에 최밀착. 쿼터 차단·validation 실패 시엔 도달 안 함(전송 없음).
  // 기록 실패도 LLM 미호출이므로 쿼터 환불(busy와 동일 — consents 장애로 공유 trip 쿼터가 고갈되지 않게).
  try {
    await deps.recordDisclosure(userId, args.ip !== undefined ? { ip: args.ip } : {});
  } catch (e) {
    await deps.quotaRefund?.(userId, tripId).catch(() => {}); // best-effort — 환불 실패가 원 에러를 가리지 않게
    deps.metrics?.recordRequest("error"); // 대시보드에서 사라지지 않게(다른 outcome과 일관)
    throw e;
  }
  // parse가 동시성을 자기보호(busy면 UnavailableError). 슬롯은 parse 실행 동안만 → context·quota가 앞이라
  // I/O 동안 슬롯을 잡지 않는다. busy는 LLM 미호출이므로 쿼터 환불(공유 trip 쿼터 고갈 방지).
  const startedAt = deps.now?.() ?? new Date();
  let drafts: UsageDraft[];
  try {
    try {
      drafts = await run();
    } catch (e) {
      // 미착수(busy·codex spawn 실패=UnavailableError)만 환불. LLM 착수 후 실패(UpstreamError)는 소모 유지.
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
  // import_key를 **source로 네임스페이스** — 같은 클라 Idempotency-Key를 text/image에 재사용해도 createMany의
  // (trip,member,import_key) replay가 교차 route 배치를 stale로 반환하지 않게(리뷰 L). 미들웨어는 path로 이미 분리.
  return deps.persistDrafts(
    tripId,
    memberId,
    checked,
    source,
    args.importKey ? { importKey: `${source}:${args.importKey}` } : {},
  );
}

export function registerUsageImportRoutes(app: OpenAPIHono, deps: Deps): void {
  const auth = requireAuth(deps.resolver);
  const member = requireTripMember(deps.memberLookup);
  // parse가 초안을 **저장**하므로 재시도 dedup 필요 — Idempotency-Key 있으면 재시도는 저장 응답 리플레이(중복 초안 방지).
  const idem = deps.idempotencyStore ? [idempotency(deps.idempotencyStore)] : [];

  // ── 텍스트 파싱(openapi 계약) ──────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/trips/{tripId}/usage-imports/parse",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member, ...idem],
      request: {
        params: z.object({ tripId: z.string().uuid() }),
        headers: idempotencyKeyHeader,
        body: jsonBody(usageParseRequestSchema),
      },
      responses: { ...ok(expenseDraftListSchema), ...errorResponses(403, 422, 429, 502, 503) },
    }),
    async (c) => {
      const parser = deps.parser;
      if (!parser) {
        deps.metrics?.recordRequest("unavailable");
        throw new UnavailableError("usage parsing not configured");
      }
      const userId = c.get("user").id;
      const ip = clientIp(c.req.raw.headers) || undefined;
      const tripId = c.req.valid("param").tripId;
      const { text, reference_date } = c.req.valid("json");
      // context·quota는 슬롯 없이 먼저 — 느린 DB/Redis가 파서 슬롯을 잡아 false busy를 만들지 않게(리뷰).
      const trip = deps.tripContext ? await deps.tripContext(tripId) : null;
      const referenceDate =
        reference_date ?? dateFormatterFor(trip?.timezone).format(deps.now?.() ?? new Date());
      const idemKey = c.req.header("idempotency-key");
      const saved = await runParsePipeline(deps, {
        userId,
        tripId,
        memberId: c.get("membership").id,
        trip,
        source: "text",
        ...(idemKey ? { importKey: idemKey } : {}),
        ...(ip ? { ip } : {}),
        run: () =>
          parser.parse({
            text,
            referenceDate,
            ...(trip
              ? { tripTimezone: trip.timezone, tripStart: trip.start_date, tripEnd: trip.end_date }
              : {}),
          }),
      });
      return c.json({ drafts: saved }, 200);
    },
  );

  // ── 이미지 파싱(plain — 바이너리 바디는 zod-openapi 부적합, ④ 영수증 라우트와 동일 패턴: openapi 미포함, FE 직접 호출) ──
  const maxImage = deps.maxImageBytes ?? DEFAULT_MAX_IMAGE;
  // **member 앞** 가드 — 타입(415) + tripId uuid(422)를 requireTripMember의 DB 조회 전에 검증(malformed tripId가
  // uuid 컬럼 비교에서 22P02→500 나는 것 방지, 리뷰 I). auth 뒤·member 앞.
  const imageGuard: MiddlewareHandler = async (c, next) => {
    const ct = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!IMAGE_TYPES.has(ct))
      throw new UnsupportedMediaTypeError("unsupported image type", { allowed: [...IMAGE_TYPES] });
    if (!z.string().uuid().safeParse(c.req.param("tripId")).success)
      throw new ValidationError("invalid tripId");
    // 선언 Content-Length 선검사 — member DB 조회·버퍼링 전에 과대 업로드 거부(리뷰 1). chunked는 capBody가 백스톱.
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > maxImage)
      throw new ValidationError("image too large", { max: maxImage });
    await next();
  };
  // **idempotency 앞** 바디 캡 — Content-Length 있으면 즉시 거부, 없으면(chunked) maxSize에서 스트림 중단(버퍼링
  // 상한, 리뷰 H·J). idempotency가 해시하려 버퍼링하기 전에 적용. onError로 문제+json 422.
  const capBody = bodyLimit({
    maxSize: maxImage,
    onError: () => {
      throw new ValidationError("image too large", { max: maxImage });
    },
  });
  app.post(
    "/trips/:tripId/usage-imports/parse-image",
    auth,
    imageGuard,
    member,
    capBody,
    ...idem,
    async (c) => {
      const parser = deps.parser;
      if (!parser?.parseImage) {
        deps.metrics?.recordRequest("unavailable");
        throw new UnavailableError("usage image parsing not configured");
      }
      // 외부 LLM 전송 고지 동의(계약) — 텍스트 라우트의 disclosure_accepted를 쿼리로 받는다.
      if (c.req.query("disclosure_accepted") !== "true")
        throw new ValidationError("disclosure_accepted must be true");
      const ct = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const buf = await c.req.arrayBuffer(); // capBody가 maxImage로 상한
      if (buf.byteLength === 0) throw new ValidationError("empty image body");
      if (buf.byteLength < MIN_IMAGE_BYTES)
        throw new ValidationError("image too small", { min: MIN_IMAGE_BYTES }); // 잘린 junk 차단(리뷰 N)
      const bytes = new Uint8Array(buf);
      // 매직바이트 검증 — junk를 image/*로 위장한 요청이 쿼터·LLM을 소모하기 전에 거부(리뷰 K).
      if (!matchesImageSignature(bytes, ct))
        throw new UnsupportedMediaTypeError("image bytes do not match declared type", {
          contentType: ct,
        });
      // 기준일 쿼리(선택) — 있으면 ISO date 검증, 없으면 여행 timezone 기준 서버 오늘.
      const refQ = c.req.query("reference_date");
      if (refQ !== undefined && !z.iso.date().safeParse(refQ).success)
        throw new ValidationError("invalid reference_date", { reference_date: refQ });
      const userId = c.get("user").id;
      const ip = clientIp(c.req.raw.headers) || undefined;
      const tripId = c.req.param("tripId")!;
      const trip = deps.tripContext ? await deps.tripContext(tripId) : null;
      const referenceDate =
        refQ ?? dateFormatterFor(trip?.timezone).format(deps.now?.() ?? new Date());
      const image: UsageImage = { bytes, contentType: ct };
      const idemKey = c.req.header("idempotency-key");
      // NOTE: 이미지 원본 저장(source_object_key 링크)은 이 슬라이스에서 분리 — 원자적 객체-DB 링크(빈 파싱·멱등
      // replay·부분 실패 시 고아 파일 방지)가 별도 설계 과제라 활성화 시 확정(설계 §슬라이스4 잔여). 지금은 파싱만.
      const saved = await runParsePipeline(deps, {
        userId,
        tripId,
        memberId: c.get("membership").id,
        trip,
        source: "image",
        ...(idemKey ? { importKey: idemKey } : {}),
        ...(ip ? { ip } : {}),
        run: () =>
          parser.parseImage!(
            {
              referenceDate,
              ...(trip
                ? {
                    tripTimezone: trip.timezone,
                    tripStart: trip.start_date,
                    tripEnd: trip.end_date,
                  }
                : {}),
            },
            image,
          ),
      });
      return c.json({ drafts: saved }, 200);
    },
  );
}
