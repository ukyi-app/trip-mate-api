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
  // ── FE 통화 카탈로그 대비 신규 19종(합계 28) ─────────────────────────────
  { code: "AED", iso_exponent: 2, minor_unit: 2, symbol: "د.إ" },
  { code: "AUD", iso_exponent: 2, minor_unit: 2, symbol: "A$" },
  { code: "CAD", iso_exponent: 2, minor_unit: 2, symbol: "C$" },
  { code: "CNY", iso_exponent: 2, minor_unit: 2, symbol: "¥" },
  { code: "CZK", iso_exponent: 2, minor_unit: 2, symbol: "Kč" },
  { code: "DKK", iso_exponent: 2, minor_unit: 2, symbol: "kr" },
  { code: "HKD", iso_exponent: 2, minor_unit: 2, symbol: "HK$" },
  // HUF: ISO 지수는 2이나 보조단위 fillér가 1999년 폐지되어 정수 forint만 유통 → minor_unit=0.
  // 카드 자동 수집(automated card ingestion)이 없는 수기 입력 여행경비 앱 전제의 의도적 결정(TWD 선례 답습).
  // ⚠️ WARNING: 자동 카드 수집을 도입하면 HUF/TWD entry의 exponent(minor_unit)를 반드시 재검토해야 한다.
  { code: "HUF", iso_exponent: 2, minor_unit: 0, symbol: "Ft" },
  // IDR: ISO 지수는 2이나 보조단위 sen이 폐화되어 정수 rupiah만 유통 → minor_unit=0.
  { code: "IDR", iso_exponent: 2, minor_unit: 0, symbol: "Rp" },
  { code: "INR", iso_exponent: 2, minor_unit: 2, symbol: "₹" },
  { code: "MOP", iso_exponent: 2, minor_unit: 2, symbol: "MOP$" },
  { code: "MYR", iso_exponent: 2, minor_unit: 2, symbol: "RM" },
  { code: "NOK", iso_exponent: 2, minor_unit: 2, symbol: "kr" },
  { code: "NZD", iso_exponent: 2, minor_unit: 2, symbol: "NZ$" },
  { code: "PHP", iso_exponent: 2, minor_unit: 2, symbol: "₱" },
  { code: "PLN", iso_exponent: 2, minor_unit: 2, symbol: "zł" },
  { code: "SEK", iso_exponent: 2, minor_unit: 2, symbol: "kr" },
  { code: "SGD", iso_exponent: 2, minor_unit: 2, symbol: "S$" },
  { code: "TRY", iso_exponent: 2, minor_unit: 2, symbol: "₺" },
];

export async function seedCurrencies<T extends Record<string, unknown>>(
  db: PostgresJsDatabase<T>,
): Promise<void> {
  await db.insert(currencies).values(CURRENCY_SEED).onConflictDoNothing();
}
