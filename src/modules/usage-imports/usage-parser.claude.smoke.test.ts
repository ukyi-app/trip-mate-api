import { describe, expect, it } from "vitest";
import { ClaudeUsageParser } from "./usage-parser.claude.ts";

// opt-in 계약 smoke — ANTHROPIC_API_KEY 있을 때만 실 LLM 호출(비용 발생, CI/로컬 기본 skip).
const KEY = process.env.ANTHROPIC_API_KEY;

describe.skipIf(!KEY)("ClaudeUsageParser 계약 smoke (opt-in)", () => {
  it("국내 승인 SMS 1건 → KRW 초안", async () => {
    const parser = new ClaudeUsageParser(KEY!);
    const drafts = await parser.parse({
      text: "[KB국민카드] 07/05 12:30 스타벅스강남점 6,500원 일시불 승인",
      referenceDate: "2026-07-06",
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.local_currency).toBe("KRW");
    expect(drafts[0]!.local_amount).toBe("6500");
    expect(drafts[0]!.spent_at.startsWith("2026-07-05")).toBe(true);
  }, 60_000);

  it("승인+승인취소 페어 → 둘 다 제외(빈 배열)", async () => {
    const parser = new ClaudeUsageParser(KEY!);
    const drafts = await parser.parse({
      text: [
        "[신한카드] 07/04 18:20 이마트 32,000원 승인",
        "[신한카드] 07/04 18:25 이마트 32,000원 승인취소",
      ].join("\n"),
      referenceDate: "2026-07-06",
    });
    expect(drafts).toHaveLength(0);
  }, 60_000);

  it("해외승인(현지+원화 병기) → card_billed_amount/currency 쌍 보존", async () => {
    const parser = new ClaudeUsageParser(KEY!);
    const drafts = await parser.parse({
      text: "[현대카드] 07/03 09:10 해외승인 STARBUCKS TOKYO JPY 1,200 (17,300원)",
      referenceDate: "2026-07-06",
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.local_currency).toBe("JPY");
    expect(drafts[0]!.local_amount).toBe("1200");
    expect(drafts[0]!.card_billed_amount).toBe("17300");
    expect(drafts[0]!.card_billed_currency).toBe("KRW");
  }, 60_000);
});
