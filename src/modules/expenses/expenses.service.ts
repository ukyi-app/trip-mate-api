import { and, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { trips } from "../../db/schema/trips.ts";
import { tripMembers } from "../../db/schema/members.ts";
import { currencies } from "../../db/schema/currencies.ts";
import {
  ConflictError,
  FxUnresolvedError,
  NotFoundError,
  ValidationError,
} from "../../core/errors.ts";
import { resolveFx, type FxDeps } from "../fx/fx.service.ts";
import { isResolved, type FxInput, type FxResult } from "../fx/fx.types.ts";
import { splitExpense } from "../settlements/domain/compute.ts";
import { minor, type CurrencyCode, type MemberId } from "../../core/money.ts";
import type { DrizzleExpenseRepo, ExpenseRow } from "./expenses.repo.ts";
import type { CreateExpense, UpdateExpense, PreviewResponse } from "./expenses.schema.ts";

export interface ExpenseActor {
  memberId: string;
}
const dbCode = (e: unknown): string | undefined =>
  (e as { code?: string } | null)?.code ?? (e as { cause?: { code?: string } } | null)?.cause?.code;
const asValidation = (e: unknown): never => {
  const c = dbCode(e);
  // 23503 FK(미지 통화/멤버)·23514 check(fx_by_source)·23505 unique(중복 participant)·22003 numeric overflow(BIGINT 초과, finding #2 pass3)
  if (c === "23503" || c === "23514" || c === "23505" || c === "22003")
    throw new ValidationError("invalid expense input", { sqlstate: c });
  throw e;
};
// spent_at(ISO) → trip TZ의 YYYY-MM-DD
function localDate(spentAtIso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(spentAtIso));
}

export class ExpensesService<T extends Record<string, unknown>> {
  constructor(
    private readonly db: PostgresJsDatabase<T>,
    private readonly repo: DrizzleExpenseRepo<T>,
    private readonly fxDeps: FxDeps,
  ) {}

  // 정산 확정(finalized) trip은 지출 변경 잠금(finding #2 pass1). open만 허용. (create의 빠른 fail + tz/settle 반환)
  private async assertTripOpen(tripId: string): Promise<{ tz: string; settle: string }> {
    const rows = await this.db
      .select({
        tz: trips.timezone,
        settle: trips.settlement_currency,
        status: trips.settlement_status,
      })
      .from(trips)
      .where(eq(trips.id, tripId));
    const trip = rows[0];
    if (!trip) throw new NotFoundError("trip not found");
    if (trip.status !== "open")
      throw new ConflictError("trip settlement finalized; expenses locked", { tripId });
    return { tz: trip.tz, settle: trip.settle };
  }

  // exponent 조회 + date 파생 + resolveFx (create·preview·edit 공유, 설계 §6)
  private async resolveExpenseFx(i: {
    tripId: string;
    tz: string;
    settle: string;
    local_amount: string;
    local_currency: string;
    spent_at: string;
    manualRate?: string;
  }): Promise<FxResult> {
    const cur = await this.db
      .select({ code: currencies.code, exp: currencies.minor_unit })
      .from(currencies)
      .where(inArray(currencies.code, [i.local_currency, i.settle]));
    const expOf = new Map(cur.map((c) => [c.code, c.exp]));
    const localExp = expOf.get(i.local_currency);
    const settleExp = expOf.get(i.settle);
    if (localExp === undefined || settleExp === undefined)
      throw new ValidationError("unknown currency", {
        local: i.local_currency,
        settlement: i.settle,
      });
    const fxInput: FxInput = {
      localMinor: minor(BigInt(i.local_amount)),
      localCurrency: i.local_currency as CurrencyCode,
      settlementCurrency: i.settle as CurrencyCode,
      date: localDate(i.spent_at, i.tz),
      localExp,
      settleExp,
      tripId: i.tripId,
      ...(i.manualRate !== undefined ? { manualRate: i.manualRate } : {}),
    };
    return resolveFx(fxInput, this.fxDeps);
  }

