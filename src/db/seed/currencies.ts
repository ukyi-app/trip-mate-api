import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { currencies } from "../schema/currencies.ts";

// §48 부록 표. TWD는 ISO 2자리이나 실무 정수 거래 관행 → minor_unit=0.
export const CURRENCY_SEED = [
  { code: "KRW", iso_exponent: 0, minor_unit: 0, symbol: "₩" },
  { code: "JPY", iso_exponent: 0, minor_unit: 0, symbol: "¥" },
  { code: "VND", iso_exponent: 0, minor_unit: 0, symbol: "₫" },
  { code: "TWD", iso_exponent: 2, minor_unit: 0, symbol: "NT$" },
  { code: "USD", iso_exponent: 2, minor_unit: 2, symbol: "$" },
  { code: "EUR", iso_exponent: 2, minor_unit: 2, symbol: "€" },
  { code: "THB", iso_exponent: 2, minor_unit: 2, symbol: "฿" },
  { code: "GBP", iso_exponent: 2, minor_unit: 2, symbol: "£" },
  { code: "CHF", iso_exponent: 2, minor_unit: 2, symbol: "Fr" },
];

export async function seedCurrencies<T extends Record<string, unknown>>(
  db: PostgresJsDatabase<T>,
): Promise<void> {
  await db.insert(currencies).values(CURRENCY_SEED).onConflictDoNothing();
}
