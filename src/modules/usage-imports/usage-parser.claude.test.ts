import { describe, expect, it } from "vitest";
import { UpstreamError } from "../../core/errors.ts";
import {
  ClaudeUsageParser,
  SYSTEM_PROMPT,
  buildImageUserPrompt,
  buildUserPrompt,
  redactSensitive,
  validateDrafts,
} from "./usage-parser.claude.ts";

const draft = (over: Record<string, unknown> = {}) => ({
  title: "스타벅스",
  local_amount: "6500",
  local_currency: "KRW",
  spent_at: "2026-07-05T12:30:00.000Z",
  confidence: 0.9,
  ...over,
});

describe("redactSensitive (순수)", () => {
  it("마스킹된 카드번호 조각(4-4-4-4, -· ·. 구분)을 제거한다", () => {
    const out = redactSensitive("5424-12**-****-1234 승인");
    expect(out).not.toContain("5424");
    expect(out).not.toContain("1234");
    expect(redactSensitive("5424.12**.****.1234 승인")).not.toContain("5424");
  });
  it("'끝자리 NNNN' 표기를 제거한다", () => {
    expect(redactSensitive("신한카드 끝자리 1234 승인")).not.toContain("1234");
  });
  it("연속 PAN·마스킹 런을 제거한다(fail-closed)", () => {
    expect(redactSensitive("5424121234561234 승인")).not.toContain("5424121234561234");
    expect(redactSensitive("542412******1234 승인")).not.toContain("542412");
  });
  it("카드 끝자리 표기(카드(1234)·*1234)를 제거한다", () => {
    expect(redactSensitive("신한카드(1234)승인 홍*동")).not.toContain("1234");
    expect(redactSensitive("체크카드 ****1234 승인")).not.toContain("1234");
  });
  it("전화번호(모바일·+82·유선)·이메일을 제거한다", () => {
    const out = redactSensitive(
      "문의 010-1234-5678 / +82 10-9876-5432 / 02-1588-1234 help@card.co.kr",
    );
    expect(out).not.toContain("010-1234-5678");
    expect(out).not.toContain("9876");
    expect(out).not.toContain("1588");
    expect(out).not.toContain("help@card.co.kr");
  });
  it("이름 조각(마스킹 홍*동님·비마스킹 홍길동님)을 제거한다", () => {
    const out = redactSensitive("신한카드 승인 홍*동님 07/05 스타벅스 6,500원");
    expect(out).not.toContain("홍*동");
    expect(out).toContain("스타벅스");
    const full = redactSensitive("홍길동님 07/05 GS25 3,200원 승인");
    expect(full).not.toContain("홍길동");
    expect(full).toContain("GS25");
  });
  it("누적/잔액/한도 금액은 제거하고 거래 금액은 보존한다", () => {
    const out = redactSensitive(
      "07/05 12:30 스타벅스 6,500원 승인 누적 1,234,567원 잔액 500,000원",
    );
    expect(out).toContain("6,500원");
    expect(out).not.toContain("1,234,567");
    expect(out).not.toContain("500,000");
  });
  it("상호명·거래 금액·일시는 보존한다", () => {
    const out = redactSensitive("[KB국민] 07/05 12:30 스타벅스 6,500원 승인");
    expect(out).toContain("스타벅스");
    expect(out).toContain("6,500원");
    expect(out).toContain("07/05 12:30");
  });
});

describe("buildUserPrompt (순수)", () => {
  it("referenceDate와 redact된 텍스트를 포함한다", () => {
    const p = buildUserPrompt({
      text: "신한카드 010-1111-2222 스타벅스 6,500원 승인",
      referenceDate: "2026-07-06",
    });
    expect(p).toContain("2026-07-06");
    expect(p).toContain("스타벅스");
    expect(p).not.toContain("010-1111-2222");
  });
  it("여행 기간·timezone이 주어지면 프롬프트에 포함한다", () => {
    const p = buildUserPrompt({
      text: "08/02 델리 승인",
      referenceDate: "2026-08-01",
      tripTimezone: "America/New_York",
      tripStart: "2026-08-01",
      tripEnd: "2026-08-05",
    });
    expect(p).toContain("여행 기간");
    expect(p).toContain("2026-08-01");
    expect(p).toContain("2026-08-05");
    expect(p).toContain("America/New_York");
  });
  it("여행 기간이 없으면 여행 기간 줄을 넣지 않는다", () => {
    const p = buildUserPrompt({ text: "x", referenceDate: "2026-07-06" });
    expect(p).not.toContain("여행 기간");
  });
});

