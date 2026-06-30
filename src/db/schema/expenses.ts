import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
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
import { amountSourceEnum, expenseStateEnum, rateSourceEnum } from "./enums.ts";

export const expenses = pgTable(
  "expenses",
  {
    id: pk(),
    trip_id: uuid()
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    title: text().notNull(),
    local_amount: bigint({ mode: "bigint" }).notNull(),
    local_currency: text()
      .notNull()
      .references(() => currencies.code), // §17.2 지출별 통화 수용
    settlement_amount: bigint({ mode: "bigint" }).notNull(),
    settlement_currency: text().notNull(), // = trip.settlement_currency (composite FK)
    exchange_rate: numeric({ precision: 20, scale: 10 }), // authoritative 고정밀, card_billed면 null
    exchange_rate_date: date().notNull(), // 현지 TZ 일자(파생)
    exchange_rate_source: rateSourceEnum(), // identity|manual|auto|last_known|trip_default, card_billed면 null
    exchange_rate_provider: text(), // FX provenance: oxr|currencyapi (auto/last_known)
    exchange_rate_table_date: date(),
    exchange_rate_fetched_at: timestamp({ withTimezone: true }),
    settlement_amount_source: amountSourceEnum().notNull(), // card_billed|converted
    payment_method: text().notNull(),
    category: text().notNull(),
    input_source: text().notNull().default("manual"),
    expense_settlement_state: expenseStateEnum().notNull().default("included"),
    paid_by_member_id: uuid().notNull(), // composite FK (trip_id, …) → trip_members
    created_by_member_id: uuid().notNull(),
    last_modified_by_member_id: uuid(),
    memo: text(),
    spent_at: timestamp({ withTimezone: true }).notNull(),
    refund_of_expense_id: uuid(), // §47.1 — composite FK (trip_id, …) → expenses
    version: integer().notNull().default(0), // 낙관적 잠금 §31.6
    deleted_at: timestamp({ withTimezone: true }), // soft delete
    idempotency_key: text(), // 멱등 마커(§5) — create tx 내 (trip_id,key) unique로 지출 생성 중복 원자 차단
    ...timestamps,
  },
  (t) => [
    // FX는 settlement_amount_source에 묶임 (FX 설계 §10)
    check(
      "fx_by_source",
      sql`(${t.settlement_amount_source}='converted' AND ${t.exchange_rate} IS NOT NULL AND ${t.exchange_rate_source} IS NOT NULL) OR (${t.settlement_amount_source}='card_billed' AND ${t.exchange_rate_source} IS NULL)`,
    ),
    // 진화 enum(text+CHECK) — MVP 값 집합(PRD §12.1·§33·§22.2)
    check(
      "payment_method_check",
      sql`${t.payment_method} IN ('cash','card','transit_card','easy_pay','other')`,
    ),
    check(
      "category_check",
      sql`${t.category} IN ('food','cafe_snack','transport','lodging','shopping','sightseeing','convenience','other')`,
    ),
    check(
      "input_source_check",
      sql`${t.input_source} IN ('manual','ai_oneline','card_sms','receipt','card_capture')`,
    ),
    check(
      "refund_self",
      sql`${t.refund_of_expense_id} IS NULL OR ${t.refund_of_expense_id} <> ${t.id}`,
    ),
    index("ix_exp_trip_spent").on(t.trip_id, t.spent_at.desc()), // 목록 정렬(§32.7)
    index("ix_exp_paid_by").on(t.paid_by_member_id),
    index("ix_exp_created_by").on(t.created_by_member_id),
    index("ix_exp_settle")
      .on(t.trip_id)
      .where(sql`expense_settlement_state='included' AND deleted_at IS NULL`),
    unique("uq_expense_trip_id").on(t.trip_id, t.id), // composite FK 타깃(제약=FK 앞 생성)
    foreignKey({
      columns: [t.trip_id, t.paid_by_member_id],
      foreignColumns: [tripMembers.trip_id, tripMembers.id],
    }),
    foreignKey({
      columns: [t.trip_id, t.created_by_member_id],
      foreignColumns: [tripMembers.trip_id, tripMembers.id],
    }),
    foreignKey({
      columns: [t.trip_id, t.last_modified_by_member_id],
      foreignColumns: [tripMembers.trip_id, tripMembers.id],
    }),
    foreignKey({
      columns: [t.trip_id, t.settlement_currency],
      foreignColumns: [trips.id, trips.settlement_currency],
    }), // trip 단일 정산통화
    foreignKey({
      columns: [t.trip_id, t.refund_of_expense_id],
      foreignColumns: [t.trip_id, t.id],
    }), // 환불 same-trip 자기참조
    index("ix_exp_refund").on(t.refund_of_expense_id),
    // 멱등 dedup(§5·idempotency ADR): 라이브 지출의 (trip_id, idempotency_key) 유일 → 생성 중복 원자 차단.
    // 부분 인덱스: key 없는 생성(null)·soft-delete 행은 제외(키 재사용 가능).
    uniqueIndex("uq_expense_idem")
      .on(t.trip_id, t.idempotency_key)
      .where(sql`idempotency_key IS NOT NULL AND deleted_at IS NULL`),
  ],
);

// 참여자 = 조인 테이블(관계만, 부담액 미저장 — 엔진이 재계산)
export const expenseParticipants = pgTable(
  "expense_participants",
  {
    trip_id: uuid().notNull(),
    expense_id: uuid().notNull(),
    member_id: uuid().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.expense_id, t.member_id] }), // 중복 참여자 방지 + 자연 PK
    foreignKey({
      columns: [t.trip_id, t.expense_id],
      foreignColumns: [expenses.trip_id, expenses.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.trip_id, t.member_id],
      foreignColumns: [tripMembers.trip_id, tripMembers.id],
    }),
    index("ix_part_member").on(t.member_id), // "내가 참여한 지출"(§32.7)
  ],
);

export const expenseAuditLogs = pgTable(
  "expense_audit_logs",
  {
    id: pk(),
    trip_id: uuid()
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    expense_id: uuid().notNull(),
    changed_by_member_id: uuid().notNull(),
    change_type: text().notNull(),
    before_value: jsonb(), // create면 null
    after_value: jsonb(), // delete면 null
    created_at: timestamp({ withTimezone: true }).defaultNow().notNull(), // append-only
  },
  (t) => [
    check("change_type_check", sql`${t.change_type} IN ('create','update','delete','restore')`),
    foreignKey({
      columns: [t.trip_id, t.expense_id],
      foreignColumns: [expenses.trip_id, expenses.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.trip_id, t.changed_by_member_id],
      foreignColumns: [tripMembers.trip_id, tripMembers.id],
    }),
    index("ix_audit_expense").on(t.expense_id, t.created_at.desc()),
    index("ix_audit_trip").on(t.trip_id),
  ],
);
