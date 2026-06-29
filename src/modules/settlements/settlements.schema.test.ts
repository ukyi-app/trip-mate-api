import { describe, it, expect } from "vitest";
import { settlementResponseSchema, finalizeRequestSchema } from "./settlements.schema.ts";

describe("settlements DTO", () => {
  it("응답: 돈 string·version nullable·seen_versions·transfers", () => {
    const ok = settlementResponseSchema.safeParse({
      trip_id: "11111111-1111-4111-8111-111111111111",
      settlement_status: "open",
      version: null,
      settlement_total: "0",
      seen_versions: [{ expense_id: "11111111-1111-4111-8111-111111111111", version: 0 }],
      transfers: [],
      summaries: [],
      currency_totals: [],
    });
    expect(ok.success).toBe(true);
  });
  it("finalize 요청: seen_expense_versions 필수", () => {
    expect(
      finalizeRequestSchema.safeParse({
        seen_expense_versions: [{ expense_id: "11111111-1111-4111-8111-111111111111", version: 1 }],
      }).success,
    ).toBe(true);
    expect(finalizeRequestSchema.safeParse({}).success).toBe(false);
  });
});
