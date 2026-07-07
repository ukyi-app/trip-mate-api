import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { expenseDrafts } from "../../db/schema/expense-drafts.ts";
import type { UsageDraft } from "../usage-imports/usage-imports.schema.ts";
import type { ConfirmExpenseDraft } from "./expense-drafts.schema.ts";

export interface DraftRow {
  id: string;
  source: "text" | "image";
  status: "pending" | "confirmed" | "discarded";
  confirmed_expense_id: string | null;
  payload: UsageDraft;
  confirm_payload: ConfirmExpenseDraft | null; // claim 시점 바인딩된 확정 body(복구·경합 결정성)
}

// 초안은 **가져온 멤버의 개인 검토 큐** — 모든 조회·변경은 (trip_id, created_by_member_id)로 스코프.
// 타 멤버는 열람·편집·확정·폐기 불가(프라이버시 + 교차-멤버 중복 확정 방지).
export interface DraftRepo {
  createMany(
    tripId: string,
    memberId: string,
    drafts: UsageDraft[],
    source: "text" | "image",
    opts?: { sourceObjectKey?: string; importKey?: string },
  ): Promise<DraftRow[]>;
  listPending(tripId: string, memberId: string): Promise<DraftRow[]>;
  findById(tripId: string, memberId: string, id: string): Promise<DraftRow | null>;
  updatePayload(
    tripId: string,
    memberId: string,
    id: string,
    payload: UsageDraft,
  ): Promise<DraftRow | null>;
  // pending→confirmed 원자 클레임 + **커밋 payload를 원자 반환** + **확정 body를 원자 바인딩**(중복·stale·경합 방지).
  // 미획득 시 null. 반환 row.confirm_payload = 방금 바인딩한 completion(복구 시 이 값 재사용).
  claimForConfirm(
    tripId: string,
    memberId: string,
    id: string,
    completion: ConfirmExpenseDraft,
  ): Promise<DraftRow | null>;
  setConfirmedExpense(
    tripId: string,
    memberId: string,
    id: string,
    expenseId: string,
  ): Promise<void>;
  // 정의적 도메인 실패(지출 확정적 미생성) 후 편집/재확정 허용용 pending 롤백. **미링크 confirmed만**(고아 방지).
  revertToPending(tripId: string, memberId: string, id: string): Promise<void>;
  softDelete(tripId: string, memberId: string, id: string): Promise<boolean>;
}

const COLS = {
  id: expenseDrafts.id,
  source: expenseDrafts.source,
  status: expenseDrafts.status,
  confirmed_expense_id: expenseDrafts.confirmed_expense_id,
  payload: expenseDrafts.payload,
  confirm_payload: expenseDrafts.confirm_payload,
};

export class DrizzleDraftRepo<T extends Record<string, unknown>> implements DraftRepo {
  constructor(private readonly db: PostgresJsDatabase<T>) {}

  // (trip, 소유 멤버, id) 공통 스코프 — 미삭제만.
  private owned(tripId: string, memberId: string, id: string) {
    return and(
      eq(expenseDrafts.trip_id, tripId),
      eq(expenseDrafts.created_by_member_id, memberId),
      eq(expenseDrafts.id, id),
      isNull(expenseDrafts.deleted_at),
    );
  }

