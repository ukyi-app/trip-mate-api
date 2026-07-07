import { describe, expect, it } from "vitest";
import { UnavailableError, UpstreamError, registerErrorFilter } from "../../core/errors.ts";
import type { MembershipLookup, SessionResolver } from "../../core/guards.ts";
import { createApp } from "../../core/openapi.ts";
import { createUsageMetrics } from "../../core/metrics.ts";
import type { IdempotencyStore } from "../../core/idempotency.ts";
import { registerUsageImportRoutes } from "./usage-imports.controller.ts";
import type { PersistDrafts } from "./usage-imports.controller.ts";
import type { UsageDraft } from "./usage-imports.schema.ts";
import type {
  UsageImage,
  UsageImageParseInput,
  UsageParseInput,
  UsageParserPort,
} from "./usage-parser.port.ts";

// zod v4 uuid()는 RFC 버전 비트까지 검증 — all-zeros류는 422가 나므로 실제 v4 형태 사용
const TRIP_ID = "a3bb189e-8bf9-4c8b-9f36-6c5c8b2a1b90";
const mkId = (i: number) => `a3bb189e-8bf9-4c8b-9f36-6c5c8b2a1b9${i}`; // 결정적 v4 uuid(초안 id)

// 기본 persist fake — 저장된 것처럼 id·메타를 부여해 ExpenseDraft 형태 반환.
const defaultPersist: PersistDrafts = async (_tripId, _memberId, list, source) =>
  list.map((d, i) => ({
    ...d,
    id: mkId(i),
    source,
    status: "pending" as const,
    confirmed_expense_id: null,
  }));

type TripCtx = { timezone: string; start_date: string; end_date: string };
function appWith(
  opts: {
    parser?: UsageParserPort;
    member?: boolean;
    now?: () => Date;
    tripContext?: (tripId: string) => Promise<TripCtx | null>;
    metrics?: ReturnType<typeof createUsageMetrics>;
    quotaCheck?: (
      userId: string,
      tripId: string,
    ) => Promise<{ ok: true } | { ok: false; retryAfter: number }>;
    quotaRefund?: (userId: string, tripId: string) => Promise<void>;
    persistDrafts?: PersistDrafts;
    maxImageBytes?: number;
    idempotencyStore?: IdempotencyStore;
  } = {},
) {
  const app = createApp();
  registerErrorFilter(app);
  const resolver: SessionResolver = async () => ({ user: { id: "u1" } });
  const memberLookup: MembershipLookup = async () =>
    opts.member === false ? null : { id: "m1", role: "member", status: "joined" };
  registerUsageImportRoutes(app, {
    resolver,
    memberLookup,
    persistDrafts: opts.persistDrafts ?? defaultPersist,
    ...(opts.parser ? { parser: opts.parser } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.tripContext ? { tripContext: opts.tripContext } : {}),
    ...(opts.metrics ? { metrics: opts.metrics } : {}),
    ...(opts.quotaCheck ? { quotaCheck: opts.quotaCheck } : {}),
    ...(opts.quotaRefund ? { quotaRefund: opts.quotaRefund } : {}),
    ...(opts.maxImageBytes !== undefined ? { maxImageBytes: opts.maxImageBytes } : {}),
    ...(opts.idempotencyStore ? { idempotencyStore: opts.idempotencyStore } : {}),
  });
  return app;
}

const DRAFT = {
  title: "스타벅스",
  local_amount: "6500",
  local_currency: "KRW",
  spent_at: "2026-07-05T03:30:00Z",
  confidence: 0.9,
};

function post(app: ReturnType<typeof appWith>, body: Record<string, unknown>) {
  return app.request(`/trips/${TRIP_ID}/usage-imports/parse`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // disclosure_accepted는 외부 LLM 전송 고지 동의 보증 — 유효 요청 기본 포함
    body: JSON.stringify({ disclosure_accepted: true, ...body }),
  });
}

