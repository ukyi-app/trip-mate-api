import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { splitExpense, minTransfers, computeSettlement, type ExpenseInput } from "./compute.ts";
import { minor, money, type ExpenseId, type MemberId } from "../../../core/money.ts";

const exp = (
  o: Partial<ExpenseInput> &
    Pick<ExpenseInput, "id" | "paid_by" | "participants" | "local" | "settlement">,
): ExpenseInput => o as ExpenseInput;

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

describe("minTransfers", () => {
  it("단순: a +100, b -100 → b→a 100", () => {
    const net = new Map<MemberId, bigint>([
      [M("a"), 100n],
      [M("b"), -100n],
    ]);
    const t = minTransfers(net as Map<MemberId, never>, "KRW" as never);
    expect(t).toEqual([{ from: M("b"), to: M("a"), amount: 100n, currency: "KRW" }]);
  });
  it("순환채무 정리 후 transfers ≤ n-1, from≠to, amount>0, round-trip", () => {
    const net = new Map<MemberId, bigint>([
      [M("a"), 50n],
      [M("b"), 30n],
      [M("c"), -80n],
    ]);
    const t = minTransfers(net as Map<MemberId, never>, "KRW" as never);
    expect(t.length).toBeLessThanOrEqual(2);
    for (const x of t) {
      expect(x.from).not.toBe(x.to);
      expect(x.amount > 0n).toBe(true);
    }
    const acc = new Map(net);
    for (const x of t) {
      acc.set(x.to, acc.get(x.to)! - x.amount);
      acc.set(x.from, acc.get(x.from)! + x.amount);
    }
    expect([...acc.values()].every((v) => v === 0n)).toBe(true);
  });
});

describe("computeSettlement (환불 없음)", () => {
  it("3인 균등: a가 9000 KRW 결제, 셋이 분담 → a +6000, b/c -3000", () => {
    const r = computeSettlement({
      members: [M("a"), M("b"), M("c")],
      expenses: [
        exp({
          id: "e1" as ExpenseId,
          paid_by: M("a"),
          participants: [M("a"), M("b"), M("c")],
          local: money(9000n, "KRW"),
          settlement: money(9000n, "KRW"),
        }),
      ],
    });
    const byMember = Object.fromEntries(r.settlement.summaries.map((s) => [s.member, s.net]));
    expect(byMember[M("a")]).toBe(6000n);
    expect(byMember[M("b")]).toBe(-3000n);
    expect(byMember[M("c")]).toBe(-3000n);
    expect(r.settlement.summaries.reduce((a, s) => a + s.net, 0n)).toBe(0n);
    expect(r.settlement.total).toBe(9000n);
  });

  it("결제자가 참여자가 아님(대납): paid_by=a, participants=[b,c]", () => {
    const r = computeSettlement({
      members: [M("a"), M("b"), M("c")],
      expenses: [
        exp({
          id: "e1" as ExpenseId,
          paid_by: M("a"),
          participants: [M("b"), M("c")],
          local: money(1000n, "KRW"),
          settlement: money(1000n, "KRW"),
        }),
      ],
    });
    const by = Object.fromEntries(r.settlement.summaries.map((s) => [s.member, s.net]));
    expect(by[M("a")]).toBe(1000n);
    expect(by[M("b")]).toBe(-500n);
    expect(by[M("c")]).toBe(-500n);
  });

  it("local 다통화 독립 서브축", () => {
    const r = computeSettlement({
      members: [M("a"), M("b")],
      expenses: [
        exp({
          id: "e1" as ExpenseId,
          paid_by: M("a"),
          participants: [M("a"), M("b")],
          local: money(1000n, "JPY"),
          settlement: money(9320n, "KRW"),
        }),
        exp({
          id: "e2" as ExpenseId,
          paid_by: M("b"),
          participants: [M("a"), M("b")],
          local: money(100n, "THB"),
          settlement: money(3790n, "KRW"),
        }),
      ],
    });
    expect(Object.keys(r.local).sort()).toEqual(["JPY", "THB"]);
    expect(r.local["JPY"]!.total).toBe(1000n);
    expect(r.local["THB"]!.total).toBe(100n);
  });

  it("property: 임의 입력에서 Σnet==0 (settlement 축)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            amount: fc.bigInt({ min: 1n, max: 1_000_000n }),
            payer: fc.integer({ min: 0, max: 4 }),
            parts: fc.uniqueArray(fc.integer({ min: 0, max: 4 }), { minLength: 1, maxLength: 5 }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        (rows) => {
          const members = [M("m0"), M("m1"), M("m2"), M("m3"), M("m4")];
          const expenses = rows.map((row, k) =>
            exp({
              id: `e${k}` as ExpenseId,
              paid_by: members[row.payer]!,
              participants: row.parts.map((p) => members[p]!),
              local: money(row.amount, "KRW"),
              settlement: money(row.amount, "KRW"),
            }),
          );
          const r = computeSettlement({ members, expenses });
          return r.settlement.summaries.reduce((a, x) => a + x.net, 0n) === 0n;
        },
      ),
    );
  });

  it("property: 결정성 — 입력 순서를 셔플해도 동일 transfers", () => {
    const members = [M("a"), M("b"), M("c"), M("d")];
    const base: ExpenseInput[] = [
      exp({
        id: "e1" as ExpenseId,
        paid_by: M("a"),
        participants: [M("a"), M("b"), M("c")],
        local: money(1000n, "KRW"),
        settlement: money(1000n, "KRW"),
      }),
      exp({
        id: "e2" as ExpenseId,
        paid_by: M("b"),
        participants: [M("b"), M("c"), M("d")],
        local: money(2000n, "KRW"),
        settlement: money(2000n, "KRW"),
      }),
      exp({
        id: "e3" as ExpenseId,
        paid_by: M("d"),
        participants: members,
        local: money(700n, "KRW"),
        settlement: money(700n, "KRW"),
      }),
    ];
    const r1 = computeSettlement({ members, expenses: base });
    const r2 = computeSettlement({ members, expenses: [...base].reverse() });
    expect(r1.settlement.transfers).toEqual(r2.settlement.transfers);
  });
});
