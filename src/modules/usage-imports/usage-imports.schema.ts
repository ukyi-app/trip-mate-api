import { z } from "@hono/zod-openapi";
import { CATEGORY, PAYMENT, minorString } from "../expenses/expenses.schema.ts";

/** 파싱 요청. text 4K 상한 = LLM 비용 상한 겸. reference_date는 연도 없는 날짜 해석 기준일(미전달 시 서버 오늘). */
export const usageParseRequestSchema = z
  .object({
    text: z.string().min(1).max(4_000),
    reference_date: z.iso.date().optional(),
    // 외부 파서(LLM)로 **사용내역 텍스트 + 해당 여행의 기간·timezone**을 전송하는 것에 사용자가 동의했음을
    // FE가 보증 — true가 아니면 422. (여행 기간·timezone은 날짜 보정용이며 카드 텍스트에서 도출 가능한 최소 정보.)
    // 키 오배포로 기능이 켜져도 고지 UI 없는 클라이언트는 이 계약에서 걸린다(설계 §트러스트 바운더리).
    disclosure_accepted: z.literal(true),
  })
  .openapi("UsageParseRequest");

/** 지출 초안 필드(refine 이전 순수 object) — expense-drafts가 .extend()/.partial()로 재사용. */
export const usageDraftFields = z.object({
  title: z.string().min(1).max(200),
  local_amount: minorString,
  local_currency: z.string().length(3),
  spent_at: z.iso.datetime(),
  category: z.enum(CATEGORY).optional(),
  payment_method: z.enum(PAYMENT).optional(),
  // 해외승인 SMS에 병기된 카드 청구/승인 금액+통화(보통 KRW). CreateExpense.card_billed_settlement_amount로의
  // 매핑은 trip 정산통화를 아는 FE가 통화 일치 확인 후 수행 — 여기서 정산액으로 단정하지 않는다(통화 오염 방지).
  card_billed_amount: minorString.optional(),
  card_billed_currency: z.string().length(3).optional(),
  confidence: z.number().min(0).max(1), // 필드 해석 불확실성(연도 추론·페어링 애매 시 하향)
});

/** card_billed 금액·통화 동반 불변식. object·partial 양쪽에서 재사용(부분수정 후 병합 검증). */
export const cardBilledPairing = (d: {
  card_billed_amount?: string | undefined;
  card_billed_currency?: string | undefined;
}) => (d.card_billed_amount === undefined) === (d.card_billed_currency === undefined);

/** 지출 초안 — CreateExpense 호환 서브셋(+confidence). FE가 확인/편집 후 기존 create로 확정. */
export const usageDraftSchema = usageDraftFields
  .refine(cardBilledPairing, {
    message: "card_billed_amount and card_billed_currency must come together",
    path: ["card_billed_amount"],
  })
  .openapi("UsageDraft");

export const usageParseResponseSchema = z
  .object({ drafts: z.array(usageDraftSchema) })
  .openapi("UsageParseResponse");

export type UsageDraft = z.infer<typeof usageDraftSchema>;
