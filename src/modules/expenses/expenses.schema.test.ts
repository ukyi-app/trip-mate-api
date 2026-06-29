import { describe, it, expect } from "vitest";
import {
  expenseResponseSchema,
  createExpenseSchema,
  updateExpenseSchema,
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
  it("update는 version 필수·메타만(amount/currency 없음, FX 불변)", () => {
    expect(updateExpenseSchema.safeParse({ version: 0, title: "수정" }).success).toBe(true);
    expect(updateExpenseSchema.safeParse({ title: "수정" }).success).toBe(false); // version 누락
    expect("local_amount" in updateExpenseSchema.shape).toBe(false);
    expect("local_currency" in updateExpenseSchema.shape).toBe(false);
  });
});
