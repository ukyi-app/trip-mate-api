import { pgEnum } from "drizzle-orm/pg-core";

// 안정 enum = pgEnum (값 고정). 진화 enum(input_source·category·payment_method·change_type)은 text+CHECK.
export const roleEnum = pgEnum("role", ["admin", "member"]);
export const memberStatusEnum = pgEnum("member_status", [
  "invited",
  "joined",
  "deactivated",
  "invite_expired",
]);
export const settlementStatusEnum = pgEnum("settlement_status", ["open", "finalized"]);
export const snapshotStatusEnum = pgEnum("snapshot_status", ["active", "superseded"]);
export const paymentStatusEnum = pgEnum("payment_status", ["pending", "paid"]);
export const basisEnum = pgEnum("basis", ["settlement", "local"]);
export const amountSourceEnum = pgEnum("settlement_amount_source", ["card_billed", "converted"]);
export const rateSourceEnum = pgEnum("exchange_rate_source", [
  "identity",
  "manual",
  "auto",
  "last_known",
  "trip_default",
]);
export const expenseStateEnum = pgEnum("expense_settlement_state", [
  "included",
  "personal",
  "record_only",
]);
