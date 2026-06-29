import Decimal from "decimal.js";
import { type Minor } from "../../../core/money.ts";
import { ValidationError } from "../../../core/errors.ts";
import type { UsdTable } from "../fx.types.ts";

Decimal.set({ precision: 40 }); // cross-rate 나눗셈 고정밀

/** 절댓값 0.5 → 0에서 멀어지게(음수 대칭). decimal.js ROUND_HALF_UP = away-from-zero. */
export function roundHalfAwayFromZero(d: Decimal): bigint {
  return BigInt(d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
}

/** settlement_minor = round_half_away(local_minor × rate × 10^(settleExp − localExp)). rate는 동결된 10dp 값. */
export function convert(args: {
  localMinor: Minor;
  rate: Decimal;
  localExp: number;
  settleExp: number;
}): Minor {
  const scaled = new Decimal(args.localMinor.toString())
    .times(args.rate)
    .times(new Decimal(10).pow(args.settleExp - args.localExp));
  return roundHalfAwayFromZero(scaled) as Minor;
}

/** 1 base = ? quote (major→major). usd 테이블에서 교차. */
export function crossRate(usd: UsdTable, base: string, quote: string): Decimal {
  const b = usd[base];
  const q = usd[quote];
  if (!b || !q || b.lte(0) || q.lte(0))
    throw new Error(`crossRate: missing/invalid rate ${base}/${quote}`);
  return q.div(b);
}

const RATE_MAX = new Decimal(10).pow(10); // numeric(20,10): 정수부 ≤ 10자리

/** 10dp 반올림 **후** 검증: >0(반올림 후 0 아님) & < 10^10(numeric(20,10) 적합). 반올림된 값 반환 (finding #1). */
export function normalizeRate(d: Decimal): Decimal {
  if (!d.isFinite()) throw new ValidationError(`rate not finite: ${d.toString()}`);
  const r = d.toDecimalPlaces(10, Decimal.ROUND_HALF_UP);
  if (r.lte(0)) throw new ValidationError(`rate must be > 0 after 10dp rounding: ${d.toString()}`);
  if (r.abs().gte(RATE_MAX))
    throw new ValidationError(`rate out of numeric(20,10) range: ${d.toString()}`);
  return r;
}

/** rate 문자열 파싱 + normalizeRate(10dp·검증). manual(사용자)·trip_default(영속) 공용. */
export function parsePositiveRate(s: string): Decimal {
  let d: Decimal;
  try {
    d = new Decimal(s);
  } catch {
    throw new ValidationError(`invalid rate: ${s}`);
  }
  return normalizeRate(d);
}