describe("usage-imports parse 라우트", () => {
  it("200 — 저장된 초안(id·status 포함) 반환, 포트에 text·referenceDate(요청값) 전달", async () => {
    const calls: UsageParseInput[] = [];
    const app = appWith({
      parser: {
        parse: async (i) => {
          calls.push(i);
          return [DRAFT];
        },
      },
    });
    const res = await post(app, { text: "07/05 스타벅스 6,500원", reference_date: "2026-07-06" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { drafts: Record<string, unknown>[] };
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0]).toMatchObject({ ...DRAFT, source: "text", status: "pending" });
    expect(body.drafts[0]!.id).toBeTruthy(); // 저장 후 부여된 초안 id
    expect(calls).toEqual([{ text: "07/05 스타벅스 6,500원", referenceDate: "2026-07-06" }]);
  });

  it("파싱 초안을 persistDrafts로 저장 — memberId·source·(후검증)초안 전달", async () => {
    const saved: { tripId: string; memberId: string; drafts: UsageDraft[]; source: string }[] = [];
    const app = appWith({
      parser: { parse: async () => [DRAFT] },
      persistDrafts: async (tripId, memberId, drafts, source) => {
        saved.push({ tripId, memberId, drafts, source });
        return drafts.map((d, i) => ({
          ...d,
          id: mkId(i),
          source,
          status: "pending" as const,
          confirmed_expense_id: null,
        }));
      },
    });
    const res = await post(app, { text: "07/05 스타벅스 6,500원" });
    expect(res.status).toBe(200);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.tripId).toBe(TRIP_ID);
    expect(saved[0]!.memberId).toBe("m1"); // 미들웨어 membership.id
    expect(saved[0]!.source).toBe("text");
    expect(saved[0]!.drafts).toEqual([DRAFT]);
  });

  it("Idempotency-Key 헤더 → persistDrafts에 importKey로 전달(크래시-갭 replay 배선)", async () => {
    let importKey: string | undefined = "unset";
    const app = appWith({
      parser: { parse: async () => [DRAFT] },
      persistDrafts: async (_t, _m, drafts, source, opts) => {
        importKey = opts?.importKey;
        return drafts.map((d, i) => ({
          ...d,
          id: mkId(i),
          source,
          status: "pending" as const,
          confirmed_expense_id: null,
        }));
      },
    });
    const res = await app.request(`/trips/${TRIP_ID}/usage-imports/parse`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "imp-xyz" },
      body: JSON.stringify({ disclosure_accepted: true, text: "x" }),
    });
    expect(res.status).toBe(200);
    expect(importKey).toBe("text:imp-xyz"); // source 네임스페이스(교차 route 충돌 방지, 리뷰 L)
  });

  it("tripContext 주입 → 파서에 여행 timezone·기간 전달 + 기준일은 여행 timezone 기준", async () => {
    const calls: UsageParseInput[] = [];
    const app = appWith({
      parser: {
        parse: async (i) => {
          calls.push(i);
          return [];
        },
      },
      // 뉴욕(UTC-5): now가 UTC 08-02 02:00 → 뉴욕은 08-01 → 기준일 2026-08-01 (KST면 08-02)
      tripContext: async () => ({
        timezone: "America/New_York",
        start_date: "2026-08-01",
        end_date: "2026-08-05",
      }),
      now: () => new Date("2026-08-02T02:00:00Z"),
    });
    const res = await post(app, { text: "08/02 델리 $12 승인" });
    expect(res.status).toBe(200);
    expect(calls[0]!.tripTimezone).toBe("America/New_York");
    expect(calls[0]!.tripStart).toBe("2026-08-01");
    expect(calls[0]!.tripEnd).toBe("2026-08-05");
    expect(calls[0]!.referenceDate).toBe("2026-08-01"); // 여행 timezone 기준(KST 아님)
  });

  it("여행 기간 밖 spent_at 초안 → confidence 강제 하향(결정적 후검증)", async () => {
    const app = appWith({
      parser: {
        // 파서(LLM)가 기간 밖 날짜를 high-confidence로 내도 컨트롤러가 하향
        parse: async () => [
          {
            title: "가게",
            local_amount: "1000",
            local_currency: "USD",
            spent_at: "2026-09-01T16:00:00Z",
            confidence: 0.95,
          },
        ],
      },
      tripContext: async () => ({
        timezone: "America/New_York",
        start_date: "2026-08-01",
        end_date: "2026-08-05",
      }),
    });
    const res = await post(app, { text: "x" });
    const body = (await res.json()) as { drafts: { confidence: number }[] };
    expect(body.drafts[0]!.confidence).toBeLessThanOrEqual(0.3);
  });

  it("reference_date 미전달 → 서버 now의 KST 날짜를 기준일로 사용", async () => {
    const calls: UsageParseInput[] = [];
    const app = appWith({
      parser: {
        parse: async (i) => {
          calls.push(i);
          return [];
        },
      },
      now: () => new Date("2026-07-06T05:00:00Z"), // KST 14:00
    });
    const res = await post(app, { text: "x" });
    expect(res.status).toBe(200);
    expect(calls[0]!.referenceDate).toBe("2026-07-06");
  });

  it("KST 자정 직후(UTC 전날)에도 기준일이 하루 밀리지 않는다", async () => {
    const calls: UsageParseInput[] = [];
    const app = appWith({
      parser: {
        parse: async (i) => {
          calls.push(i);
          return [];
        },
      },
      now: () => new Date("2026-07-05T16:30:00Z"), // KST 2026-07-06 01:30
    });
    await post(app, { text: "x" });
    expect(calls[0]!.referenceDate).toBe("2026-07-06");
  });

  it("빈 text → 422 problem+json", async () => {
    const res = await post(appWith({ parser: { parse: async () => [] } }), { text: "" });
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });

  it("disclosure_accepted 누락/false → 422 (LLM 전송 동의 계약)", async () => {
    const app = appWith({ parser: { parse: async () => [] } });
    const missing = await post(app, { text: "x", disclosure_accepted: undefined });
    expect(missing.status).toBe(422);
    const declined = await post(app, { text: "x", disclosure_accepted: false });
    expect(declined.status).toBe(422);
  });

  it("4,000자 초과 text → 422", async () => {
    const res = await post(appWith({ parser: { parse: async () => [] } }), {
      text: "가".repeat(4_001),
    });
    expect(res.status).toBe(422);
  });

  it("비멤버 → 403", async () => {
    const res = await post(appWith({ parser: { parse: async () => [] }, member: false }), {
      text: "x",
    });
    expect(res.status).toBe(403);
  });

  it("포트 UpstreamError → 502 problem+json(code=UpstreamError)", async () => {
    const app = appWith({
      parser: {
        parse: async () => {
          throw new UpstreamError("llm down");
        },
      },
    });
    const res = await post(app, { text: "x" });
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("UpstreamError");
  });

  it("UpstreamError(LLM 착수 후 실패)는 쿼터 환불하지 않는다(비용 발생 — 리뷰)", async () => {
    let refunds = 0;
    const app = appWith({
      parser: {
        parse: async () => {
          throw new UpstreamError("bad output");
        },
      },
      quotaCheck: async () => ({ ok: true }),
      quotaRefund: async () => {
        refunds++;
      },
    });
    expect((await post(app, { text: "x" })).status).toBe(502);
    expect(refunds).toBe(0); // 착수(LLM 호출) 후 실패 → 소비 유지
  });

  it("parser 미주입(graceful off) → 503 problem+json(code=UnavailableError)", async () => {
    const res = await post(appWith(), { text: "x" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("UnavailableError");
  });

  it("쿼터 초과 → 429 + Retry-After, quota_exceeded 메트릭", async () => {
    const m = createUsageMetrics();
    const app = appWith({
      parser: { parse: async () => [DRAFT] },
      quotaCheck: async () => ({ ok: false, retryAfter: 42 }),
      metrics: m,
    });
    const res = await post(app, { text: "x" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(m.render()).toContain('usage_parse_requests_total{outcome="quota_exceeded"} 1');
  });

  it("파서 busy(parse가 UnavailableError) → 503, 쿼터 환불(작업 미수행 — 리뷰 회귀)", async () => {
    let refunds = 0;
    const app = appWith({
      parser: {
        parse: async () => {
          throw new UnavailableError("parser busy");
        },
      },
      quotaCheck: async () => ({ ok: true }),
      quotaRefund: async () => {
        refunds++;
      },
    });
    const res = await post(app, { text: "x" });
    expect(res.status).toBe(503);
    expect(refunds).toBe(1); // busy는 LLM 미호출 → 소비 환불
  });

  it("환불 실패는 원 503을 가리지 않는다(best-effort — 리뷰 회귀)", async () => {
    const app = appWith({
      parser: {
        parse: async () => {
          throw new UnavailableError("busy");
        },
      },
      quotaCheck: async () => ({ ok: true }),
      quotaRefund: async () => {
        throw new Error("redis down");
      },
    });
    expect((await post(app, { text: "x" })).status).toBe(503); // 환불 실패해도 원 503 유지
  });

  it("422 요청(빈 text)은 quotaCheck를 호출하지 않는다(검증 후 쿼터 — 리뷰 회귀)", async () => {
    let quotaCalls = 0;
    const app = appWith({
      parser: { parse: async () => [DRAFT] },
      quotaCheck: async () => {
        quotaCalls++;
        return { ok: true };
      },
    });
    const res = await post(app, { text: "" }); // 빈 text → 422(validator)
    expect(res.status).toBe(422);
    expect(quotaCalls).toBe(0); // 쿼터 미소모
  });

  it("tripContext 실패는 쿼터 소비 전(quotaCheck 미호출 — 리뷰 회귀)", async () => {
    let quotaCalls = 0;
    const app = appWith({
      parser: { parse: async () => [DRAFT] },
      tripContext: async () => {
        throw new Error("db timeout");
      },
      quotaCheck: async () => {
        quotaCalls++;
        return { ok: true };
      },
    });
    const res = await post(app, { text: "x" });
    expect(res.status).toBe(500); // tripContext 에러(비-AppError) → 500
    expect(quotaCalls).toBe(0); // 쿼터 소비 안 됨(tripContext가 앞)
  });

  it("메트릭 기록 — 성공은 ok·duration, 파서 실패는 error, 미주입은 unavailable", async () => {
    const okM = createUsageMetrics();
    await post(appWith({ parser: { parse: async () => [DRAFT] }, metrics: okM }), { text: "x" });
    expect(okM.render()).toContain('usage_parse_requests_total{outcome="ok"} 1');
    expect(okM.render()).toContain("usage_parse_duration_seconds_count 1");

    const errM = createUsageMetrics();
    await post(
      appWith({
        parser: {
          parse: async () => {
            throw new UpstreamError("x");
          },
        },
        metrics: errM,
      }),
      { text: "x" },
    );
    expect(errM.render()).toContain('usage_parse_requests_total{outcome="error"} 1');

    const naM = createUsageMetrics();
    await post(appWith({ metrics: naM }), { text: "x" });
    expect(naM.render()).toContain('usage_parse_requests_total{outcome="unavailable"} 1');
  });
});

// 이미지(비전) 파싱 라우트 — 바이너리 바디 plain route. 유효 매직바이트 + 최소 크기(≥64) 통과용(80바이트).
const withMagic = (magic: number[]) => {
  const b = new Uint8Array(80); // MIN_IMAGE_BYTES(64) 이상
  b.set(magic);
  return b;
};
const JPEG = withMagic([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = withMagic([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const imageParserWith = (
  fn: (input: UsageImageParseInput, image: UsageImage) => Promise<UsageDraft[]>,
): UsageParserPort => ({ parse: async () => [], parseImage: fn });

function postImage(
  app: ReturnType<typeof appWith>,
  o: {
    contentType?: string;
    body?: Uint8Array;
    disclosure?: string;
    noDisclosure?: boolean;
    refDate?: string;
    idemKey?: string;
  } = {},
) {
  const qs = new URLSearchParams();
  if (!o.noDisclosure) qs.set("disclosure_accepted", o.disclosure ?? "true");
  if (o.refDate !== undefined) qs.set("reference_date", o.refDate);
  const s = qs.toString();
  return app.request(`/trips/${TRIP_ID}/usage-imports/parse-image${s ? `?${s}` : ""}`, {
    method: "POST",
    headers: {
      "content-type": o.contentType ?? "image/jpeg",
      ...(o.idemKey ? { "idempotency-key": o.idemKey } : {}),
    },
    body: o.body ?? JPEG, // 기본은 유효 JPEG 시그니처(매직바이트 검증 통과)
  });
}

describe("usage-imports parse-image 라우트", () => {
  it("200 — parseImage에 이미지 바이트·contentType·기준일 전달, source=image로 저장", async () => {
    let seen: { input: UsageImageParseInput; image: UsageImage } | undefined;
    const saved: { source: string }[] = [];
    const app = appWith({
      parser: imageParserWith(async (input, image) => {
        seen = { input, image };
        return [DRAFT];
      }),
      now: () => new Date("2026-07-06T05:00:00Z"), // KST 2026-07-06
      persistDrafts: async (_t, _m, drafts, source) => {
        saved.push({ source });
        return drafts.map((d, i) => ({
          ...d,
          id: mkId(i),
          source,
          status: "pending" as const,
          confirmed_expense_id: null,
        }));
      },
    });
    const res = await postImage(app, { contentType: "image/png", body: PNG });
    expect(res.status).toBe(200);
    expect(seen?.image.contentType).toBe("image/png");
    expect([...(seen?.image.bytes ?? [])]).toEqual([...PNG]); // 파서에 원바이트 전달
    expect(seen?.input.referenceDate).toBe("2026-07-06"); // KST 기준일
    expect(saved[0]!.source).toBe("image");
  });

  it("Idempotency-Key → image: 네임스페이스로 persistDrafts에 전달(교차 route 충돌 방지, 리뷰 L)", async () => {
    let importKey: string | undefined = "unset";
    const app = appWith({
      parser: imageParserWith(async () => [DRAFT]),
      persistDrafts: async (_t, _m, drafts, source, opts) => {
        importKey = opts?.importKey;
        return drafts.map((d, i) => ({
          ...d,
          id: mkId(i),
          source,
          status: "pending" as const,
          confirmed_expense_id: null,
        }));
      },
    });
    const res = await postImage(app, { idemKey: "imp-xyz" });
    expect(res.status).toBe(200);
    expect(importKey).toBe("image:imp-xyz"); // text:imp-xyz와 구분 → 교차 route replay 방지
  });

  it("선언 타입과 매직바이트 불일치(junk를 image/png로) → 415, 파서·쿼터 미도달(리뷰 K)", async () => {
    let parsed = 0;
    let quota = 0;
    const app = appWith({
      parser: imageParserWith(async () => {
        parsed++;
        return [DRAFT];
      }),
      quotaCheck: async () => {
        quota++;
        return { ok: true };
      },
    });
    // content-type image/png인데 바이트는 PNG 시그니처 아님(80바이트 zeros, 최소크기는 통과) → 415
    const res = await postImage(app, { contentType: "image/png", body: new Uint8Array(80) });
    expect(res.status).toBe(415);
    expect(parsed).toBe(0); // 파서 미호출
    expect(quota).toBe(0); // 쿼터 미소모
  });

  it("잘린(매직만 유효, 최소크기 미만) 페이로드 → 422, 파서 미도달(리뷰 N)", async () => {
    let parsed = 0;
    const app = appWith({
      parser: imageParserWith(async () => {
        parsed++;
        return [DRAFT];
      }),
    });
    // 유효 JPEG 매직(FF D8 FF)이지만 3바이트(< 64) → 422
    const res = await postImage(app, {
      contentType: "image/jpeg",
      body: new Uint8Array([0xff, 0xd8, 0xff]),
    });
    expect(res.status).toBe(422);
    expect(parsed).toBe(0);
  });

  it("허용 외 타입 → 415", async () => {
    const app = appWith({ parser: imageParserWith(async () => [DRAFT]) });
    expect((await postImage(app, { contentType: "image/gif" })).status).toBe(415);
    expect((await postImage(app, { contentType: "application/pdf" })).status).toBe(415);
  });

  it("빈 바디 → 422, 상한 초과 → 422", async () => {
    const app = appWith({ parser: imageParserWith(async () => [DRAFT]), maxImageBytes: 2 });
    expect((await postImage(app, { body: new Uint8Array(0) })).status).toBe(422);
    expect((await postImage(app, { body: new Uint8Array([1, 2, 3]) })).status).toBe(422); // 3 > 2
  });

  it("disclosure_accepted 누락/false → 422", async () => {
    const app = appWith({ parser: imageParserWith(async () => [DRAFT]) });
    expect((await postImage(app, { noDisclosure: true })).status).toBe(422);
    expect((await postImage(app, { disclosure: "false" })).status).toBe(422);
  });

  it("잘못된 reference_date 쿼리 → 422", async () => {
    const app = appWith({ parser: imageParserWith(async () => [DRAFT]) });
    expect((await postImage(app, { refDate: "not-a-date" })).status).toBe(422);
  });

  it("malformed tripId → 422(멤버 DB 조회 전 uuid 검증 — 리뷰 I)", async () => {
    const app = appWith({ parser: imageParserWith(async () => [DRAFT]) });
    const res = await app.request(
      "/trips/not-a-uuid/usage-imports/parse-image?disclosure_accepted=true",
      {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: new Uint8Array([1, 2, 3]),
      },
    );
    expect(res.status).toBe(422);
  });

  it("Content-Length 없는(chunked) 과대 바디 → 스트림 캡으로 422(리뷰 J)", async () => {
    const app = appWith({ parser: imageParserWith(async () => [DRAFT]), maxImageBytes: 2 });
    const big = new Uint8Array(10); // 10 > 2
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(big);
        ctrl.close();
      },
    });
    const res = await app.request(
      `/trips/${TRIP_ID}/usage-imports/parse-image?disclosure_accepted=true`,
      // duplex: 스트림 바디(Content-Length 없음 → chunked) — bodyLimit이 maxSize에서 중단.
      {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: stream,
        duplex: "half",
      } as RequestInit,
    );
    expect(res.status).toBe(422);
  });

  it("parseImage 미지원 파서(텍스트 전용) → 503", async () => {
    const app = appWith({ parser: { parse: async () => [DRAFT] } }); // parseImage 없음
    const res = await postImage(app);
    expect(res.status).toBe(503);
  });

  it("parser 미주입 → 503", async () => {
    expect((await postImage(appWith())).status).toBe(503);
  });

  it("비멤버 → 403", async () => {
    const app = appWith({ parser: imageParserWith(async () => [DRAFT]), member: false });
    expect((await postImage(app)).status).toBe(403);
  });

  it("Content-Length 초과 → 버퍼링 전 422(메모리 방어, 리뷰 G)", async () => {
    let read = 0;
    const app = appWith({
      parser: imageParserWith(async () => {
        read++;
        return [DRAFT];
      }),
      maxImageBytes: 2,
    });
    const res = await app.request(
      `/trips/${TRIP_ID}/usage-imports/parse-image?disclosure_accepted=true`,
      {
        method: "POST",
        headers: { "content-type": "image/jpeg", "content-length": "999999" },
        body: new Uint8Array([1, 2, 3]),
      },
    );
    expect(res.status).toBe(422);
    expect(read).toBe(0); // 파서 도달 전 거부
  });

  it("Idempotency-Key + 과대 Content-Length → idempotency 버퍼링 전 가드가 422(리뷰 H)", async () => {
    // db 접근 시 throw하는 store — 가드가 idempotency(바디 해시) 앞에서 거부하면 db 미접근 → 500 아닌 422.
    const throwingStore = {
      db: new Proxy(
        {},
        {
          get() {
            throw new Error("db touched");
          },
        },
      ),
    } as unknown as IdempotencyStore;
    const app = appWith({
      parser: imageParserWith(async () => [DRAFT]),
      maxImageBytes: 2,
      idempotencyStore: throwingStore,
    });
    const res = await app.request(
      `/trips/${TRIP_ID}/usage-imports/parse-image?disclosure_accepted=true`,
      {
        method: "POST",
        headers: {
          "content-type": "image/jpeg",
          "content-length": "999999",
          "idempotency-key": "k",
        },
        body: new Uint8Array([1, 2, 3]),
      },
    );
    expect(res.status).toBe(422); // 가드가 idempotency 미들웨어(db) 전에 거부
  });

  it("쿼터 초과 → 429(파서 미도달)", async () => {
    let read = 0;
    const app = appWith({
      parser: imageParserWith(async () => {
        read++;
        return [DRAFT];
      }),
      quotaCheck: async () => ({ ok: false, retryAfter: 30 }),
    });
    expect((await postImage(app)).status).toBe(429);
    expect(read).toBe(0);
  });

  it("파서 실패(UpstreamError) → 502", async () => {
    const app = appWith({
      parser: imageParserWith(async () => {
        throw new UpstreamError("vision down");
      }),
    });
    expect((await postImage(app)).status).toBe(502);
  });

  it("이미지 파서 busy(UnavailableError) → 503 + 쿼터 환불", async () => {
    let refunds = 0;
    const app = appWith({
      parser: imageParserWith(async () => {
        throw new UnavailableError("parser busy");
      }),
      quotaCheck: async () => ({ ok: true }),
      quotaRefund: async () => {
        refunds++;
      },
    });
    expect((await postImage(app)).status).toBe(503);
    expect(refunds).toBe(1); // busy는 LLM 미호출 → 환불
  });
});
