import { z } from "@hono/zod-openapi";

const minorSigned = z.string().regex(/^-?\d+$/); // net은 음수 가능

export const transferResponseSchema = z
  .object({
    id: z.string().uuid(),
    basis: z.enum(["settlement", "local"]),
    currency: z.string(),
    from_member_id: z.string().uuid(),
    to_member_id: z.string().uuid(),
    amount: z.string().regex(/^\d+$/),
    payment_status: z.enum(["pending", "paid"]),
    paid_at: z.string().nullable(),
  })
  .openapi("SettlementTransfer");

export const summaryResponseSchema = z
  .object({
    member_id: z.string().uuid(),
    basis: z.enum(["settlement", "local"]),
    currency: z.string(),
    total_paid: minorSigned,
    total_share: minorSigned,
    net_amount: minorSigned,
  })
  .openapi("SettlementSummary");

const seenVersionSchema = z.object({ expense_id: z.string().uuid(), version: z.number().int() });

export const settlementResponseSchema = z
  .object({
    trip_id: z.string().uuid(),
    settlement_status: z.enum(["open", "finalized"]),
    version: z.number().int().nullable(), // active 스냅샷 version(없으면 null)
    settlement_total: z.string().regex(/^\d+$/),
    seen_versions: z.array(seenVersionSchema),
    transfers: z.array(transferResponseSchema),
    summaries: z.array(summaryResponseSchema),
    currency_totals: z.array(
      z.object({ currency: z.string(), total_amount: z.string().regex(/^\d+$/) }),
    ),
  })
  .openapi("Settlement");

export const precheckResponseSchema = z
  .object({
    finalizable: z.boolean(),
    reasons: z.array(z.string()),
    settlement_total: z.string().regex(/^\d+$/),
    seen_versions: z.array(seenVersionSchema),
  })
  .openapi("SettlementPrecheck");

export const finalizeRequestSchema = z
  .object({ seen_expense_versions: z.array(seenVersionSchema).min(0) })
  .openapi("FinalizeSettlement");

export type SettlementResponse = z.infer<typeof settlementResponseSchema>;
export type FinalizeRequest = z.infer<typeof finalizeRequestSchema>;
