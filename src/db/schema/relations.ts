import { relations } from "drizzle-orm";
import { trips } from "./trips.ts";
import { tripMembers } from "./members.ts";
import { expenseParticipants, expenses } from "./expenses.ts";
import {
  settlementCurrencyTotals,
  settlementMemberSummaries,
  settlementTransfers,
  settlements,
} from "./settlements.ts";

// 쿼리 레이어 편의 relations (조인 힌트). DB-레벨 무결성은 각 테이블의 composite FK가 강제.
export const tripsRelations = relations(trips, ({ many }) => ({
  members: many(tripMembers),
  expenses: many(expenses),
  settlements: many(settlements),
}));

export const tripMembersRelations = relations(tripMembers, ({ one }) => ({
  trip: one(trips, { fields: [tripMembers.trip_id], references: [trips.id] }),
}));

export const expensesRelations = relations(expenses, ({ one, many }) => ({
  trip: one(trips, { fields: [expenses.trip_id], references: [trips.id] }),
  participants: many(expenseParticipants),
}));

export const expenseParticipantsRelations = relations(expenseParticipants, ({ one }) => ({
  expense: one(expenses, { fields: [expenseParticipants.expense_id], references: [expenses.id] }),
  member: one(tripMembers, {
    fields: [expenseParticipants.member_id],
    references: [tripMembers.id],
  }),
}));

export const settlementsRelations = relations(settlements, ({ one, many }) => ({
  trip: one(trips, { fields: [settlements.trip_id], references: [trips.id] }),
  transfers: many(settlementTransfers),
  summaries: many(settlementMemberSummaries),
  currencyTotals: many(settlementCurrencyTotals),
}));

export const settlementTransfersRelations = relations(settlementTransfers, ({ one }) => ({
  settlement: one(settlements, {
    fields: [settlementTransfers.settlement_id],
    references: [settlements.id],
  }),
}));

export const settlementMemberSummariesRelations = relations(
  settlementMemberSummaries,
  ({ one }) => ({
    settlement: one(settlements, {
      fields: [settlementMemberSummaries.settlement_id],
      references: [settlements.id],
    }),
  }),
);

export const settlementCurrencyTotalsRelations = relations(settlementCurrencyTotals, ({ one }) => ({
  settlement: one(settlements, {
    fields: [settlementCurrencyTotals.settlement_id],
    references: [settlements.id],
  }),
}));
