import { describe, expect, it } from "vitest";
import { UnavailableError, UpstreamError, registerErrorFilter } from "../../core/errors.ts";
import type { MembershipLookup, SessionResolver } from "../../core/guards.ts";
import { createApp } from "../../core/openapi.ts";
import { createUsageMetrics } from "../../core/metrics.ts";
import { registerUsageImportRoutes } from "./usage-imports.controller.ts";
import type { UsageParseInput, UsageParserPort } from "./usage-parser.port.ts";

// zod v4 uuid()는 RFC 버전 비트까지 검증 — all-zeros류는 422가 나므로 실제 v4 형태 사용
const TRIP_ID = "a3bb189e-8bf9-4c8b-9f36-6c5c8b2a1b90";

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
    ...(opts.parser ? { parser: opts.parser } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.tripContext ? { tripContext: opts.tripContext } : {}),
    ...(opts.metrics ? { metrics: opts.metrics } : {}),
    ...(opts.quotaCheck ? { quotaCheck: opts.quotaCheck } : {}),
    ...(opts.quotaRefund ? { quotaRefund: opts.quotaRefund } : {}),
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
  it("200 — 초안 배열 반환, 포트에 text·referenceDate(요청값) 전달", async () => {
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
    expect(await res.json()).toEqual({ drafts: [DRAFT] });
    expect(calls).toEqual([{ text: "07/05 스타벅스 6,500원", referenceDate: "2026-07-06" }]);
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
