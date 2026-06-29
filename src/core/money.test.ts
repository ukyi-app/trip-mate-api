import { describe, it, expect } from "vitest";
import { add, money, type CurrencyCode } from "./money.ts";
import { SettlementInvariantError } from "./errors.ts";

describe("Money VO", () => {
  it("같은 통화는 합산된다", () => {
    const a = money(100n, "KRW");
    const b = money(250n, "KRW");
    expect(add(a, b).amount).toBe(350n);
    expect(add(a, b).currency).toBe("KRW" as CurrencyCode);
  });
  it("다른 통화 합산은 SettlementInvariantError", () => {
    expect(() => add(money(100n, "KRW"), money(1n, "USD"))).toThrow(SettlementInvariantError);
  });
});
