import { check, numeric, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamps } from "./_shared.ts";
import { trips } from "./trips.ts";
import { currencies } from "./currencies.ts";

export const tripFxDefaults = pgTable(
  "trip_fx_defaults",
  {
    trip_id: uuid()
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    base_currency: text()
      .notNull()
      .references(() => currencies.code),
    settlement_currency: text()
      .notNull()
      .references(() => currencies.code),
    rate: numeric({ precision: 20, scale: 10 }).notNull(),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.trip_id, t.base_currency, t.settlement_currency] }),
    check("fx_default_rate_pos", sql`${t.rate} > 0`), // 손상/음수 rate 영속 차단 (finding #2)
  ],
);
