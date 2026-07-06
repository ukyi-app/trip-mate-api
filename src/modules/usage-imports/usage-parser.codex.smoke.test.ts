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

  it("서쪽 여행 timezone(America/New_York) + date-only → 트립-로컬 날짜 하루 안 밀림", async () => {
    const parser = new CodexUsageParser();
    const drafts = await parser.parse({
      text: "[신한카드] 08/02 DELI NEW YORK USD 12.00 승인",
      referenceDate: "2026-08-02",
      tripTimezone: "America/New_York",
      tripStart: "2026-08-01",
      tripEnd: "2026-08-05",
    });
    expect(drafts).toHaveLength(1);
    // spent_at을 뉴욕 로컬로 환산했을 때 날짜가 08/02여야 함(03:00Z=전날 밤 뉴욕 → 실패)
    const nyDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(
      new Date(drafts[0]!.spent_at),
    );
    expect(nyDate).toBe("2026-08-02");
  }, 90_000);

  it("연말연시 여행 + 기준일보다 미래인 01월 날짜 → 여행 연도 안으로(전년 아님)", async () => {
    const parser = new CodexUsageParser();
    const drafts = await parser.parse({
      text: "[KB국민카드] 01/02 12:00 스타벅스 5,000원 승인",
      referenceDate: "2026-12-30",
      tripTimezone: "Asia/Seoul",
      tripStart: "2026-12-28",
      tripEnd: "2027-01-03",
    });
    expect(drafts).toHaveLength(1);
    // 01/02는 기준일(12/30)보다 미래지만 여행 기간 안 → 2027-01-02여야 함(2026-01/2025 아님)
    expect(drafts[0]!.spent_at.startsWith("2027-01-02")).toBe(true);
  }, 90_000);
});
