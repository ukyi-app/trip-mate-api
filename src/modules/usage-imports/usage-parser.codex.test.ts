import { describe, expect, it } from "vitest";
import { UnavailableError, UpstreamError } from "../../core/errors.ts";
import {
  CODEX_OUTPUT_SCHEMA,
  CodexUsageParser,
  buildCodexEnv,
  buildCodexPrompt,
  normalizeDrafts,
} from "./usage-parser.codex.ts";

describe("buildCodexPrompt (순수)", () => {
  it("도구 금지 문구·기준일·redact된 텍스트를 포함한다", () => {
    const p = buildCodexPrompt({
      text: "신한카드 010-1111-2222 스타벅스 6,500원 승인",
      referenceDate: "2026-07-06",
    });
    expect(p).toContain("도구");
    expect(p).toContain("2026-07-06");
    expect(p).toContain("스타벅스");
    expect(p).not.toContain("010-1111-2222");
  });
});

describe("CODEX_OUTPUT_SCHEMA (OpenAI strict 계약 앵커)", () => {
  const item = CODEX_OUTPUT_SCHEMA.properties.drafts.items;
  it("draft 아이템의 모든 프로퍼티가 required에 있다(strict 요구)", () => {
    expect([...item.required].sort()).toEqual(Object.keys(item.properties).sort());
  });
  it("선택 필드는 null 유니온이다", () => {
    expect(item.properties.category.type).toContain("null");
    expect(item.properties.card_billed_amount.type).toContain("null");
  });
});

describe("buildCodexEnv (순수) — 앱 시크릿 env 비상속(critical 리뷰 반영)", () => {
  it("allowlist(PATH·HOME·CODEX_HOME 등)만 통과시키고 앱 시크릿은 제외한다", () => {
    const env = buildCodexEnv({
      PATH: "/usr/bin",
      HOME: "/home/app",
      CODEX_HOME: "/codex",
      TRIP_MATE_DATABASE_URL: "postgres://secret",
      BETTER_AUTH_SECRET: "s3cret",
      ANTHROPIC_API_KEY: "sk-x",
      RESEND_API_KEY: "re-x",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/app", CODEX_HOME: "/codex" });
  });
  it("미설정 allowlist 키는 만들지 않는다", () => {
    expect(buildCodexEnv({ PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" });
  });
});

describe("normalizeDrafts (순수)", () => {
  it("null 값 키를 제거해 zod optional과 정합시킨다", () => {
    const out = normalizeDrafts({
      drafts: [{ title: "스타벅스", category: null, card_billed_amount: null }],
    });
    expect(out).toEqual({ drafts: [{ title: "스타벅스" }] });
  });
  it("drafts 형태가 아니면 그대로 반환(검증은 validateDrafts 몫)", () => {
    expect(normalizeDrafts(null)).toBe(null);
    expect(normalizeDrafts({ drafts: "x" })).toEqual({ drafts: "x" });
  });
});

describe("CodexUsageParser (fake run 주입)", () => {
  const DRAFT_JSON = JSON.stringify({
    drafts: [
      {
        title: "스타벅스",
        local_amount: "6500",
        local_currency: "KRW",
        spent_at: "2026-07-05T03:30:00Z",
        category: null,
        payment_method: "card",
        card_billed_amount: null,
        card_billed_currency: null,
        confidence: 0.9,
      },
    ],
  });

  it("run 출력 JSON을 정규화·검증해 초안 반환, 프롬프트에 redact 텍스트 전달", async () => {
    const prompts: string[] = [];
    const parser = new CodexUsageParser({
      run: async ({ prompt }) => {
        prompts.push(prompt);
        return DRAFT_JSON;
      },
    });
    const drafts = await parser.parse({
      text: "07/05 스타벅스 6,500원 승인",
      referenceDate: "2026-07-06",
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.title).toBe("스타벅스");
    expect(drafts[0]!.category).toBeUndefined();
    expect(prompts[0]).toContain("스타벅스");
    expect(prompts[0]).toContain("2026-07-06");
  });

  it("run 실패 → UpstreamError로 정규화", async () => {
    const parser = new CodexUsageParser({
      run: async () => {
        throw new Error("codex died");
      },
    });
    await expect(parser.parse({ text: "x", referenceDate: "2026-07-06" })).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  it("비정형 출력(JSON 아님) → UpstreamError", async () => {
    const parser = new CodexUsageParser({ run: async () => "not json" });
    await expect(parser.parse({ text: "x", referenceDate: "2026-07-06" })).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  it("동시 실행 상한(2) 초과 → 대기 없이 UnavailableError(파드 고갈 방지)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const parser = new CodexUsageParser({
      run: async () => {
        await gate;
        return DRAFT_JSON;
      },
    });
    const input = { text: "x", referenceDate: "2026-07-06" };
    const p1 = parser.parse(input);
    const p2 = parser.parse(input);
    await expect(parser.parse(input)).rejects.toBeInstanceOf(UnavailableError);
    release();
    await expect(Promise.all([p1, p2])).resolves.toHaveLength(2);
    // 슬롯 반환 후에는 다시 실행 가능
    await expect(parser.parse(input)).resolves.toHaveLength(1);
  });
});
