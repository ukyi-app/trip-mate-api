import { z } from "@hono/zod-openapi";

/** RFC 9457 problem+json (api-contract §3). meta는 선택. */
export const problemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    code: z.string(),
    detail: z.string().optional(),
    meta: z.unknown().optional(),
  })
  .openapi("Problem");

type Status = 400 | 403 | 404 | 409 | 422 | 500;
/** route responses에 펼칠 표준 에러 응답 셋. 예 `...errorResponses(403, 404, 409)`. */
export function errorResponses(...statuses: Status[]) {
  const out: Record<
    number,
    {
      description: string;
      content: { "application/problem+json": { schema: typeof problemSchema } };
    }
  > = {};
  for (const s of statuses) {
    out[s] = {
      description: `${s} problem+json`,
      content: { "application/problem+json": { schema: problemSchema } },
    };
  }
  return out;
}

/** zod 검증 실패를 422 problem+json으로(finding #3 pass1). createApp의 defaultHook이 사용. */
export function problemFromZod(error: { issues?: unknown }) {
  return {
    type: "about:blank",
    title: "ValidationError",
    status: 422,
    code: "ValidationError",
    detail: "input validation failed",
    meta: error.issues,
  };
}

/** 멱등 미들웨어 배선 라우트에만 노출하는 Idempotency-Key 헤더 파라미터(api-contract §4).
 *  .optional()+.max(200)만 사용 — required면 헤더 없는 요청이 422로 기존 no-op을 파괴하고,
 *  배열형은 zValidator에 safeParseAsync 부재로 런타임 크래시가 난다. */
export const idempotencyKeyHeader = z.object({
  "Idempotency-Key": z
    .string()
    .max(200)
    .optional()
    .openapi({
      param: { name: "Idempotency-Key", in: "header" },
      description: "재시도 안전 멱등 키(≤200자). 동일 키 재요청은 저장된 응답을 replay한다.",
      example: "3f1c8b2e-9a44-4c1e-8b0e-2d5f7c6a1b90",
    }),
});
