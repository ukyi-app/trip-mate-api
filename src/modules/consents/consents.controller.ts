import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { requireAuth } from "../../core/guards.ts";
import type { SessionResolver } from "../../core/guards.ts";
import { errorResponses } from "../../core/http.ts";
import { clientIp } from "../../core/rate-limit.ts";
import {
  getConsentsResponseSchema,
  postConsentsRequestSchema,
  postConsentsResponseSchema,
} from "./consents.schema.ts";
import type { ConsentRecord } from "./consents.repo.ts";
import type { ConsentService } from "./consents.service.ts";

interface Deps {
  service: ConsentService;
  resolver: SessionResolver;
}

const ok = <S extends z.ZodTypeAny>(schema: S) => ({
  200: { description: "ok", content: { "application/json": { schema } } },
});
const jsonBody = <S extends z.ZodTypeAny>(schema: S) => ({
  content: { "application/json": { schema } },
  required: true,
});

const toDto = (r: ConsentRecord) => ({
  type: r.consent_type,
  version: r.document_version,
  accepted_at: r.accepted_at.toISOString(),
});

export function registerConsentRoutes(app: OpenAPIHono, deps: Deps): void {
  const auth = requireAuth(deps.resolver);

  app.openapi(
    createRoute({
      method: "post",
      path: "/consents",
      security: [{ cookieAuth: [] }],
      middleware: [auth],
      request: { body: jsonBody(postConsentsRequestSchema) },
      responses: { ...ok(postConsentsResponseSchema), ...errorResponses(403, 409, 422) },
    }),
    async (c) => {
      const userId = c.get("user").id;
      const { consents, source } = c.req.valid("json");
      const ip = clientIp(c.req.raw.headers) || undefined;
      const recorded = await deps.service.record(userId, {
        consents,
        source,
        ...(ip ? { ip } : {}),
      });
      return c.json({ recorded: recorded.map(toDto) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/consents",
      security: [{ cookieAuth: [] }],
      middleware: [auth],
      responses: { ...ok(getConsentsResponseSchema), ...errorResponses(403) },
    }),
    async (c) => {
      const userId = c.get("user").id;
      const { current, accepted } = await deps.service.list(userId);
      return c.json({ current, accepted: accepted.map(toDto) }, 200);
    },
  );
}
