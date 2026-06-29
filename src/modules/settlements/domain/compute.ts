import { type CurrencyCode, type MemberId, type Minor } from "../../../core/money.ts";
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
