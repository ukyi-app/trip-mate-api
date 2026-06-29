import { check, date, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps } from "./_shared.ts";
import { currencies } from "./currencies.ts";
import { settlementStatusEnum } from "./enums.ts";
import { user } from "./auth-schema.ts";

export const trips = pgTable(
  "trips",
  {
    id: pk(),
    title: text().notNull(),
    start_date: date().notNull(),
    end_date: date().notNull(),
    destination_countries: text().array().notNull(), // ISO 3166, ≥1
    timezone: text().notNull(), // IANA, 예 'Asia/Taipei' (환율 일자 산출)
    primary_local_currency: text()
      .notNull()
      .references(() => currencies.code),
    settlement_currency: text()
      .notNull()
      .references(() => currencies.code),
    created_by_user_id: text()
      .notNull()
      .references(() => user.id), // Better Auth user.id (text)
    settlement_status: settlementStatusEnum().notNull().default("open"),
    finalized_at: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check("trip_dates", sql`${t.start_date} <= ${t.end_date}`),
    uniqueIndex("uq_trip_settlement_ccy").on(t.id, t.settlement_currency), // expense composite FK 타깃
    index("ix_trip_creator").on(t.created_by_user_id),
  ],
);
