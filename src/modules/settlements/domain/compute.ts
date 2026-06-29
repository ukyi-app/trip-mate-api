import {
  type CurrencyCode,
  type ExpenseId,
  type MemberId,
  type Minor,
  type Money,
} from "../../../core/money.ts";
import { SettlementInvariantError, ValidationError } from "../../../core/errors.ts";

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

/** |R|(양수)을 origShare 가중으로 정수 apportion(floor + largest-remainder, 소수부 desc·id asc). 음수 반환. */
function apportionRefund(
  absR: bigint,
  origShare: Map<MemberId, Minor>,
  absOrig: bigint,
): Map<MemberId, bigint> {
  const entries = [...origShare.entries()];
  const base = new Map<MemberId, bigint>();
  const frac = new Map<MemberId, bigint>();
  let assigned = 0n;
  for (const [m, sh] of entries) {
    const num = absR * (sh as bigint);
    base.set(m, num / absOrig);
    frac.set(m, num % absOrig);
    assigned += num / absOrig;
  }
  let remainder = absR - assigned; // 0 <= remainder < entries.length
  const order = entries
    .map(([m]) => m)
    .sort((a, b) => {
      const fb = (frac.get(b) ?? 0n) - (frac.get(a) ?? 0n);
      return fb !== 0n ? (fb > 0n ? 1 : -1) : byIdAsc(a, b);
    });
  const out = new Map<MemberId, bigint>();
  for (const m of order) {
    const bonus = remainder > 0n ? 1n : 0n;
    if (remainder > 0n) remainder -= 1n;
    out.set(m, -((base.get(m) ?? 0n) + bonus));
  }
  return out;
}

interface RefundGroup {
  original: ExpenseInput;
  refunds: ExpenseInput[];
}

/** 원지출/환불 분리 + 검증(닫힘·통화·payer·부호·누적≤원액). axis별 amountOf로 호출(§6.3). */
function partitionAndValidate(
  expenses: ExpenseInput[],
  amountOf: (e: ExpenseInput) => Minor,
): { onlyNormal: ExpenseInput[]; groups: Map<ExpenseId, RefundGroup> } {
  const byId = new Map(expenses.map((e) => [e.id, e]));
  const normal: ExpenseInput[] = [];
  const groups = new Map<ExpenseId, RefundGroup>();
  for (const e of expenses) {
    if (e.refund_of === undefined) {
      normal.push(e);
      continue;
    }
    const original = byId.get(e.refund_of);
    if (!original || original.refund_of !== undefined) {
      throw new SettlementInvariantError("refund input not closed");
    }
    if (
      e.local.currency !== original.local.currency ||
      e.settlement.currency !== original.settlement.currency
    ) {
      throw new ValidationError("refund currency mismatch");
    }
    if (e.paid_by !== original.paid_by) {
      throw new ValidationError("refund payer must equal original payer");
    }
    if (amountOf(e) >= 0n) throw new ValidationError("refund amount must be negative");
    if (amountOf(original) <= 0n) throw new ValidationError("original amount must be positive");
    const g = groups.get(original.id) ?? { original, refunds: [] };
    g.refunds.push(e);
    groups.set(original.id, g);
  }
  const grouped = new Set(groups.keys());
  const onlyNormal = normal.filter((e) => !grouped.has(e.id));
  for (const g of groups.values()) {
    const cum = g.refunds.reduce((a, r) => a + amountOf(r), 0n);
    if (-cum > amountOf(g.original))
      throw new ValidationError("over-refund: cumulative > original");
  }
  return { onlyNormal, groups };
}

/** 한 통화축: 일반 지출은 균등 분배, 환불 그룹은 원지출 단위 누적 apportionment로 share 미러(§6.1). */
function computeAxisWithRefunds(
  members: MemberId[],
  normal: ExpenseInput[],
  groups: Map<ExpenseId, RefundGroup>,
  currency: CurrencyCode,
  amountOf: (e: ExpenseInput) => Minor,
): AxisResult {
  const paid = new Map<MemberId, bigint>(members.map((m) => [m, 0n]));
  const share = new Map<MemberId, bigint>(members.map((m) => [m, 0n]));
  let total = 0n;
  for (const e of normal) {
    const amt = amountOf(e);
    total += amt;
    paid.set(e.paid_by, (paid.get(e.paid_by) ?? 0n) + amt);
    for (const [m, v] of splitExpense(amt, e.participants)) share.set(m, (share.get(m) ?? 0n) + v);
  }
  for (const { original, refunds } of groups.values()) {
    const oAmt = amountOf(original);
    total += oAmt;
    paid.set(original.paid_by, (paid.get(original.paid_by) ?? 0n) + oAmt);
    const oShare = splitExpense(oAmt, original.participants);
    for (const [m, v] of oShare) share.set(m, (share.get(m) ?? 0n) + v);
    let r = 0n;
    for (const rf of refunds) {
      const rAmt = amountOf(rf);
      total += rAmt;
      r += rAmt;
      paid.set(rf.paid_by, (paid.get(rf.paid_by) ?? 0n) + rAmt);
    }
    const cum = apportionRefund(-r, oShare, oAmt);
    for (const [m, v] of cum) share.set(m, (share.get(m) ?? 0n) + v);
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
  const sp = partitionAndValidate(input.expenses, (e) => e.settlement.amount);
  const settlement = computeAxisWithRefunds(
    input.members,
    sp.onlyNormal,
    sp.groups,
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
    const lp = partitionAndValidate(es, (e) => e.local.amount);
    local[c] = computeAxisWithRefunds(
      input.members,
      lp.onlyNormal,
      lp.groups,
      c as CurrencyCode,
      (e) => e.local.amount,
    );
  }
  return { settlement, local };
}
