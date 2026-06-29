import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { roundHalfAwayFromZero, convert, crossRate, parsePositiveRate } from "./convert.ts";
import { minor } from "../../../core/money.ts";
import { ValidationError } from "../../../core/errors.ts";

describe("roundHalfAwayFromZero", () => {
  it("0.5는 0에서 멀어지게 (양수)", () => {
    expect(roundHalfAwayFromZero(new Decimal("2.5"))).toBe(3n);
    expect(roundHalfAwayFromZero(new Decimal("2.4"))).toBe(2n);
  });
  it("음수 대칭 (환불)", () => {
    expect(roundHalfAwayFromZero(new Decimal("-2.5"))).toBe(-3n);
    expect(roundHalfAwayFromZero(new Decimal("-2.4"))).toBe(-2n);
  });
});

describe("convert (PRD §13.3)", () => {
  it("1,000 THB · rate 37.9 · THB exp2 · KRW exp0 → 37,900 KRW", () => {
    // local_minor = 1000 THB in minor(0.01) = 100000
    const r = convert({
      localMinor: minor(100000n),
      rate: new Decimal("37.9"),
      localExp: 2,
      settleExp: 0,
    });
    expect(r).toBe(37900n);
  });
  it("음수(환불) 대칭", () => {
    const r = convert({
      localMinor: minor(-100000n),
      rate: new Decimal("37.9"),
      localExp: 2,
      settleExp: 0,
    });
    expect(r).toBe(-37900n);
  });
});

describe("crossRate", () => {
  it("usd[quote]/usd[base] 고정밀 (저→고가 VND→GBP)", () => {
    const usd = { USD: new Decimal(1), VND: new Decimal("26000"), GBP: new Decimal("0.79") };
    const rate = crossRate(usd, "VND", "GBP"); // 1 VND = 0.79/26000 GBP
    expect(rate.toDecimalPlaces(10).toFixed(10)).toBe("0.0000303846");
  });
});

describe("parsePositiveRate (finding #2)", () => {
  it("유효 → Decimal", () => {
    expect(parsePositiveRate("37.9").toString()).toBe("37.9");
  });
  it("0·음수·garbage → ValidationError", () => {
    expect(() => parsePositiveRate("0")).toThrow(ValidationError);
    expect(() => parsePositiveRate("-1")).toThrow(ValidationError);
    expect(() => parsePositiveRate("abc")).toThrow(ValidationError);
  });
  it("10dp 반올림 후 0(tiny) → ValidationError (finding #1 pass2)", () => {
    expect(() => parsePositiveRate("0.00000000001")).toThrow(ValidationError); // 1e-11 → 0.0000000000
  });
  it("numeric(20,10) 범위 초과(huge) → ValidationError", () => {
    expect(() => parsePositiveRate("10000000000")).toThrow(ValidationError); // 10^10
  });
});
