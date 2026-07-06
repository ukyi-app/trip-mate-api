import { describe, expect, it } from "vitest";
import { CodexUsageParser } from "./usage-parser.codex.ts";

// opt-in 계약 smoke — CODEX_SMOKE=1일 때만 실 codex exec(구독 인증·~8s/건, CI/일반 로컬 기본 skip).
const SMOKE = process.env.CODEX_SMOKE === "1";

describe.skipIf(!SMOKE)("CodexUsageParser 계약 smoke (opt-in: CODEX_SMOKE=1)", () => {
  it("국내 승인 SMS 1건 → KRW 초안", async () => {
    const parser = new CodexUsageParser();
    const drafts = await parser.parse({
      text: "[KB국민카드] 07/05 12:30 스타벅스강남점 6,500원 일시불 승인",
      referenceDate: "2026-07-06",
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.local_currency).toBe("KRW");
    expect(drafts[0]!.local_amount).toBe("6500");
    expect(drafts[0]!.spent_at.startsWith("2026-07-05")).toBe(true);
  }, 90_000);

  it("승인+승인취소 페어 → 둘 다 제외(빈 배열)", async () => {
    const parser = new CodexUsageParser();
    const drafts = await parser.parse({
      text: [
        "[신한카드] 07/04 18:20 이마트 32,000원 승인",
        "[신한카드] 07/04 18:25 이마트 32,000원 승인취소",
      ].join("\n"),
      referenceDate: "2026-07-06",
    });
    expect(drafts).toHaveLength(0);
  }, 90_000);
});
