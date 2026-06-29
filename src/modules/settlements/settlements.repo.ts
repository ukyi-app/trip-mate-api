import { and, eq, inArray, isNull, sql, desc } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { expenses, expenseParticipants } from "../../db/schema/expenses.ts";
import {
  settlements,
  settlementTransfers,
  settlementMemberSummaries,
  settlementCurrencyTotals,
} from "../../db/schema/settlements.ts";
import { trips } from "../../db/schema/trips.ts";
import type { SettlementResult } from "./domain/compute.ts";

export interface IncludedExpenseRow {
  id: string;
  paid_by_member_id: string;
  local_amount: bigint;
  local_currency: string;
  settlement_amount: bigint;
  settlement_currency: string;
  version: number;
  refund_of_expense_id: string | null;
  participant_member_ids: string[];
}

const INC_COLS = {
  id: expenses.id,
  paid_by_member_id: expenses.paid_by_member_id,
  local_amount: expenses.local_amount,
  local_currency: expenses.local_currency,
  settlement_amount: expenses.settlement_amount,
  settlement_currency: expenses.settlement_currency,
  version: expenses.version,
  refund_of_expense_id: expenses.refund_of_expense_id,
};

// db 또는 tx 공용(select+update). finalize/mark-paid는 tx(직렬화·원자), GET은 db.
type Exec = Pick<PostgresJsDatabase<Record<string, unknown>>, "select" | "update">;

export class DrizzleSettlementRepo<T extends Record<string, unknown>> {
  constructor(private readonly db: PostgresJsDatabase<T>) {}

  /** 포함 지출(included·미삭제) + 참여자. exec=tx면 finalize 직렬화 컨텍스트. */
  async listIncludedExpenses(exec: Exec, tripId: string): Promise<IncludedExpenseRow[]> {
    const rows = await exec
      .select(INC_COLS)
      .from(expenses)
      .where(
        and(
          eq(expenses.trip_id, tripId),
          eq(expenses.expense_settlement_state, "included"),
          isNull(expenses.deleted_at),
        ),
      );
    if (rows.length === 0) return [];
    const parts = await exec
      .select({
        expense_id: expenseParticipants.expense_id,
        member_id: expenseParticipants.member_id,
      })
      .from(expenseParticipants)
      .where(
        inArray(
          expenseParticipants.expense_id,
          rows.map((r) => r.id),
        ),
      );
    const byExp = new Map<string, string[]>();
    for (const p of parts)
      byExp.set(p.expense_id, [...(byExp.get(p.expense_id) ?? []), p.member_id]);
    return rows.map((r) => ({
      ...r,
      participant_member_ids: byExp.get(r.id) ?? [],
    })) as IncludedExpenseRow[];
  }

  async lockTrip(tx: Exec, tripId: string): Promise<{ status: string } | null> {
    const rows = await tx
      .select({ status: trips.settlement_status })
      .from(trips)
      .where(eq(trips.id, tripId))
      .for("update");
    return rows[0] ?? null;
  }
  async setTripStatus(
    tx: PostgresJsDatabase<T>,
    tripId: string,
    status: "open" | "finalized",
  ): Promise<void> {
    await tx
      .update(trips)
      .set(
        status === "finalized"
          ? { settlement_status: status, finalized_at: sql`now()` }
          : { settlement_status: status },
      )
      .where(eq(trips.id, tripId));
  }

  /** 이전 active supersede + 새 스냅샷·이중축 transfers/summaries/currency_totals 일괄. 새 version 반환. */
  async saveSnapshot(
    tx: PostgresJsDatabase<T>,
    i: {
      tripId: string;
      finalizedByMemberId: string;
      result: SettlementResult;
      settlementCurrency: string;
    },
  ): Promise<number> {
    const prev = await tx
      .select({ v: settlements.version })
      .from(settlements)
      .where(eq(settlements.trip_id, i.tripId))
      .orderBy(desc(settlements.version))
      .limit(1);
    const version = (prev[0]?.v ?? 0) + 1;
    await tx
      .update(settlements)
      .set({ status: "superseded" })
      .where(and(eq(settlements.trip_id, i.tripId), eq(settlements.status, "active")));
    const ins = await tx
      .insert(settlements)
      .values({
        trip_id: i.tripId,
        version,
        status: "active",
        finalized_by_member_id: i.finalizedByMemberId,
        finalized_at: sql`now()`,
        total_settlement_amount: i.result.settlement.total,
      })
      .returning({ id: settlements.id });
    const sid = ins[0]!.id;
    // transfers: settlement축 + local축
    const allTransfers = [
      ...i.result.settlement.transfers.map((t) => ({ basis: "settlement" as const, ...t })),
      ...Object.values(i.result.local).flatMap((ax) =>
        ax.transfers.map((t) => ({ basis: "local" as const, ...t })),
      ),
    ];
    if (allTransfers.length > 0) {
      await tx.insert(settlementTransfers).values(
        allTransfers.map((t) => ({
          settlement_id: sid,
          trip_id: i.tripId,
          basis: t.basis,
          currency: t.currency,
          from_member_id: t.from,
          to_member_id: t.to,
          amount: t.amount,
          payment_status: "pending" as const,
        })),
      );
    }
    // summaries: settlement축(통화=trip 정산통화) + local축
    const allSummaries = [
      ...i.result.settlement.summaries.map((s) => ({
        basis: "settlement" as const,
        currency: i.settlementCurrency,
        ...s,
      })),
      ...Object.entries(i.result.local).flatMap(([ccy, ax]) =>
        ax.summaries.map((s) => ({ basis: "local" as const, currency: ccy, ...s })),
      ),
    ];
    if (allSummaries.length > 0) {
      await tx.insert(settlementMemberSummaries).values(
        allSummaries.map((s) => ({
          settlement_id: sid,
          trip_id: i.tripId,
          member_id: s.member,
          basis: s.basis,
          currency: s.currency,
          total_paid: s.total_paid,
          total_share: s.total_share,
          net_amount: s.net,
        })),
      );
    }
    // currency_totals: local축 통화별
    const totals = Object.entries(i.result.local).map(([ccy, ax]) => ({
      settlement_id: sid,
      currency: ccy,
      total_amount: ax.total,
    }));
    if (totals.length > 0) await tx.insert(settlementCurrencyTotals).values(totals);
    return version;
  }

