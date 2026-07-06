import { describe, expect, it } from "vitest";
import { UpstreamError, registerErrorFilter } from "../../core/errors.ts";
import type { MembershipLookup, SessionResolver } from "../../core/guards.ts";
import { createApp } from "../../core/openapi.ts";
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

  it("parser 미주입(graceful off) → 503 problem+json(code=UnavailableError)", async () => {
    const res = await post(appWith(), { text: "x" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("UnavailableError");
  });
});
