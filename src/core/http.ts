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
