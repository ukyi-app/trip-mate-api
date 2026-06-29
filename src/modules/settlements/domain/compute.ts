import {
  type CurrencyCode,
  type ExpenseId,
  type MemberId,
  type Minor,
  type Money,
} from "../../../core/money.ts";
import { SettlementInvariantError } from "../../../core/errors.ts";

export const byIdAsc = (a: MemberId, b: MemberId): number => (a < b ? -1 : a > b ? 1 : 0);

/** b > 0 가정. BigInt '/'는 0방향 절삭 → -∞ floor로 보정. */
export function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  const r = a % b;
  return r !== 0n && r < 0n ? q - 1n : q;
}

export function splitExpense(amount: Minor, members: readonly MemberId[]): Map<MemberId, Minor> {
  if (members.length === 0) throw new SettlementInvariantError("expense has no participants");
  const n = BigInt(members.length);
  const base = floorDiv(amount, n);
  const remainder = amount - base * n; // 0 <= remainder < n (음수에도 성립)
  const sorted = [...members].sort(byIdAsc);
  const out = new Map<MemberId, Minor>();
  sorted.forEach((m, i) => out.set(m, (base + (BigInt(i) < remainder ? 1n : 0n)) as Minor));
  let s = 0n;
  for (const v of out.values()) s += v;
  if (s !== amount) throw new SettlementInvariantError("split sum != amount");
  return out;
}

export interface Transfer {
  from: MemberId;
  to: MemberId;
  amount: Minor;
  currency: CurrencyCode;
}

/** greedy 최소 송금: 금액 desc·동률 id asc 정렬, ≤(n-1)건, 결정적 (PRD §18.4). */
export function minTransfers(net: Map<MemberId, Minor>, currency: CurrencyCode): Transfer[] {
  const cred = [...net.entries()]
    .filter(([, v]) => v > 0n)
    .map(([id, v]) => ({ id, amt: v as bigint }))
    .sort((a, b) => (b.amt !== a.amt ? (b.amt > a.amt ? 1 : -1) : byIdAsc(a.id, b.id)));
  const debt = [...net.entries()]
    .filter(([, v]) => v < 0n)
    .map(([id, v]) => ({ id, amt: -v as bigint }))
    .sort((a, b) => (b.amt !== a.amt ? (b.amt > a.amt ? 1 : -1) : byIdAsc(a.id, b.id)));
  const out: Transfer[] = [];
  let i = 0;
  let j = 0;
  while (i < cred.length && j < debt.length) {
    const c = cred[i]!;
    const d = debt[j]!;
    const give = c.amt < d.amt ? c.amt : d.amt;
    out.push({ from: d.id, to: c.id, amount: give as Minor, currency });
    c.amt -= give;
    d.amt -= give;
    if (c.amt === 0n) i++;
    if (d.amt === 0n) j++;
  }
  return out;
}

export interface ExpenseInput {
  id: ExpenseId;
  paid_by: MemberId;
  participants: MemberId[]; // ≥1 (검증됨)
  local: Money;
  settlement: Money; // settlement.currency = trip 정산통화(단일)
  refund_of?: ExpenseId;
}
export interface Summary {
  member: MemberId;
  total_paid: Minor;
  total_share: Minor;
  net: Minor;
}
export interface AxisResult {
  transfers: Transfer[];
  summaries: Summary[];
  total: Minor;
}
export interface SettlementResult {
  settlement: AxisResult;
  local: Record<string, AxisResult>;
}

/** 한 통화축: 멤버별 paid/share/net 집계(Σnet==0) + 최소송금. amountOf로 축(local/settlement) 선택. */
function computeAxis(
  members: MemberId[],
  expenses: ExpenseInput[],
  currency: CurrencyCode,
  amountOf: (e: ExpenseInput) => Minor,
): AxisResult {
  const paid = new Map<MemberId, bigint>(members.map((m) => [m, 0n]));
  const share = new Map<MemberId, bigint>(members.map((m) => [m, 0n]));
  let total = 0n;
  for (const e of expenses) {
    const amt = amountOf(e);
    total += amt;
    paid.set(e.paid_by, (paid.get(e.paid_by) ?? 0n) + amt);
    for (const [m, v] of splitExpense(amt, e.participants)) share.set(m, (share.get(m) ?? 0n) + v);
  }
  const summaries: Summary[] = members.map((m) => {
    const tp = (paid.get(m) ?? 0n) as Minor;
    const ts = (share.get(m) ?? 0n) as Minor;
    return { member: m, total_paid: tp, total_share: ts, net: (tp - ts) as Minor };
  });
  let netSum = 0n;
  const net = new Map<MemberId, Minor>();
  for (const s of summaries) {
    netSum += s.net;
    net.set(s.member, s.net);
  }
  if (netSum !== 0n) throw new SettlementInvariantError("Σnet != 0");
  return { transfers: minTransfers(net, currency), summaries, total: total as Minor };
}

export function computeSettlement(input: {
  expenses: ExpenseInput[];
  members: MemberId[];
}): SettlementResult {
  // settlement 축: 모든 지출이 동일 정산통화여야 함 (PRD §17.1)
  const settlementCurrency = input.expenses[0]?.settlement.currency;
  for (const e of input.expenses) {
    if (settlementCurrency && e.settlement.currency !== settlementCurrency) {
      throw new SettlementInvariantError("mixed settlement currency");
    }
  }
  const settlement = computeAxis(
    input.members,
    input.expenses,
    settlementCurrency ?? ("KRW" as CurrencyCode),
    (e) => e.settlement.amount,
  );
  // local 축: 통화별 독립 서브축 (Phase3 다통화)
  const byCurrency = new Map<string, ExpenseInput[]>();
  for (const e of input.expenses) {
    const c = e.local.currency;
    if (!byCurrency.has(c)) byCurrency.set(c, []);
    byCurrency.get(c)!.push(e);
  }
  const local: Record<string, AxisResult> = {};
  for (const [c, es] of byCurrency) {
    local[c] = computeAxis(input.members, es, c as CurrencyCode, (e) => e.local.amount);
  }
  return { settlement, local };
}
