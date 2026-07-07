import { AppError, ConflictError, NotFoundError } from "../../core/errors.ts";
import { RESERVED_IDEMPOTENCY_PREFIX } from "../../core/idempotency.ts";
import type { CreateExpense } from "../expenses/expenses.schema.ts";
import type { UsageDraft } from "../usage-imports/usage-imports.schema.ts";
import type {
  ConfirmExpenseDraft,
  ExpenseDraftResponse,
  UpdateExpenseDraft,
} from "./expense-drafts.schema.ts";
import type { DraftRepo, DraftRow } from "./expense-drafts.repo.ts";

/** DraftRow → 응답 DTO(파싱 필드 flatten + 지속 메타). 컨트롤러·parse 지속 배선 공용. */
export function toDraftResponse(r: DraftRow): ExpenseDraftResponse {
  return {
    ...r.payload,
    id: r.id,
    source: r.source,
    status: r.status,
    confirmed_expense_id: r.confirmed_expense_id,
  };
}

/** 지출 생성 포트(테스트 fake 주입) — 기존 ExpensesService.createExpense 재사용. */
export interface ExpenseCreator {
  createExpense(
    tripId: string,
    input: CreateExpense,
    actor: { memberId: string },
    idempotencyKey?: string,
  ): Promise<{ id: string }>;
  // 멱등키로 지출 존재 조회 — 롤백 전 "지출 미생성" 증명(동시 생성분 회수). 미구현 fake는 롤백만.
  findExpenseIdByKey?(tripId: string, memberId: string, key: string): Promise<string | null>;
}

/** 초안 payload + confirm 완성필드 → CreateExpense(순수). 초안이 title·금액·통화·일시·category·결제수단 프리필. */
export function buildCreateExpense(payload: UsageDraft, c: ConfirmExpenseDraft): CreateExpense {
  return {
    title: payload.title,
    local_amount: payload.local_amount,
    local_currency: payload.local_currency,
    spent_at: payload.spent_at,
    category: c.category ?? payload.category ?? "other",
    payment_method: c.payment_method ?? payload.payment_method ?? "card",
    paid_by_member_id: c.paid_by_member_id,
    participant_member_ids: c.participant_member_ids,
    ...(c.memo !== undefined ? { memo: c.memo } : {}),
    ...(c.manualRate !== undefined ? { manualRate: c.manualRate } : {}),
    ...(c.card_billed_settlement_amount !== undefined
      ? { card_billed_settlement_amount: c.card_billed_settlement_amount }
      : {}),
    ...(c.expense_settlement_state !== undefined
      ? { expense_settlement_state: c.expense_settlement_state }
      : {}),
  };
}

export class ExpenseDraftsService {
  constructor(
    private readonly repo: DraftRepo,
    private readonly expenses: ExpenseCreator,
  ) {}

  saveDrafts(
    tripId: string,
    memberId: string,
    drafts: UsageDraft[],
    source: "text" | "image",
    opts: { sourceObjectKey?: string; importKey?: string } = {},
  ): Promise<DraftRow[]> {
    return this.repo.createMany(tripId, memberId, drafts, source, opts);
  }

  listDrafts(tripId: string, memberId: string): Promise<DraftRow[]> {
    return this.repo.listPending(tripId, memberId);
  }

  async updateDraft(
    tripId: string,
    memberId: string,
    id: string,
    patch: UpdateExpenseDraft,
  ): Promise<DraftRow> {
    const draft = await this.repo.findById(tripId, memberId, id);
    if (!draft) throw new NotFoundError("draft not found");
    if (draft.status !== "pending") throw new ConflictError("draft not editable");
    const merged = { ...draft.payload, ...patch } as UsageDraft;
    const updated = await this.repo.updatePayload(tripId, memberId, id, merged);
    if (!updated) throw new ConflictError("draft not editable");
    return updated;
  }

