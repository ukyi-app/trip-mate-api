import { z } from "@hono/zod-openapi";

/** 통화 참조 데이터 응답(FE가 local_amount 표시/입력에 쓰는 minor_unit SSOT).
 *  minor_unit은 의도적으로 plain integer NUMBER — 소수 자릿수(0/2)의 COUNT이지 금액이 아니므로
 *  repo의 "돈은 string" 규칙이 적용되지 않는다.
 *  iso_exponent는 스키마에 절대 노출하지 않는다(minor_unit이 SSOT — TWD iso=2 vs minor=0 혼동 방지). */
export const currencyResponseSchema = z
  .object({
    code: z.string(),
    minor_unit: z.number().int(),
    symbol: z.string(),
  })
  .openapi("Currency");
