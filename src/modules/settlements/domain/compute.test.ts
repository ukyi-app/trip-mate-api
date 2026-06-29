import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { splitExpense } from "./compute.ts";
import { minor, type MemberId } from "../../../core/money.ts";

const M = (s: string) => s as MemberId;
const sum = (m: Map<MemberId, bigint>) => [...m.values()].reduce((a, b) => a + b, 0n);

describe("splitExpense", () => {
  it("나눠떨어짐: 9000/3 = 3000씩", () => {
    const r = splitExpense(minor(9000n), [M("a"), M("b"), M("c")]);
    expect([...r.values()]).toEqual([3000n, 3000n, 3000n]);
  });
  it("안나눠짐: 10000/3 → 잔여 1을 member_id asc 첫 1명에", () => {
    const r = splitExpense(minor(10000n), [M("c"), M("a"), M("b")]);
    expect(r.get(M("a"))).toBe(3334n);
    expect(r.get(M("b"))).toBe(3333n);
    expect(r.get(M("c"))).toBe(3333n);
  });
  it("음수(환불) -10000/3 → -3333/-3333/-3334", () => {
    const r = splitExpense(minor(-10000n), [M("a"), M("b"), M("c")]);
    expect(r.get(M("a"))).toBe(-3333n);
    expect(r.get(M("b"))).toBe(-3333n);
    expect(r.get(M("c"))).toBe(-3334n);
  });
  it("n=1: 전액", () => {
    expect(splitExpense(minor(777n), [M("a")]).get(M("a"))).toBe(777n);
  });
  it("참여자 0명은 에러", () => {
    expect(() => splitExpense(minor(100n), [])).toThrow();
  });
  it("property: Σ분배 == amount (양·음수)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -10_000_000n, max: 10_000_000n }),
        fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 8 }),
        (amount, ids) => {
          const r = splitExpense(minor(amount), ids.map(M));
          return sum(r) === amount;
        },
      ),
    );
  });
});
