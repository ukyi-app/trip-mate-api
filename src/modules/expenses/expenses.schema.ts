import { z } from "@hono/zod-openapi";

// 최소단위 string(D1). 음수 없음(환불=후속). max 19자 + BIGINT 범위 refine(finding #2 pass3 — 무한 길이/오버플로 차단).
// minorString·PAYMENT·CATEGORY는 usage-imports(지출 초안 파싱)도 공유 — export.
const BIGINT_MAX = 9223372036854775807n;
export const minorString = z
  .string()
  .regex(/^\d+$/)
  .max(19)
  // regex 실패 후에도 refine이 실행되므로(zod v4) BigInt("65.00") throw → 500 방지: 숫자 재확인 가드
  .refine((s) => /^\d+$/.test(s) && BigInt(s) <= BIGINT_MAX, {
    message: "amount out of BIGINT range",
  });
const STATE = ["included", "personal", "record_only"] as const;
export const PAYMENT = ["cash", "card", "transit_card", "easy_pay", "other"] as const;
export const CATEGORY = [
  "food",
  "cafe_snack",
  "transport",
  "lodging",
  "shopping",
  "sightseeing",
  "convenience",
  "other",
] as const;

export const expenseResponseSchema = z
  .object({
    id: z.string().uuid(),
    trip_id: z.string().uuid(),
    title: z.string(),
    local_amount: minorString,
    local_currency: z.string(),
    settlement_amount: minorString,
    settlement_currency: z.string(),
    exchange_rate: z.string().nullable(),
    exchange_rate_source: z
      .enum(["identity", "manual", "auto", "last_known", "trip_default"])
      .nullable(),
    settlement_amount_source: z.enum(["converted", "card_billed"]),
    payment_method: z.string(),
    category: z.string(),
    paid_by_member_id: z.string().uuid(),
    participant_member_ids: z.array(z.string().uuid()),
    spent_at: z.string(),
    expense_settlement_state: z.enum(STATE),
    memo: z.string().nullable(),
    version: z.number().int(),
  })
  .openapi("Expense");

export const createExpenseSchema = z
  .object({
    title: z.string().min(1).max(200),
    local_amount: minorString,
    local_currency: z.string().length(3),
    spent_at: z.iso.datetime(), // ISO timestamp
    paid_by_member_id: z.string().uuid(),
    participant_member_ids: z
      .array(z.string().uuid())
      .min(1)
      .refine((a) => new Set(a).size === a.length, { message: "duplicate participant" }), // PK(expense_id,member_id) 23505 선차단(finding #3 pass2)
    payment_method: z.enum(PAYMENT),
    category: z.enum(CATEGORY),
    memo: z.string().max(1000).optional(),
    manualRate: z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .max(24)
      .optional(), // major→major, 길이 경계(finding #2 pass3)
    card_billed_settlement_amount: minorString.optional(), // 존재 시 card_billed 모드(카드 청구액=정산액)
    expense_settlement_state: z.enum(STATE).optional(),
  })
  .refine((d) => !(d.card_billed_settlement_amount !== undefined && d.manualRate !== undefined), {
    message: "card_billed and manualRate are mutually exclusive",
    path: ["card_billed_settlement_amount"],
  })
  .openapi("CreateExpense");

// 편집재계산: 메타+참여자 + FX 영향 필드. version 필수 CAS echo.
export const updateExpenseSchema = z
  .object({
    version: z.number().int(),
    title: z.string().min(1).max(200).optional(),
    payment_method: z.enum(PAYMENT).optional(),
    category: z.enum(CATEGORY).optional(),
    memo: z.string().max(1000).nullable().optional(),
    participant_member_ids: z
      .array(z.string().uuid())
      .min(1)
      .refine((a) => new Set(a).size === a.length, { message: "duplicate participant" })
      .optional(), // finding #3 pass2
    expense_settlement_state: z.enum(STATE).optional(),
    local_amount: minorString.optional(),
    local_currency: z.string().length(3).optional(),
    spent_at: z.iso.datetime().optional(),
    manualRate: z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .max(24)
      .optional(),
    card_billed_settlement_amount: minorString.optional(),
  })
  .refine((d) => !(d.card_billed_settlement_amount !== undefined && d.manualRate !== undefined), {
    message: "card_billed and manualRate are mutually exclusive",
    path: ["card_billed_settlement_amount"],
  })
  .openapi("UpdateExpense");

// needs_manual=true면 settlement_amount·source·per_member 미정 → nullable/빈배열(finding #1 pass1).
export const previewResponseSchema = z
  .object({
    needs_manual: z.boolean(),
    settlement_amount: z.string().regex(/^\d+$/).nullable(),
    settlement_currency: z.string(),
    exchange_rate: z.string().nullable(),
    exchange_rate_source: z
      .enum(["identity", "manual", "auto", "last_known", "trip_default"])
      .nullable(),
    settlement_amount_source: z.enum(["converted", "card_billed"]).nullable(),
    fallbackWarning: z.boolean(),
    per_member: z.array(
      z.object({ member_id: z.string().uuid(), share: z.string().regex(/^\d+$/) }),
    ),
  })
  .openapi("ExpensePreview");

export const fxDefaultRequestSchema = z
  .object({
    base_currency: z.string().length(3),
    settlement_currency: z.string().length(3),
    rate: z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .max(24),
  })
  .openapi("SetTripFxDefault");

// 목록 쿼리(api-contract §6): keyset 커서 + limit + 필터. currency=local_currency.
export const listExpensesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
  category: z.enum(CATEGORY).optional(),
  payment_method: z.enum(PAYMENT).optional(),
  currency: z.string().length(3).optional(),
  member: z.string().uuid().optional(),
  state: z.enum(STATE).optional(),
});

// 목록 응답: items + 다음 페이지 커서(없으면 null = 마지막 페이지).
export const expenseListResponseSchema = z
  .object({
    items: z.array(expenseResponseSchema),
    next_cursor: z.string().nullable(),
  })
  .openapi("ExpenseList");

export type ExpenseResponse = z.infer<typeof expenseResponseSchema>;
export type ListExpensesQuery = z.infer<typeof listExpensesQuerySchema>;
export type CreateExpense = z.infer<typeof createExpenseSchema>;
export type UpdateExpense = z.infer<typeof updateExpenseSchema>;
export type PreviewResponse = z.infer<typeof previewResponseSchema>;
