import { describe, it, expect } from "vitest";
import {
  expenseResponseSchema,
  createExpenseSchema,
  updateExpenseSchema,
  previewResponseSchema,
} from "./expenses.schema.ts";

const validCreate = () => ({
  title: "스시",
  local_amount: "37900",
  local_currency: "JPY",
  spent_at: "2026-08-02T12:30:00.000Z",
  paid_by_member_id: "11111111-1111-4111-8111-111111111111",
  participant_member_ids: ["11111111-1111-4111-8111-111111111111"],
  payment_method: "card",
  category: "food",
});

describe("expenses DTO", () => {
  it("응답에 version 포함·돈은 string", () => {
    expect("version" in expenseResponseSchema.shape).toBe(true);
    expect(expenseResponseSchema.shape.settlement_amount.safeParse("37900").success).toBe(true);
    expect(expenseResponseSchema.shape.settlement_amount.safeParse(37900).success).toBe(false); // number 거부
  });
  it("create 검증: 정상·빈 참여자·음수 금액·미지 payment_method·중복·길이/범위", () => {
    expect(createExpenseSchema.safeParse(validCreate()).success).toBe(true);
    expect(
      createExpenseSchema.safeParse({ ...validCreate(), participant_member_ids: [] }).success,
    ).toBe(false);
    expect(createExpenseSchema.safeParse({ ...validCreate(), local_amount: "-1" }).success).toBe(
      false,
    );
    expect(
      createExpenseSchema.safeParse({ ...validCreate(), payment_method: "crypto" }).success,
    ).toBe(false);
    const dup = "11111111-1111-4111-8111-111111111111";
    expect(
      createExpenseSchema.safeParse({ ...validCreate(), participant_member_ids: [dup, dup] })
        .success,
    ).toBe(false); // 중복 participant(finding #3 pass2)
    expect(
      createExpenseSchema.safeParse({ ...validCreate(), local_amount: "1".repeat(20) }).success,
    ).toBe(false); // 길이 초과(finding #2 pass3)
    expect(
      createExpenseSchema.safeParse({ ...validCreate(), local_amount: "9999999999999999999" })
        .success,
    ).toBe(false); // BIGINT 범위 초과
  });
  it("card_billed: card_billed_settlement_amount 허용·manualRate와 상호배타", () => {
    expect(
      createExpenseSchema.safeParse({ ...validCreate(), card_billed_settlement_amount: "350000" })
        .success,
    ).toBe(true);
    expect(
      createExpenseSchema.safeParse({
        ...validCreate(),
        card_billed_settlement_amount: "350000",
        manualRate: "9",
      }).success,
    ).toBe(false); // 상호배타
  });
  it("update: version 필수 + FX 영향 필드(local_amount·currency·spent_at) 허용", () => {
    expect(updateExpenseSchema.safeParse({ version: 0, title: "수정" }).success).toBe(true);
    expect(updateExpenseSchema.safeParse({ title: "수정" }).success).toBe(false); // version 누락
    expect(updateExpenseSchema.safeParse({ version: 0, local_amount: "50000" }).success).toBe(true); // 편집재계산
    expect(
      updateExpenseSchema.safeParse({
        version: 0,
        local_currency: "USD",
        spent_at: "2026-08-03T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      updateExpenseSchema.safeParse({
        version: 0,
        card_billed_settlement_amount: "1",
        manualRate: "9",
      }).success,
    ).toBe(false); // 상호배타
  });
  it("preview 응답: 해결 변형 + needs_manual 변형(settlement_amount·source null) 둘 다 허용", () => {
    expect(
      previewResponseSchema.safeParse({
        needs_manual: false,
        settlement_amount: "0",
        settlement_currency: "KRW",
        exchange_rate: null,
        exchange_rate_source: null,
        settlement_amount_source: "converted",
        fallbackWarning: false,
        per_member: [],
      }).success,
    ).toBe(true);
    expect(
      previewResponseSchema.safeParse({
        needs_manual: true,
        settlement_amount: null,
        settlement_currency: "KRW",
        exchange_rate: null,
        exchange_rate_source: null,
        settlement_amount_source: null,
        fallbackWarning: false,
        per_member: [],
      }).success,
    ).toBe(true);
  });
});
