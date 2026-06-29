import { check, integer, pgTable, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// §48 SSOT 룩업. 모든 *_currency가 FK로 참조 → "없는 통화 코드" DB 차단, minor_unit 데이터화.
export const currencies = pgTable(
  "currencies",
  {
    code: text("code").primaryKey(),
    iso_exponent: integer("iso_exponent").notNull(),
    minor_unit: integer("minor_unit").notNull(),
    symbol: text("symbol").notNull(),
  },
  (t) => [check("currency_code_len", sql`length(${t.code}) = 3`)],
);
