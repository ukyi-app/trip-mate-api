import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps } from "./_shared.ts";
import { trips } from "./trips.ts";
import { tripMembers } from "./members.ts";
import { currencies } from "./currencies.ts";
import { basisEnum, paymentStatusEnum, snapshotStatusEnum } from "./enums.ts";

export const settlements = pgTable(
  "settlements",
  {
    id: pk(),
    trip_id: uuid()
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    version: integer().notNull(), // 1,2,3… 재확정마다 +1
    status: snapshotStatusEnum().notNull().default("active"), // active | superseded
    finalized_by_member_id: uuid().notNull(), // composite FK → trip_members
    finalized_at: timestamp({ withTimezone: true }).notNull(),
    total_settlement_amount: bigint({ mode: "bigint" }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_settlement_active")
      .on(t.trip_id)
      .where(sql`status = 'active'`), // trip당 active ≤1
    uniqueIndex("uq_settlement_version").on(t.trip_id, t.version),
    unique("uq_settlement_trip_id").on(t.trip_id, t.id), // 자식 composite FK 타깃(제약=FK 앞 생성)
    foreignKey({
      columns: [t.trip_id, t.finalized_by_member_id],
      foreignColumns: [tripMembers.trip_id, tripMembers.id],
    }),
    index("ix_settlement_finalizer").on(t.finalized_by_member_id),
  ],
);

// 현지통화별 총지출(정규화 — FK 통화 + bigint 정수 일관성)
export const settlementCurrencyTotals = pgTable(
  "settlement_currency_totals",
  {
    settlement_id: uuid()
      .notNull()
      .references(() => settlements.id, { onDelete: "cascade" }),
    currency: text()
      .notNull()
      .references(() => currencies.code),
    total_amount: bigint({ mode: "bigint" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.settlement_id, t.currency] })], // 스냅샷×통화 1행
);

export const settlementTransfers = pgTable(
  "settlement_transfers",
  {
    id: pk(),
    settlement_id: uuid().notNull(), // composite FK (trip_id, settlement_id) → settlements
    trip_id: uuid().notNull(),
    basis: basisEnum().notNull(), // settlement | local
    currency: text()
      .notNull()
      .references(() => currencies.code),
    from_member_id: uuid().notNull(),
    to_member_id: uuid().notNull(),
    amount: bigint({ mode: "bigint" }).notNull(),
    payment_status: paymentStatusEnum().notNull().default("pending"),
    paid_at: timestamp({ withTimezone: true }),
    marked_by_member_id: uuid(),
    ...timestamps,
  },
  (t) => [
    check("transfer_amount_pos", sql`${t.amount} > 0`),
    check("transfer_distinct", sql`${t.from_member_id} <> ${t.to_member_id}`),
    // paid=둘 다 NOT NULL / pending=둘 다 NULL (half-state 차단)
    check(
      "paid_consistency",
      sql`(payment_status='paid' AND paid_at IS NOT NULL AND marked_by_member_id IS NOT NULL) OR (payment_status='pending' AND paid_at IS NULL AND marked_by_member_id IS NULL)`,
    ),
    check("local_not_tracked", sql`${t.basis}='settlement' OR payment_status='pending'`), // local basis 추적 안 함
    uniqueIndex("uq_transfer_pair").on(
      t.settlement_id,
      t.basis,
      t.currency,
      t.from_member_id,
      t.to_member_id,
    ),
    foreignKey({
      columns: [t.trip_id, t.settlement_id],
      foreignColumns: [settlements.trip_id, settlements.id],
    }).onDelete("cascade"), // 자식 trip=settlement trip
    foreignKey({
      columns: [t.trip_id, t.from_member_id],
      foreignColumns: [tripMembers.trip_id, tripMembers.id],
    }),
    foreignKey({
      columns: [t.trip_id, t.to_member_id],
      foreignColumns: [tripMembers.trip_id, tripMembers.id],
    }),
    foreignKey({
      columns: [t.trip_id, t.marked_by_member_id],
      foreignColumns: [tripMembers.trip_id, tripMembers.id],
    }),
    index("ix_transfer_settlement").on(t.settlement_id),
    index("ix_transfer_from").on(t.from_member_id),
    index("ix_transfer_to").on(t.to_member_id),
  ],
);

export const settlementMemberSummaries = pgTable(
  "settlement_member_summaries",
  {
    id: pk(),
    settlement_id: uuid().notNull(),
    trip_id: uuid().notNull(),
    member_id: uuid().notNull(),
    basis: basisEnum().notNull(),
    currency: text()
      .notNull()
      .references(() => currencies.code),
    total_paid: bigint({ mode: "bigint" }).notNull(),
    total_share: bigint({ mode: "bigint" }).notNull(),
    net_amount: bigint({ mode: "bigint" }).notNull(), // total_paid − total_share
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_summary").on(t.settlement_id, t.member_id, t.basis, t.currency),
    foreignKey({
      columns: [t.trip_id, t.settlement_id],
      foreignColumns: [settlements.trip_id, settlements.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.trip_id, t.member_id],
      foreignColumns: [tripMembers.trip_id, tripMembers.id],
    }),
    index("ix_summary_settlement").on(t.settlement_id),
    index("ix_summary_member").on(t.member_id),
  ],
);