describe("buildImageUserPrompt (순수)", () => {
  it("기준일·이미지 지시 포함, 여행 기간 있으면 포함(텍스트 원문 없음)", () => {
    const p = buildImageUserPrompt({
      referenceDate: "2026-08-01",
      tripTimezone: "America/New_York",
      tripStart: "2026-08-01",
      tripEnd: "2026-08-05",
    });
    expect(p).toContain("이미지");
    expect(p).toContain("2026-08-01");
    expect(p).toContain("America/New_York");
    expect(p).not.toContain("사용내역 원문");
  });
});

describe("ClaudeUsageParser.parseImage (타입 가드)", () => {
  it("claude 비전 미지원 타입(heic)은 SDK 호출 전 UpstreamError", async () => {
    const parser = new ClaudeUsageParser("test-key"); // 실 네트워크 미도달(가드가 먼저)
    await expect(
      parser.parseImage(
        { referenceDate: "2026-07-06" },
        { bytes: new Uint8Array([1]), contentType: "image/heic" },
      ),
    ).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("validateDrafts (순수)", () => {
  it("정상 drafts 페이로드를 통과시킨다", () => {
    const out = validateDrafts({
      drafts: [draft(), draft({ title: "GS25", local_amount: "3200" })],
    });
    expect(out).toHaveLength(2);
    expect(out[0]!.local_amount).toBe("6500");
  });
  it("해외승인 초안의 card_billed_amount·card_billed_currency 쌍을 보존한다", () => {
    const out = validateDrafts({
      drafts: [
        draft({
          local_amount: "1234",
          local_currency: "USD",
          card_billed_amount: "17300",
          card_billed_currency: "KRW",
        }),
      ],
    });
    expect(out[0]!.card_billed_amount).toBe("17300");
    expect(out[0]!.card_billed_currency).toBe("KRW");
  });
  it("card_billed_amount만 있고 currency가 없으면 UpstreamError(쌍 강제)", () => {
    expect(() => validateDrafts({ drafts: [draft({ card_billed_amount: "17300" })] })).toThrow(
      UpstreamError,
    );
  });
  it("drafts가 배열이 아니거나 루트가 객체가 아니면 UpstreamError", () => {
    expect(() => validateDrafts({ drafts: "x" })).toThrow(UpstreamError);
    expect(() => validateDrafts(null)).toThrow(UpstreamError);
  });
  it("minorString 위반(소수점 금액) → UpstreamError", () => {
    expect(() => validateDrafts({ drafts: [draft({ local_amount: "65.00" })] })).toThrow(
      UpstreamError,
    );
  });
  it("confidence 범위 밖 → UpstreamError", () => {
    expect(() => validateDrafts({ drafts: [draft({ confidence: 1.5 })] })).toThrow(UpstreamError);
  });
  it("50건 초과 → UpstreamError", () => {
    const many = Array.from({ length: 51 }, () => draft());
    expect(() => validateDrafts({ drafts: many })).toThrow(UpstreamError);
  });
});

describe("SYSTEM_PROMPT 계약 앵커", () => {
  it("승인취소 페어링 제외·연도 추론 confidence 하향·minor unit·여행 기간·timezone 규칙을 명시한다", () => {
    expect(SYSTEM_PROMPT).toContain("취소");
    expect(SYSTEM_PROMPT).toContain("confidence");
    expect(SYSTEM_PROMPT).toContain("37900");
    expect(SYSTEM_PROMPT).toContain("여행 기간");
    // spent_at 변환이 KST 하드코딩이 아니라 여행 timezone 기준(서쪽 timezone 하루 밀림 방지)
    expect(SYSTEM_PROMPT).toContain("여행 timezone");
    // 여행 기간 우선(미래 금지 규칙과의 충돌 해소 — 연말연시·중반 날짜)
    expect(SYSTEM_PROMPT).toContain("우선순위");
  });
});
