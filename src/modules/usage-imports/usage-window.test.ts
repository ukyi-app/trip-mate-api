import { describe, expect, it } from "vitest";
import { clampOutOfWindowConfidence } from "./usage-window.ts";
import type { UsageDraft } from "./usage-imports.schema.ts";

const draft = (spent_at: string, confidence = 0.9): UsageDraft => ({
  title: "가게",
  local_amount: "1000",
  local_currency: "USD",
  spent_at,
  confidence,
});

const NY = { tripTimezone: "America/New_York", tripStart: "2026-08-01", tripEnd: "2026-08-05" };

describe("clampOutOfWindowConfidence (순수) — LLM 출력 결정적 후검증", () => {
  it("여행 기간 내(뉴욕 로컬) → confidence 유지", () => {
    // 2026-08-02T16:00Z = 뉴욕 08/02 정오 → 기간 내
    const out = clampOutOfWindowConfidence([draft("2026-08-02T16:00:00Z")], NY);
    expect(out[0]!.confidence).toBe(0.9);
  });
  it("UTC는 기간 내지만 뉴욕 로컬이 기간 前 → confidence 강하게 하향", () => {
    // 2026-08-01T02:00Z = 뉴욕 07/31 22:00 → 기간(08/01~) 밖
    const out = clampOutOfWindowConfidence([draft("2026-08-01T02:00:00Z", 0.95)], NY);
    expect(out[0]!.confidence).toBeLessThanOrEqual(0.3);
  });
  it("여행 기간 後 → 하향", () => {
    const out = clampOutOfWindowConfidence([draft("2026-08-06T16:00:00Z")], NY);
    expect(out[0]!.confidence).toBeLessThanOrEqual(0.3);
  });
  it("연말연시 여행: 다음 해 01월 기간 내 → 유지, 기간 밖 전년 → 하향", () => {
    const win = { tripTimezone: "Asia/Seoul", tripStart: "2026-12-28", tripEnd: "2027-01-03" };
    const inWin = clampOutOfWindowConfidence([draft("2027-01-02T03:00:00Z")], win);
    expect(inWin[0]!.confidence).toBe(0.9);
    const outWin = clampOutOfWindowConfidence([draft("2026-01-02T03:00:00Z")], win);
    expect(outWin[0]!.confidence).toBeLessThanOrEqual(0.3);
  });
  it("여행 기간 미제공 → 검증 불가, 그대로 반환", () => {
    const out = clampOutOfWindowConfidence([draft("2020-01-01T00:00:00Z")], {});
    expect(out[0]!.confidence).toBe(0.9);
  });
  it("이미 낮은 confidence는 더 낮추지 않되 유지(min)", () => {
    const out = clampOutOfWindowConfidence([draft("2026-08-06T16:00:00Z", 0.1)], NY);
    expect(out[0]!.confidence).toBe(0.1);
  });
  it("tripTimezone 없이 기간만 있으면 KST 기준 판정", () => {
    const win = { tripStart: "2026-08-01", tripEnd: "2026-08-05" };
    // 2026-07-31T16:00Z = KST 08/01 01:00 → 기간 내
    expect(clampOutOfWindowConfidence([draft("2026-07-31T16:00:00Z")], win)[0]!.confidence).toBe(
      0.9,
    );
  });
});
