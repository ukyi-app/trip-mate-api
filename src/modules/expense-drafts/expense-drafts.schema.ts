import { z } from "@hono/zod-openapi";
import { cardBilledPairing, usageDraftFields } from "../usage-imports/usage-imports.schema.ts";

/** 저장된 초안 응답 — 파싱 필드(UsageDraft) + 지속 메타. refine 없는 base에서 확장(저장값은 파싱 시 이미 검증). */
export const expenseDraftResponseSchema = usageDraftFields
  .extend({
    id: z.string().uuid(),
    source: z.enum(["text", "image"]),
    status: z.enum(["pending", "confirmed", "discarded"]),
    confirmed_expense_id: z.string().uuid().nullable(),
  })
  .openapi("ExpenseDraft");

export const expenseDraftListSchema = z
  .object({ drafts: z.array(expenseDraftResponseSchema) })
  .openapi("ExpenseDraftList");

/** 편집 — 파싱 필드 부분 수정(확정 전). card_billed 동반 불변식은 부분수정에도 유지. */
export const updateDraftSchema = usageDraftFields
  .partial()
  .refine(cardBilledPairing, {
    message: "card_billed_amount and card_billed_currency must come together",
    path: ["card_billed_amount"],
  })
  .openapi("UpdateExpenseDraft");

/** 확정 — 파싱이 모르는 필드(결제자·참여자)를 채워 기존 지출 생성으로 확정. 초안의 title·금액·통화·일시는 payload에서. */
export const confirmDraftSchema = z
  .object({
    paid_by_member_id: z.string().uuid(),
    participant_member_ids: z
      .array(z.string().uuid())
      .min(1)
      .refine((a) => new Set(a).size === a.length, { message: "duplicate participant" }),
    category: z
      .enum([
        "food",
        "cafe_snack",
        "transport",
        "lodging",
        "shopping",
        "sightseeing",
        "convenience",
        "other",
      ])
      .optional(), // 미제공 시 초안 category → 기본 "other"
    payment_method: z.enum(["cash", "card", "transit_card", "easy_pay", "other"]).optional(),
    expense_settlement_state: z.enum(["included", "personal", "record_only"]).optional(),
    memo: z.string().max(1000).optional(),
    manualRate: z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .max(24)
      .optional(),
    card_billed_settlement_amount: z.string().regex(/^\d+$/).max(19).optional(), // trip 정산통화 확인 후 FE가 첨부(§card_billed)
  })
  // createExpenseSchema와 동일 불변식 — confirm은 CreateExpense를 직접 구성해 서비스 호출하므로 여기서 재검증.
  // card_billed와 manualRate는 상호배제(둘 다 오면 card_billed 분기가 manualRate를 조용히 무시 → 정산 의미 오염).
  .refine((d) => !(d.card_billed_settlement_amount !== undefined && d.manualRate !== undefined), {
    message: "card_billed and manualRate are mutually exclusive",
    path: ["card_billed_settlement_amount"],
  })
  .openapi("ConfirmExpenseDraft");

export type ExpenseDraftResponse = z.infer<typeof expenseDraftResponseSchema>;
export type UpdateExpenseDraft = z.infer<typeof updateDraftSchema>;
export type ConfirmExpenseDraft = z.infer<typeof confirmDraftSchema>;