  async createMany(
    tripId: string,
    memberId: string,
    drafts: UsageDraft[],
    source: "text" | "image",
    opts: { sourceObjectKey?: string; importKey?: string } = {},
  ): Promise<DraftRow[]> {
    if (drafts.length === 0) return [];
    const values = drafts.map((d) => ({
      trip_id: tripId,
      created_by_member_id: memberId,
      source,
      payload: d,
      confidence: String(d.confidence),
      ...(opts.sourceObjectKey ? { source_object_key: opts.sourceObjectKey } : {}),
      ...(opts.importKey ? { import_key: opts.importKey } : {}),
    }));
    const importKey = opts.importKey;
    if (importKey) {
      // 원자 replay — advisory **xact** lock으로 같은 (trip,member,import_key) 동시 삽입을 직렬화한다.
      // 미들웨어 single-flight에 의존하지 않고 DB 레벨에서 배치 중복을 막는다(미들웨어 부재/우회에도 안전).
      return this.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`draft-import:${tripId}:${memberId}:${importKey}`}, 0))`,
        );
        // 이 키가 **한 번이라도** 처리됐는지는 삭제 포함으로 판정 — discard된 배치를 재시도가 부활시키지 않게(리뷰 CC).
        const processed = await tx
          .select({ id: expenseDrafts.id })
          .from(expenseDrafts)
          .where(
            and(
              eq(expenseDrafts.trip_id, tripId),
              eq(expenseDrafts.created_by_member_id, memberId),
              eq(expenseDrafts.import_key, importKey),
            ),
          )
          .limit(1);
        if (processed.length > 0) {
          // 이미 처리됨 → 재삽입 금지. 현재 살아있는(비삭제) 초안만 반환(일부·전부 discard됐으면 그만큼 적게/빈).
          const active = await tx
            .select(COLS)
            .from(expenseDrafts)
            .where(
              and(
                eq(expenseDrafts.trip_id, tripId),
                eq(expenseDrafts.created_by_member_id, memberId),
                eq(expenseDrafts.import_key, importKey),
                isNull(expenseDrafts.deleted_at),
              ),
            )
            .orderBy(desc(expenseDrafts.created_at));
          return active as DraftRow[];
        }
        const inserted = await tx.insert(expenseDrafts).values(values).returning(COLS);
        return inserted as DraftRow[];
      });
    }
    const rows = await this.db.insert(expenseDrafts).values(values).returning(COLS);
    return rows as DraftRow[];
  }

  async listPending(tripId: string, memberId: string): Promise<DraftRow[]> {
    // 검토 큐 — pending(신규) + **confirmed-미링크**(인프라 실패로 확정 중단된 in-progress; 재-confirm으로 복구).
    // 후자를 노출하지 않으면 재로드 후 초안이 사라져 재시도 경로를 잃는다(리뷰 Z). confirmed-링크·discarded는 제외.
    const rows = await this.db
      .select(COLS)
      .from(expenseDrafts)
      .where(
        and(
          eq(expenseDrafts.trip_id, tripId),
          eq(expenseDrafts.created_by_member_id, memberId),
          isNull(expenseDrafts.deleted_at),
          or(
            eq(expenseDrafts.status, "pending"),
            and(eq(expenseDrafts.status, "confirmed"), isNull(expenseDrafts.confirmed_expense_id)),
          ),
        ),
      )
      .orderBy(desc(expenseDrafts.created_at));
    return rows as DraftRow[];
  }

  async findById(tripId: string, memberId: string, id: string): Promise<DraftRow | null> {
    const rows = await this.db
      .select(COLS)
      .from(expenseDrafts)
      .where(this.owned(tripId, memberId, id));
    return (rows[0] ?? null) as DraftRow | null;
  }

  async updatePayload(
    tripId: string,
    memberId: string,
    id: string,
    payload: UsageDraft,
  ): Promise<DraftRow | null> {
    const rows = await this.db
      .update(expenseDrafts)
      .set({ payload, confidence: String(payload.confidence) })
      .where(
        and(
          eq(expenseDrafts.trip_id, tripId),
          eq(expenseDrafts.created_by_member_id, memberId),
          eq(expenseDrafts.id, id),
          eq(expenseDrafts.status, "pending"), // 확정/삭제된 초안은 편집 불가
          isNull(expenseDrafts.deleted_at),
        ),
      )
      .returning(COLS);
    return (rows[0] ?? null) as DraftRow | null;
  }

  async claimForConfirm(
    tripId: string,
    memberId: string,
    id: string,
    completion: ConfirmExpenseDraft,
  ): Promise<DraftRow | null> {
    // pending → confirmed 원자 전이(동시 confirm 방지). 한 요청만 성공.
    // RETURNING으로 클레임 시점의 커밋 payload를 함께 반환 — 이후 confirm은 이 값 사용(선행 PATCH와의 stale 창 제거).
    // confirm_payload에 확정 body를 원자 바인딩 — 복구·경합 시 최초 claim한 body만 결정적으로 재사용.
    const rows = await this.db
      .update(expenseDrafts)
      .set({ status: "confirmed", confirm_payload: completion })
      .where(
        and(
          eq(expenseDrafts.trip_id, tripId),
          eq(expenseDrafts.created_by_member_id, memberId),
          eq(expenseDrafts.id, id),
          eq(expenseDrafts.status, "pending"),
          isNull(expenseDrafts.deleted_at),
        ),
      )
      .returning(COLS);
    return (rows[0] ?? null) as DraftRow | null;
  }

  async setConfirmedExpense(
    tripId: string,
    memberId: string,
    id: string,
    expenseId: string,
  ): Promise<void> {
    // **confirmed·미삭제 행만** 링크 — 경합으로 그 사이 pending 롤백/삭제됐으면 no-op(pending+링크된 유령행 방지).
    // 그 경우 지출은 고아로 남고 다음 confirm(재클레임→멱등 replay)이 정상 재링크한다.
    await this.db
      .update(expenseDrafts)
      .set({ confirmed_expense_id: expenseId })
      .where(
        and(
          eq(expenseDrafts.trip_id, tripId),
          eq(expenseDrafts.created_by_member_id, memberId),
          eq(expenseDrafts.id, id),
          eq(expenseDrafts.status, "confirmed"),
          isNull(expenseDrafts.deleted_at),
        ),
      );
  }

  async revertToPending(tripId: string, memberId: string, id: string): Promise<void> {
    // 정의적 도메인 실패 후 pending 롤백 — **미링크 confirmed만**(지출이 링크된 행은 절대 안 건드림, 고아/stale 방지).
    await this.db
      .update(expenseDrafts)
      .set({ status: "pending" })
      .where(
        and(
          eq(expenseDrafts.trip_id, tripId),
          eq(expenseDrafts.created_by_member_id, memberId),
          eq(expenseDrafts.id, id),
          eq(expenseDrafts.status, "confirmed"),
          isNull(expenseDrafts.confirmed_expense_id),
          isNull(expenseDrafts.deleted_at),
        ),
      );
  }

  async softDelete(tripId: string, memberId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .update(expenseDrafts)
      .set({ status: "discarded", deleted_at: new Date() })
      .where(
        and(
          eq(expenseDrafts.trip_id, tripId),
          eq(expenseDrafts.created_by_member_id, memberId),
          eq(expenseDrafts.id, id),
          eq(expenseDrafts.status, "pending"), // 확정된 초안은 삭제 불가
          isNull(expenseDrafts.confirmed_expense_id), // 지출이 링크된 초안은 삭제 불가(경합 유령행 방어)
          isNull(expenseDrafts.deleted_at),
        ),
      )
      .returning({ id: expenseDrafts.id });
    return rows.length > 0;
  }
}
