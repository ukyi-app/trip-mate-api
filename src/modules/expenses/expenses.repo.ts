import { and, eq, inArray, isNull, desc, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { expenses, expenseParticipants, expenseAuditLogs } from "../../db/schema/expenses.ts";
import { trips } from "../../db/schema/trips.ts";
import { ConflictError } from "../../core/errors.ts";

export interface ExpenseSnapshot {
  trip_id: string;
  timezone: string; // FX date 파생에 쓴 trip TZ — repo가 lock 하에 재검증(finding #3 pass3, stale tz 차단)
  title: string;
  local_amount: bigint;
  local_currency: string;
  settlement_amount: bigint;
  settlement_currency: string;
  exchange_rate: string | null; // card_billed면 null
  exchange_rate_date: string; // NOT NULL(card_billed도 spent_at·tz 파생)
  exchange_rate_source: "identity" | "manual" | "auto" | "last_known" | "trip_default" | null; // card_billed면 null
  exchange_rate_provider: string | null;
  exchange_rate_table_date: string | null;
  exchange_rate_fetched_at: Date | null;
  settlement_amount_source: "converted" | "card_billed";
  payment_method: string;
  category: string;
  spent_at: Date;
  expense_settlement_state: "included" | "personal" | "record_only";
  memo: string | null;
  paid_by_member_id: string;
  created_by_member_id: string;
  participant_member_ids: string[];
}
export interface ExpenseRow {
  id: string;
  trip_id: string;
  title: string;
  local_amount: bigint;
  local_currency: string;
  settlement_amount: bigint;
  settlement_currency: string;
  exchange_rate: string | null;
  exchange_rate_source: "identity" | "manual" | "auto" | "last_known" | "trip_default" | null;
  settlement_amount_source: "converted" | "card_billed";
  payment_method: string;
  category: string;
  paid_by_member_id: string;
  spent_at: Date;
  expense_settlement_state: "included" | "personal" | "record_only";
  memo: string | null;
  version: number;
  participant_member_ids: string[];
}
export interface MetaPatch {
  title?: string | undefined;
  payment_method?: string | undefined;
  category?: string | undefined;
  memo?: string | null | undefined;
  expense_settlement_state?: "included" | "personal" | "record_only" | undefined;
  participant_member_ids?: string[] | undefined;
}

const COLS = {
  id: expenses.id,
  trip_id: expenses.trip_id,
  title: expenses.title,
  local_amount: expenses.local_amount,
  local_currency: expenses.local_currency,
  settlement_amount: expenses.settlement_amount,
  settlement_currency: expenses.settlement_currency,
  exchange_rate: expenses.exchange_rate,
  exchange_rate_source: expenses.exchange_rate_source,
  settlement_amount_source: expenses.settlement_amount_source,
  payment_method: expenses.payment_method,
  category: expenses.category,
  paid_by_member_id: expenses.paid_by_member_id,
  spent_at: expenses.spent_at,
  expense_settlement_state: expenses.expense_settlement_state,
  memo: expenses.memo,
  version: expenses.version,
};

// audit jsonb-safe 변환(bigint→string, Date→ISO) — JSON.stringify(bigint) 예외 회피(finding #3 pass1)
type FullRow = { local_amount: bigint; settlement_amount: bigint; spent_at: Date } & Record<
  string,
  unknown
>;
const jsonSafe = (r: FullRow, parts: string[]): Record<string, unknown> => ({
  ...r,
  local_amount: r.local_amount.toString(),
  settlement_amount: r.settlement_amount.toString(),
  spent_at: r.spent_at.toISOString(),
  participant_member_ids: parts,
});

export class DrizzleExpenseRepo<T extends Record<string, unknown>> {
  constructor(private readonly db: PostgresJsDatabase<T>) {}

  /** 단일 tx: trip-lock(open 검사) + expense insert + participants + audit(create).
   *  trip-row FOR UPDATE로 finalize 경로와 직렬화(finding #2 pass2, TOCTOU 제거).
   *  ⚠️ settlement finalize 슬라이스도 동일 trip-row를 FOR UPDATE로 잠가야 상호 직렬화(forward-ref). */
  async create(s: ExpenseSnapshot): Promise<{ id: string; version: number }> {
    return this.db.transaction(async (tx) => {
      // trip-row FOR UPDATE: finalize 직렬화 + FX 계산에 쓴 timezone이 그새 바뀌지 않았는지 재검증(finding #2·#3 pass2/3)
      const tlock = await tx
        .select({ status: trips.settlement_status, tz: trips.timezone })
        .from(trips)
        .where(eq(trips.id, s.trip_id))
        .for("update");
      if (tlock[0]?.status !== "open")
        throw new ConflictError("trip settlement finalized; expenses locked", {
          tripId: s.trip_id,
        });
      if (tlock[0].tz !== s.timezone)
        throw new ConflictError("trip timezone changed during create; retry", {
          tripId: s.trip_id,
        }); // stale tz → 409, 클라 재계산
      const rows = await tx
        .insert(expenses)
        .values({
          trip_id: s.trip_id,
          title: s.title,
          local_amount: s.local_amount,
          local_currency: s.local_currency,
          settlement_amount: s.settlement_amount,
          settlement_currency: s.settlement_currency,
          exchange_rate: s.exchange_rate,
          exchange_rate_date: s.exchange_rate_date,
          exchange_rate_source: s.exchange_rate_source,
          exchange_rate_provider: s.exchange_rate_provider,
          exchange_rate_table_date: s.exchange_rate_table_date,
          exchange_rate_fetched_at: s.exchange_rate_fetched_at,
          settlement_amount_source: s.settlement_amount_source,
          payment_method: s.payment_method,
          category: s.category,
          paid_by_member_id: s.paid_by_member_id,
          created_by_member_id: s.created_by_member_id,
          spent_at: s.spent_at,
          expense_settlement_state: s.expense_settlement_state,
          memo: s.memo,
        })
        .returning({ id: expenses.id, version: expenses.version });
      const exp = rows[0]!;
      await tx.insert(expenseParticipants).values(
        s.participant_member_ids.map((member_id) => ({
          trip_id: s.trip_id,
          expense_id: exp.id,
          member_id,
        })),
      );
      await tx.insert(expenseAuditLogs).values({
        trip_id: s.trip_id,
        expense_id: exp.id,
        changed_by_member_id: s.created_by_member_id,
        change_type: "create",
        before_value: null,
        after_value: {
          title: s.title,
          local_amount: s.local_amount.toString(),
          local_currency: s.local_currency,
          settlement_amount: s.settlement_amount.toString(),
          settlement_currency: s.settlement_currency,
          exchange_rate: s.exchange_rate,
          exchange_rate_source: s.exchange_rate_source,
          payment_method: s.payment_method,
          category: s.category,
          paid_by_member_id: s.paid_by_member_id,
          participant_member_ids: s.participant_member_ids,
          expense_settlement_state: s.expense_settlement_state,
        },
      });
      return exp;
    });
  }

  private async participantsOf(expenseIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (expenseIds.length === 0) return map;
    const rows = await this.db
      .select({
        expense_id: expenseParticipants.expense_id,
        member_id: expenseParticipants.member_id,
      })
      .from(expenseParticipants)
      .where(inArray(expenseParticipants.expense_id, expenseIds));
    for (const r of rows) map.set(r.expense_id, [...(map.get(r.expense_id) ?? []), r.member_id]);
    return map;
  }

  async findById(tripId: string, id: string): Promise<ExpenseRow | null> {
    const rows = await this.db
      .select(COLS)
      .from(expenses)
      .where(and(eq(expenses.trip_id, tripId), eq(expenses.id, id), isNull(expenses.deleted_at)));
    const row = rows[0];
    if (!row) return null;
    const parts = await this.participantsOf([id]);
    return { ...row, participant_member_ids: parts.get(id) ?? [] } as ExpenseRow;
  }

  async listForTrip(tripId: string, limit: number): Promise<ExpenseRow[]> {
    const rows = await this.db
      .select(COLS)
      .from(expenses)
      .where(and(eq(expenses.trip_id, tripId), isNull(expenses.deleted_at)))
      .orderBy(desc(expenses.spent_at), desc(expenses.id))
      .limit(limit);
    const parts = await this.participantsOf(rows.map((r) => r.id));
    return rows.map((r) => ({
      ...r,
      participant_member_ids: parts.get(r.id) ?? [],
    })) as ExpenseRow[];
  }

  /** version CAS UPDATE(메타만) + 참여자 재설정 + audit(update, before/after 전체 스냅샷). 0행이면 null. */
  async updateMeta(
    tripId: string,
    id: string,
    version: number,
    patch: MetaPatch,
    actorMemberId: string,
  ): Promise<{ version: number } | null> {
    return this.db.transaction(async (tx) => {
      const tlock = await tx
        .select({ status: trips.settlement_status })
        .from(trips)
        .where(eq(trips.id, tripId))
        .for("update"); // finalize 직렬화(finding #2 pass2)
      if (tlock[0]?.status !== "open")
        throw new ConflictError("trip settlement finalized; expenses locked", { tripId });
      // 변경 전 전체 상태(finding #3 pass1) — tx 내 인라인 로드(tx는 select/insert/update 보유)
      const bRows = await tx
        .select(COLS)
        .from(expenses)
        .where(and(eq(expenses.trip_id, tripId), eq(expenses.id, id)));
      const bParts = await tx
        .select({ m: expenseParticipants.member_id })
        .from(expenseParticipants)
        .where(
          and(eq(expenseParticipants.trip_id, tripId), eq(expenseParticipants.expense_id, id)),
        );
      const before = bRows[0]
        ? jsonSafe(
            bRows[0] as FullRow,
            bParts.map((p) => p.m),
          )
        : null;

      const set: Record<string, unknown> = {
        version: sql`${expenses.version} + 1`,
        last_modified_by_member_id: actorMemberId,
      };
      if (patch.title !== undefined) set.title = patch.title;
      if (patch.payment_method !== undefined) set.payment_method = patch.payment_method;
      if (patch.category !== undefined) set.category = patch.category;
      if (patch.memo !== undefined) set.memo = patch.memo;
      if (patch.expense_settlement_state !== undefined)
        set.expense_settlement_state = patch.expense_settlement_state;
      const updated = await tx
        .update(expenses)
        .set(set)
        .where(
          and(
            eq(expenses.trip_id, tripId),
            eq(expenses.id, id),
            eq(expenses.version, version),
            isNull(expenses.deleted_at),
          ),
        )
        .returning({ version: expenses.version });
      const row = updated[0];
      if (!row) return null; // stale/부재 → 롤백
      if (patch.participant_member_ids !== undefined) {
        await tx
          .delete(expenseParticipants)
          .where(
            and(eq(expenseParticipants.trip_id, tripId), eq(expenseParticipants.expense_id, id)),
          );
        await tx.insert(expenseParticipants).values(
          patch.participant_member_ids.map((m) => ({
            trip_id: tripId,
            expense_id: id,
            member_id: m,
          })),
        );
      }
      // 변경 후 전체 상태
      const aRows = await tx
        .select(COLS)
        .from(expenses)
        .where(and(eq(expenses.trip_id, tripId), eq(expenses.id, id)));
      const aParts = await tx
        .select({ m: expenseParticipants.member_id })
        .from(expenseParticipants)
        .where(
          and(eq(expenseParticipants.trip_id, tripId), eq(expenseParticipants.expense_id, id)),
        );
      const after = aRows[0]
        ? jsonSafe(
            aRows[0] as FullRow,
            aParts.map((p) => p.m),
          )
        : null;
      await tx.insert(expenseAuditLogs).values({
        trip_id: tripId,
        expense_id: id,
        changed_by_member_id: actorMemberId,
        change_type: "update",
        before_value: before,
        after_value: after,
      });
      return row;
    });
  }

  async softDelete(
    tripId: string,
    id: string,
    version: number,
    actorMemberId: string,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const tlock = await tx
        .select({ status: trips.settlement_status })
        .from(trips)
        .where(eq(trips.id, tripId))
        .for("update"); // finalize 직렬화(finding #2 pass2)
      if (tlock[0]?.status !== "open")
        throw new ConflictError("trip settlement finalized; expenses locked", { tripId });
      const bRows = await tx
        .select(COLS)
        .from(expenses)
        .where(and(eq(expenses.trip_id, tripId), eq(expenses.id, id)));
      const bParts = await tx
        .select({ m: expenseParticipants.member_id })
        .from(expenseParticipants)
        .where(
          and(eq(expenseParticipants.trip_id, tripId), eq(expenseParticipants.expense_id, id)),
        );
      const before = bRows[0]
        ? jsonSafe(
            bRows[0] as FullRow,
            bParts.map((p) => p.m),
          )
        : null; // 삭제 전 전체(finding #3 pass1)
      const updated = await tx
        .update(expenses)
        .set({
          deleted_at: sql`now()`,
          version: sql`${expenses.version} + 1`,
          last_modified_by_member_id: actorMemberId,
        })
        .where(
          and(
            eq(expenses.trip_id, tripId),
            eq(expenses.id, id),
            eq(expenses.version, version),
            isNull(expenses.deleted_at),
          ),
        )
        .returning({ id: expenses.id });
      if (!updated[0]) return false;
      await tx.insert(expenseAuditLogs).values({
        trip_id: tripId,
        expense_id: id,
        changed_by_member_id: actorMemberId,
        change_type: "delete",
        before_value: before,
        after_value: null,
      });
      return true;
    });
  }
}