  // FX 결과(또는 card_billed)로 expense 영속(단일 tx). exchange_rate_date는 spent_at·tz 파생(NOT NULL).
  private async persist(
    tripId: string,
    trip: { tz: string; settle: string },
    input: CreateExpense,
    actor: ExpenseActor,
    fx: {
      settlement_amount: bigint;
      settlement_amount_source: "converted" | "card_billed";
      exchange_rate: string | null;
      exchange_rate_source: "identity" | "manual" | "auto" | "last_known" | "trip_default" | null;
      exchange_rate_provider: string | null;
      exchange_rate_table_date: string | null;
      exchange_rate_fetched_at: Date | null;
    },
  ): Promise<ExpenseRow> {
    try {
      const { id } = await this.repo.create({
        trip_id: tripId,
        timezone: trip.tz,
        title: input.title,
        local_amount: BigInt(input.local_amount),
        local_currency: input.local_currency,
        settlement_amount: fx.settlement_amount,
        settlement_currency: trip.settle,
        exchange_rate: fx.exchange_rate,
        exchange_rate_date: localDate(input.spent_at, trip.tz),
        exchange_rate_source: fx.exchange_rate_source,
        exchange_rate_provider: fx.exchange_rate_provider,
        exchange_rate_table_date: fx.exchange_rate_table_date,
        exchange_rate_fetched_at: fx.exchange_rate_fetched_at,
        settlement_amount_source: fx.settlement_amount_source,
        payment_method: input.payment_method,
        category: input.category,
        spent_at: new Date(input.spent_at),
        expense_settlement_state: input.expense_settlement_state ?? "included",
        memo: input.memo ?? null,
        paid_by_member_id: input.paid_by_member_id,
        created_by_member_id: actor.memberId,
        participant_member_ids: input.participant_member_ids,
      });
      const row = await this.repo.findById(tripId, id);
      if (!row) throw new NotFoundError("expense not found after create");
      return row;
    } catch (e) {
      return asValidation(e);
    }
  }

  async createExpense(
    tripId: string,
    input: CreateExpense,
    actor: ExpenseActor,
  ): Promise<ExpenseRow> {
    const trip = await this.assertTripOpen(tripId);
    // card_billed: 카드 청구액=정산액, FX 해석 우회(설계 §2)
    if (input.card_billed_settlement_amount !== undefined) {
      return this.persist(tripId, trip, input, actor, {
        settlement_amount: BigInt(input.card_billed_settlement_amount),
        settlement_amount_source: "card_billed",
        exchange_rate: null,
        exchange_rate_source: null,
        exchange_rate_provider: null,
        exchange_rate_table_date: null,
        exchange_rate_fetched_at: null,
      });
    }
    const fx = await this.resolveExpenseFx({
      tripId,
      tz: trip.tz,
      settle: trip.settle,
      local_amount: input.local_amount,
      local_currency: input.local_currency,
      spent_at: input.spent_at,
      ...(input.manualRate !== undefined ? { manualRate: input.manualRate } : {}),
    });
    if (!isResolved(fx))
      throw new FxUnresolvedError("exchange rate unresolved; provide manualRate", { tripId });
    return this.persist(tripId, trip, input, actor, {
      settlement_amount: fx.settlement_amount,
      settlement_amount_source: "converted",
      exchange_rate: fx.exchange_rate,
      exchange_rate_source: fx.exchange_rate_source,
      exchange_rate_provider: fx.exchange_rate_provider,
      exchange_rate_table_date: fx.exchange_rate_table_date,
      exchange_rate_fetched_at: fx.exchange_rate_fetched_at
        ? new Date(fx.exchange_rate_fetched_at)
        : null,
    });
  }

