import { z } from "@hono/zod-openapi";

export const consentTypeEnum = z.enum(["tos", "privacy", "llm_disclosure"]);
// 클라이언트 지정 시점 — usage_parse는 서버 내부(parse 파이프라인) 전용이라 제외.
export const consentSourceEnum = z.enum(["signup", "invite_accept", "settings"]);

export const postConsentsRequestSchema = z
  .object({
    consents: z
      .array(z.object({ type: consentTypeEnum, version: z.string().min(1).max(64) }))
      .min(1)
      .max(10),
    source: consentSourceEnum,
  })
  .openapi("PostConsentsRequest");

export const consentRecordSchema = z
  .object({ type: consentTypeEnum, version: z.string(), accepted_at: z.string() })
  .openapi("ConsentRecord");

export const postConsentsResponseSchema = z
  .object({ recorded: z.array(consentRecordSchema) })
  .openapi("PostConsentsResponse");

export const getConsentsResponseSchema = z
  .object({
    current: z.object({ tos: z.string(), privacy: z.string(), llm_disclosure: z.string() }),
    accepted: z.array(consentRecordSchema),
  })
  .openapi("GetConsentsResponse");