  /** **active·finalized 스냅샷의 settlement-basis transfer만**(finding #1 pass1). 인가-선행용 read. */
  async getActiveSettlementTransfer(
    exec: Exec,
    tripId: string,
    transferId: string,
  ): Promise<{ to_member_id: string; payment_status: string } | null> {
    const rows = await exec
      .select({ to: settlementTransfers.to_member_id, status: settlementTransfers.payment_status })
      .from(settlementTransfers)
      .innerJoin(settlements, eq(settlementTransfers.settlement_id, settlements.id))
      .innerJoin(trips, eq(settlements.trip_id, trips.id))
      .where(
        and(
          eq(settlementTransfers.trip_id, tripId),
          eq(settlementTransfers.id, transferId),
          eq(settlementTransfers.basis, "settlement"),
          eq(settlements.status, "active"),
          eq(trips.settlement_status, "finalized"),
        ),
      );
    const r = rows[0];
    return r ? { to_member_id: r.to, payment_status: r.status } : null;
  }

  /** CAS pending→paid(멱등 — 이미 paid면 0행). **인가 tx(exec) 위에서 실행**(finding #2 pass3). */
  async setTransferPaid(
    exec: Exec,
    tripId: string,
    transferId: string,
    actorMemberId: string,
  ): Promise<void> {
    await exec
      .update(settlementTransfers)
      .set({ payment_status: "paid", paid_at: sql`now()`, marked_by_member_id: actorMemberId })
      .where(
        and(
          eq(settlementTransfers.trip_id, tripId),
          eq(settlementTransfers.id, transferId),
          eq(settlementTransfers.payment_status, "pending"),
        ),
      );
  }

  /** **finalized GET용**(finding #2 pass1/2): active 스냅샷의 영속 transfers/summaries/currency_totals. exec=일관-읽기 tx. */
  async getActiveSnapshotFull(
    exec: Exec,
    tripId: string,
  ): Promise<{
    version: number;
    total: bigint;
    transfers: {
      id: string;
      basis: string;
      currency: string;
      from_member_id: string;
      to_member_id: string;
      amount: bigint;
      payment_status: string;
      paid_at: Date | null;
    }[];
    summaries: {
      member_id: string;
      basis: string;
      currency: string;
      total_paid: bigint;
      total_share: bigint;
      net_amount: bigint;
    }[];
    currencyTotals: { currency: string; total_amount: bigint }[];
  } | null> {
    const s = await exec
      .select({
        id: settlements.id,
        version: settlements.version,
        total: settlements.total_settlement_amount,
      })
      .from(settlements)
      .where(and(eq(settlements.trip_id, tripId), eq(settlements.status, "active")));
    if (!s[0]) return null;
    const sid = s[0].id;
    const transfers = await exec
      .select({
        id: settlementTransfers.id,
        basis: settlementTransfers.basis,
        currency: settlementTransfers.currency,
        from_member_id: settlementTransfers.from_member_id,
        to_member_id: settlementTransfers.to_member_id,
        amount: settlementTransfers.amount,
        payment_status: settlementTransfers.payment_status,
        paid_at: settlementTransfers.paid_at,
      })
      .from(settlementTransfers)
      .where(eq(settlementTransfers.settlement_id, sid));
    const summaries = await exec
      .select({
        member_id: settlementMemberSummaries.member_id,
        basis: settlementMemberSummaries.basis,
        currency: settlementMemberSummaries.currency,
        total_paid: settlementMemberSummaries.total_paid,
        total_share: settlementMemberSummaries.total_share,
        net_amount: settlementMemberSummaries.net_amount,
      })
      .from(settlementMemberSummaries)
      .where(eq(settlementMemberSummaries.settlement_id, sid));
    const currencyTotals = await exec
      .select({
        currency: settlementCurrencyTotals.currency,
        total_amount: settlementCurrencyTotals.total_amount,
      })
      .from(settlementCurrencyTotals)
      .where(eq(settlementCurrencyTotals.settlement_id, sid));
    return { version: s[0].version, total: s[0].total, transfers, summaries, currencyTotals };
  }

  /** active settlement-basis transfer 중 paid가 있는지(unlock 차단용, finding #1 pass2). */
  async hasActivePaidSettlementTransfer(exec: Exec, tripId: string): Promise<boolean> {
    const rows = await exec
      .select({ id: settlementTransfers.id })
      .from(settlementTransfers)
      .innerJoin(settlements, eq(settlementTransfers.settlement_id, settlements.id))
      .where(
        and(
          eq(settlementTransfers.trip_id, tripId),
          eq(settlementTransfers.basis, "settlement"),
          eq(settlementTransfers.payment_status, "paid"),
          eq(settlements.status, "active"),
        ),
      );
    return rows.length > 0;
  }
}