  /** 미영속 미리보기: FX 계산 + 균등분할. needsManual은 구조화 응답(설계 §3, finding #1 pass1). */
  async previewExpense(tripId: string, input: CreateExpense): Promise<PreviewResponse> {
    const trip = await this.assertTripOpen(tripId);
    // 멤버십 검증 — 미영속이라 composite FK 미실행(finding #2 pass2). 입력 member_id가 전부 trip 멤버여야.
    const ids = [...new Set([input.paid_by_member_id, ...input.participant_member_ids])];
    const found = await this.db
      .select({ id: tripMembers.id })
      .from(tripMembers)
      .where(and(eq(tripMembers.trip_id, tripId), inArray(tripMembers.id, ids)));
    if (found.length !== ids.length)
      throw new ValidationError("unknown member in trip", { tripId });

    let settlement_amount: bigint;
    let exchange_rate: string | null;
    let exchange_rate_source: PreviewResponse["exchange_rate_source"];
    let settlement_amount_source: "converted" | "card_billed";
    let fallbackWarning = false;
    if (input.card_billed_settlement_amount !== undefined) {
      settlement_amount = BigInt(input.card_billed_settlement_amount);
      exchange_rate = null;
      exchange_rate_source = null;
      settlement_amount_source = "card_billed";
    } else {
      const fx = await this.resolveExpenseFx({
        tripId,
        tz: trip.tz,
        settle: trip.settle,
        local_amount: input.local_amount,
        local_currency: input.local_currency,
        spent_at: input.spent_at,
        ...(input.manualRate !== undefined ? { manualRate: input.manualRate } : {}),
      });
      if (!isResolved(fx)) {
        return {
          needs_manual: true,
          settlement_amount: null,
          settlement_currency: trip.settle,
          exchange_rate: null,
          exchange_rate_source: null,
          settlement_amount_source: null,
          fallbackWarning: false,
          per_member: [],
        };
      }
      settlement_amount = fx.settlement_amount;
      exchange_rate = fx.exchange_rate;
      exchange_rate_source = fx.exchange_rate_source;
      settlement_amount_source = "converted";
      fallbackWarning = fx.fallbackWarning;
    }
    const split = splitExpense(
      minor(settlement_amount),
      input.participant_member_ids as MemberId[],
    );
    const per_member = [...split].map(([m, s]) => ({
      member_id: m as string,
      share: s.toString(),
    }));
    return {
      needs_manual: false,
      settlement_amount: settlement_amount.toString(),
      settlement_currency: trip.settle,
      exchange_rate,
      exchange_rate_source,
      settlement_amount_source,
      fallbackWarning,
      per_member,
    };
  }

  async listExpenses(tripId: string, limit: number): Promise<ExpenseRow[]> {
    return this.repo.listForTrip(tripId, Math.min(Math.max(limit, 1), 100));
  }
  async getExpense(tripId: string, id: string): Promise<ExpenseRow> {
    const row = await this.repo.findById(tripId, id);
    if (!row) throw new NotFoundError("expense not found");
    return row;
  }
  async updateExpense(
    tripId: string,
    id: string,
    input: UpdateExpense,
    actor: ExpenseActor,
  ): Promise<ExpenseRow> {
    // finalized 가드는 repo.updateMeta tx 내 FOR UPDATE가 race-safe하게 수행(finding #2 pass2)
    const { version, ...patch } = input;
    let res;
    try {
      res = await this.repo.updateMeta(tripId, id, version, patch, actor.memberId);
    } catch (e) {
      return asValidation(e);
    }
    if (!res) {
      // 부재 vs stale 구분
      const exists = await this.repo.findById(tripId, id);
      if (!exists) throw new NotFoundError("expense not found");
      throw new ConflictError("version conflict (stale)", { tripId, id });
    }
    const row = await this.repo.findById(tripId, id);
    if (!row) throw new NotFoundError("expense not found");
    return row;
  }
  async deleteExpense(
    tripId: string,
    id: string,
    version: number,
    actor: ExpenseActor,
  ): Promise<void> {
    // finalized 가드는 repo.softDelete tx 내 FOR UPDATE가 race-safe하게 수행(finding #2 pass2)
    const ok = await this.repo.softDelete(tripId, id, version, actor.memberId);
    if (!ok) {
      const exists = await this.repo.findById(tripId, id);
      if (!exists) throw new NotFoundError("expense not found");
      throw new ConflictError("version conflict (stale)", { tripId, id });
    }
  }
}
