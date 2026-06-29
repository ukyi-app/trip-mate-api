import { z } from "@hono/zod-openapi";

// 최소단위 string(D1). 음수 없음(환불=후속). max 19자 + BIGINT 범위 refine(finding #2 pass3 — 무한 길이/오버플로 차단).
const BIGINT_MAX = 9223372036854775807n;
const minorString = z
  .string()
  .regex(/^\d+$/)
  .max(19)
  .refine((s) => BigInt(s) <= BIGINT_MAX, { message: "amount out of BIGINT range" });
const STATE = ["included", "personal", "record_only"] as const;
const PAYMENT = ["cash", "card", "transit_card", "easy_pay", "other"] as const;
const CATEGORY = [
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
    expense_settlement_state: z.enum(STATE).optional(),
  })
  .openapi("CreateExpense");

// 메타+참여자만(FX 불변, 편집재계산=후속). version 필수 CAS echo.
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
  })
  .openapi("UpdateExpense");

export type ExpenseResponse = z.infer<typeof expenseResponseSchema>;
export type CreateExpense = z.infer<typeof createExpenseSchema>;
export type UpdateExpense = z.infer<typeof updateExpenseSchema>;
