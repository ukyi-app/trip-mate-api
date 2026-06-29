import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { trips } from "../../db/schema/trips.ts";
import {
  ConflictError,
  NotFoundError,
  ForbiddenError,
  SettlementInvariantError,
} from "../../core/errors.ts";
import { computeSettlement, type ExpenseInput } from "./domain/compute.ts";
import { money, type MemberId, type ExpenseId } from "../../core/money.ts";
import { DrizzleSettlementRepo, type IncludedExpenseRow } from "./settlements.repo.ts";
import type { SettlementResponse } from "./settlements.schema.ts";

export interface SettleActor {
  memberId: string;
  role: string;
}

function toInputs(rows: IncludedExpenseRow[]): { expenses: ExpenseInput[]; members: MemberId[] } {
  const members = new Set<string>();
  const expenses = rows.map((r) => {
    members.add(r.paid_by_member_id);
    for (const p of r.participant_member_ids) members.add(p);
    return {
      id: r.id as ExpenseId,
      paid_by: r.paid_by_member_id as MemberId,
      participants: r.participant_member_ids as MemberId[],
      local: money(r.local_amount, r.local_currency),
      settlement: money(r.settlement_amount, r.settlement_currency),
      ...(r.refund_of_expense_id ? { refund_of: r.refund_of_expense_id as ExpenseId } : {}),
    } satisfies ExpenseInput;
  });
  return { expenses, members: [...members] as MemberId[] };
}

function emptyResponse(
  tripId: string,
  status: "open" | "finalized",
  version: number | null,
  seen: { expense_id: string; version: number }[],
): SettlementResponse {
  return {
    trip_id: tripId,
    settlement_status: status,
    version,
    settlement_total: "0",
    seen_versions: seen,
    transfers: [],
    summaries: [],
    currency_totals: [],
  };
}

function assertNoDrift(
  seen: { expense_id: string; version: number }[],
  current: IncludedExpenseRow[],
): void {
  const seenMap = new Map(seen.map((s) => [s.expense_id, s.version]));
  const curMap = new Map(current.map((c) => [c.id, c.version]));
  if (seenMap.size !== curMap.size)
    throw new ConflictError("reviewed-set drift (expense added/removed)");
  for (const [id, v] of curMap) {
    if (seenMap.get(id) !== v)
      throw new ConflictError("reviewed-set drift (version changed)", { expense_id: id });
  }
}

export class SettlementsService<T extends Record<string, unknown>> {
  constructor(
    private readonly db: PostgresJsDatabase<T>,
    private readonly repo: DrizzleSettlementRepo<T>,
  ) {}

  /** GET(finding #2): finalized=영속 active 스냅샷(실 transfer id·결제상태)·open=라이브(합성 id·pending).
   *  tx + trips FOR SHARE로 finalize/unlock(FOR UPDATE)과 직렬화 → status·데이터 원자(finding #2 pass2). */
  async getSettlement(tripId: string): Promise<SettlementResponse> {
    return this.db.transaction(async (tx) => {
      const tripRow = await tx
        .select({ status: trips.settlement_status })
        .from(trips)
        .where(eq(trips.id, tripId))
        .for("share");
      if (!tripRow[0]) throw new NotFoundError("trip not found");
      const status = tripRow[0].status as "open" | "finalized";
      const rows = await this.repo.listIncludedExpenses(tx, tripId);
      const seen = rows.map((r) => ({ expense_id: r.id, version: r.version }));

      if (status === "finalized") {
        const snap = await this.repo.getActiveSnapshotFull(tx, tripId);
        if (!snap) return emptyResponse(tripId, "finalized", null, seen);
        return {
          trip_id: tripId,
          settlement_status: "finalized",
          version: snap.version,
          settlement_total: snap.total.toString(),
          seen_versions: seen,
          transfers: snap.transfers.map((t) => ({
            id: t.id,
            basis: t.basis as "settlement" | "local",
            currency: t.currency,
            from_member_id: t.from_member_id,
            to_member_id: t.to_member_id,
            amount: t.amount.toString(),
            payment_status: t.payment_status as "pending" | "paid",
            paid_at: t.paid_at ? t.paid_at.toISOString() : null,
          })),
          summaries: snap.summaries.map((s) => ({
            member_id: s.member_id,
            basis: s.basis as "settlement" | "local",
            currency: s.currency,
            total_paid: s.total_paid.toString(),
            total_share: s.total_share.toString(),
            net_amount: s.net_amount.toString(),
          })),
          currency_totals: snap.currencyTotals.map((c) => ({
            currency: c.currency,
            total_amount: c.total_amount.toString(),
          })),
        };
      }
      // open: 라이브
      if (rows.length === 0) return emptyResponse(tripId, "open", null, seen);
      const settleCcy = rows[0]!.settlement_currency;
      const result = computeSettlement(toInputs(rows));
      const liveTransfers = [
        ...result.settlement.transfers.map((t) => ({
          basis: "settlement" as const,
          currency: settleCcy,
          t,
        })),
        ...Object.entries(result.local).flatMap(([ccy, ax]) =>
          ax.transfers.map((t) => ({ basis: "local" as const, currency: ccy, t })),
        ),
      ];
      return {
        trip_id: tripId,
        settlement_status: "open",
        version: null,
        settlement_total: result.settlement.total.toString(),
        seen_versions: seen,
        transfers: liveTransfers.map((x) => ({
          id: randomUUID(),
          basis: x.basis,
          currency: x.currency,
          from_member_id: x.t.from,
          to_member_id: x.t.to,
          amount: x.t.amount.toString(),
          payment_status: "pending" as const,
          paid_at: null,
        })),
        summaries: [
          ...result.settlement.summaries.map((s) => ({
            member_id: s.member,
            basis: "settlement" as const,
            currency: settleCcy,
            total_paid: s.total_paid.toString(),
            total_share: s.total_share.toString(),
            net_amount: s.net.toString(),
          })),
          ...Object.entries(result.local).flatMap(([ccy, ax]) =>
            ax.summaries.map((s) => ({
              member_id: s.member,
              basis: "local" as const,
              currency: ccy,
              total_paid: s.total_paid.toString(),
              total_share: s.total_share.toString(),
              net_amount: s.net.toString(),
            })),
          ),
        ],
        currency_totals: Object.entries(result.local).map(([ccy, ax]) => ({
          currency: ccy,
          total_amount: ax.total.toString(),
        })),
      };
    });
  }