  /**
   * confirm: pending→confirmed 원자 클레임(payload 원자 반환) → 기존 지출 생성 재사용 → expense 링크.
   * 소유자 전용: 초안은 가져온 멤버의 개인 큐 — actor.memberId로 스코프(타 멤버는 404). 이 단일-소유 불변식이
   *   교차-멤버 중복 확정을 원천 차단한다.
   * 멱등·복구·경합:
   *  - 확정+링크됨 → 지출 재생성 없이 리플레이(응답 유실 재시도 안전).
   *  - 확정+미링크(부분 실패·크래시 잔여) → **복구**: 같은 멱등키(draft:<id>)로 createExpense 재실행 →
   *    선행 성공분은 dedup(같은 소유자)되어 동일 지출 반환, 미생성분은 새로 생성 → 재링크. 중복 없음.
   *  - 확정 body는 **claim 시점에 바인딩(confirm_payload)** → 복구·경합에서 항상 최초 claim한 body만 사용
   *    (동시에 다른 body로 confirm해도 지출을 뒤엎지 못함, 리뷰 high). 요청 body는 그때만 fallback.
   *  - createExpense 자체 실패(지출 미생성)만 pending 롤백 — 롤백+재확정이 중복 지출을 낳는 경로는 없다.
   */
  async confirmDraft(
    tripId: string,
    id: string,
    completion: ConfirmExpenseDraft,
    actor: { memberId: string },
  ): Promise<{ draftId: string; expenseId: string }> {
    const member = actor.memberId;
    const draft = await this.repo.findById(tripId, member, id);
    if (!draft) throw new NotFoundError("draft not found"); // 부재 또는 비소유 → 404(존재 누출 방지)
    if (draft.status === "discarded") throw new ConflictError("draft discarded");
    if (draft.status === "confirmed")
      return draft.confirmed_expense_id
        ? { draftId: id, expenseId: draft.confirmed_expense_id } // 리플레이
        : this.createAndLink(tripId, id, draft.payload, draft.confirm_payload ?? completion, actor); // 미링크 복구(바인딩 body)
    // pending — 원자 클레임(커밋 payload 반환 + 확정 body 바인딩). 경합 패배 시 승자 결과 리플레이/복구.
    const claimed = await this.repo.claimForConfirm(tripId, member, id, completion);
    if (!claimed) {
      const after = await this.repo.findById(tripId, member, id);
      if (after?.status === "confirmed")
        return after.confirmed_expense_id
          ? { draftId: id, expenseId: after.confirmed_expense_id }
          : this.createAndLink(
              tripId,
              id,
              after.payload,
              after.confirm_payload ?? completion,
              actor,
            );
      throw new ConflictError("draft already confirmed or discarded");
    }
    // 승자 — claim이 바인딩한 body(claimed.confirm_payload)를 사용(= 이번 completion, 명시적으로 방어).
    return this.createAndLink(
      tripId,
      id,
      claimed.payload,
      claimed.confirm_payload ?? completion,
      actor,
    );
  }

  /**
   * confirmed 상태에서 지출 생성(멱등키 draft:<id>) → 링크. 최초 실패 시 같은 키로 1회 멱등 재시도(replay) —
   * 커밋 후 관측 실패였다면 기존 지출을 회수해 링크(편집 유실·중복·고아 방지).
   *
   * 롤백은 **에러 종류로 구분**(리뷰 V vs T·Q의 근본 긴장 해소). pending 롤백은 **모든 시도가 정의적 도메인
   * 실패(AppError)** 였을 때만 — 그래야 지출이 확정적으로 미생성이라 안전하다(사용자 편집·재확정, 리뷰 V):
   *  - 한 시도라도 모호한 인프라 실패(비-AppError: conn/timeout)면 그 시도가 **커밋했을 수 있으므로** 롤백 금지
   *    (뒤 시도가 AppError여도 마찬가지 — 리뷰 BB). 초안을 confirmed-미링크로 두고 에러 전파 → 재-confirm(복구
   *    경로)이 멱등 replay로 결국 링크(리뷰 T·Q). 미링크 초안은 목록에 노출돼 재시도 가능(리뷰 Z).
   */
  private async createAndLink(
    tripId: string,
    id: string,
    payload: UsageDraft,
    completion: ConfirmExpenseDraft,
    actor: { memberId: string },
  ): Promise<{ draftId: string; expenseId: string }> {
    const create = buildCreateExpense(payload, completion);
    // 서버 전용 네임스페이스 — 클라 키가 이 프리픽스를 못 써 오링크 차단(리뷰 X2).
    const idemKey = `${RESERVED_IDEMPOTENCY_PREFIX}${id}`;
    let sawAmbiguous = false; // 한 시도라도 커밋 가능성(비-AppError)이 있었나 → 롤백 금지 신호
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const expense = await this.expenses.createExpense(tripId, create, actor, idemKey);
        // best-effort 링크 — 실패해도 confirmed 유지(다음 confirm이 미링크 복구 경로로 재링크).
        await this.repo.setConfirmedExpense(tripId, actor.memberId, id, expense.id).catch(() => {});
        return { draftId: id, expenseId: expense.id };
      } catch (e) {
        lastErr = e;
        if (!(e instanceof AppError)) sawAmbiguous = true; // 이 시도가 커밋했을 수 있음
        // 첫 실패 → 멱등 replay 재시도(커밋 후 관측 실패면 기존 지출 회수).
      }
    }
    // 둘 다 실패. **롤백 전 "지출 미생성"을 증명**한다(리뷰 DD): 동시 confirmer가 같은 키로 이미 만들었으면
    // 롤백 대신 그 지출을 링크해 성공 — pending+고아 지출 노출을 막는다.
    const existingId =
      (await this.expenses
        .findExpenseIdByKey?.(tripId, actor.memberId, idemKey)
        .catch(() => null)) ?? null;
    if (existingId) {
      await this.repo.setConfirmedExpense(tripId, actor.memberId, id, existingId).catch(() => {});
      return { draftId: id, expenseId: existingId };
    }
    // 지출 없음. **모든 시도가 AppError(확정적 미생성)** 일 때만 롤백 — 애매한 시도가 있었으면 고아 회피 위해 유지.
    if (!sawAmbiguous) await this.repo.revertToPending(tripId, actor.memberId, id).catch(() => {});
    throw lastErr;
  }

  async discardDraft(tripId: string, memberId: string, id: string): Promise<void> {
    const ok = await this.repo.softDelete(tripId, memberId, id);
    if (!ok) throw new NotFoundError("draft not found or not pending");
  }
}