  async precheck(tripId: string): Promise<{
    finalizable: boolean;
    reasons: string[];
    settlement_total: string;
    seen_versions: { expense_id: string; version: number }[];
  }> {
    const rows = await this.repo.listIncludedExpenses(this.db, tripId);
    const seen_versions = rows.map((r) => ({ expense_id: r.id, version: r.version }));
    const reasons: string[] = [];
    if (rows.length === 0) reasons.push("no included expenses");
    let total = "0";
    try {
      const result = rows.length > 0 ? computeSettlement(toInputs(rows)) : null;
      total = (result?.settlement.total ?? 0n).toString();
    } catch (e) {
      if (e instanceof SettlementInvariantError) reasons.push(e.message);
      else throw e;
    }
    return { finalizable: reasons.length === 0, reasons, settlement_total: total, seen_versions };
  }

  /** finalize: trips FOR UPDATE → open 확인 → drift 대조 → compute → saveSnapshot → status='finalized'. */
  async finalize(
    tripId: string,
    seen: { expense_id: string; version: number }[],
    actor: SettleActor,
  ): Promise<SettlementResponse> {
    await this.db.transaction(async (tx) => {
      const lock = await this.repo.lockTrip(tx, tripId);
      if (!lock) throw new NotFoundError("trip not found");
      if (lock.status !== "open")
        throw new ConflictError("settlement already finalized", { tripId });
      const rows = await this.repo.listIncludedExpenses(tx, tripId);
      assertNoDrift(seen, rows);
      if (rows.length === 0) throw new SettlementInvariantError("no included expenses to finalize");
      const result = computeSettlement(toInputs(rows)); // Σnet≠0·통화혼재면 throw(422)
      const settleCcy = rows[0]!.settlement_currency;
      await this.repo.saveSnapshot(tx, {
        tripId,
        finalizedByMemberId: actor.memberId,
        result,
        settlementCurrency: settleCcy,
      });
      await this.repo.setTripStatus(tx, tripId, "finalized");
    });
    return this.getSettlement(tripId); // finalized → 영속 스냅샷(새 version 포함) 반환
  }

  async unlock(tripId: string, _actor: SettleActor): Promise<void> {
    await this.db.transaction(async (tx) => {
      const lock = await this.repo.lockTrip(tx, tripId);
      if (!lock) throw new NotFoundError("trip not found");
      if (lock.status !== "finalized")
        throw new ConflictError("settlement not finalized", { tripId });
      // 결제 시작 후 재오픈 금지(finding #1 pass2) — paid 기록 고립/중복결제 차단. reversal/carry-forward는 후속.
      if (await this.repo.hasActivePaidSettlementTransfer(tx, tripId))
        throw new ConflictError("settlement has paid transfers; cannot unlock", { tripId });
      await this.repo.setTripStatus(tx, tripId, "open");
    });
  }

  /** mark-paid(finding #1): trips FOR UPDATE→finalized→active·settlement-basis→인가 선행→CAS(동일 tx 원자, finding #2 pass3). */
  async markPaid(
    tripId: string,
    transferId: string,
    actor: SettleActor,
  ): Promise<{ transferId: string; payment_status: string }> {
    return this.db.transaction(async (tx) => {
      const lock = await this.repo.lockTrip(tx, tripId);
      if (!lock) throw new NotFoundError("trip not found");
      if (lock.status !== "finalized")
        throw new ConflictError("settlement not finalized; no payable transfers", { tripId });
      const xfer = await this.repo.getActiveSettlementTransfer(tx, tripId, transferId);
      if (!xfer) throw new NotFoundError("transfer not found in active settlement");
      if (xfer.to_member_id !== actor.memberId && actor.role !== "admin")
        throw new ForbiddenError("only recipient or admin may mark paid", { transferId });
      if (xfer.payment_status !== "paid")
        await this.repo.setTransferPaid(tx, tripId, transferId, actor.memberId);
      return { transferId, payment_status: "paid" };
    });
  }
}
