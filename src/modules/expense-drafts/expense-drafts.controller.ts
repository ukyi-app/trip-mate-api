import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { requireAuth, requireTripMember } from "../../core/guards.ts";
import type { MembershipLookup, SessionResolver } from "../../core/guards.ts";
import { errorResponses } from "../../core/http.ts";
import {
  confirmDraftSchema,
  expenseDraftListSchema,
  expenseDraftResponseSchema,
  updateDraftSchema,
} from "./expense-drafts.schema.ts";
import { toDraftResponse } from "./expense-drafts.service.ts";
import type { ExpenseDraftsService } from "./expense-drafts.service.ts";

interface Deps {
  service: ExpenseDraftsService;
  resolver: SessionResolver;
  memberLookup: MembershipLookup;
}

const ok = <S extends z.ZodTypeAny>(schema: S) => ({
  200: { description: "ok", content: { "application/json": { schema } } },
});
const jsonBody = <S extends z.ZodTypeAny>(schema: S) => ({
  content: { "application/json": { schema } },
  required: true,
});

export function registerExpenseDraftRoutes(app: OpenAPIHono, deps: Deps): void {
  const auth = requireAuth(deps.resolver);
  const member = requireTripMember(deps.memberLookup);
  const params = z.object({ tripId: z.string().uuid(), draftId: z.string().uuid() });

  app.openapi(
    createRoute({
      method: "get",
      path: "/trips/{tripId}/expense-drafts",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member],
      request: { params: z.object({ tripId: z.string().uuid() }) },
      responses: { ...ok(expenseDraftListSchema), ...errorResponses(403, 404) },
    }),
    async (c) => {
      // 초안은 가져온 멤버의 개인 큐 — 본인 것만 조회.
      const drafts = await deps.service.listDrafts(
        c.req.valid("param").tripId,
        c.get("membership").id,
      );
      return c.json({ drafts: drafts.map(toDraftResponse) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/trips/{tripId}/expense-drafts/{draftId}",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member],
      request: { params, body: jsonBody(updateDraftSchema) },
      responses: { ...ok(expenseDraftResponseSchema), ...errorResponses(403, 404, 409, 422) },
    }),
    async (c) => {
      const { tripId, draftId } = c.req.valid("param");
      const updated = await deps.service.updateDraft(
        tripId,
        c.get("membership").id,
        draftId,
        c.req.valid("json"),
      );
      return c.json(toDraftResponse(updated), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/trips/{tripId}/expense-drafts/{draftId}/confirm",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member],
      request: { params, body: jsonBody(confirmDraftSchema) },
      responses: {
        200: {
          description: "confirmed",
          content: {
            "application/json": {
              schema: z
                .object({ draft_id: z.string().uuid(), expense_id: z.string().uuid() })
                .openapi("ConfirmDraftResult"),
            },
          },
        },
        ...errorResponses(403, 404, 409, 422),
      },
    }),
    async (c) => {
      const { tripId, draftId } = c.req.valid("param");
      const r = await deps.service.confirmDraft(tripId, draftId, c.req.valid("json"), {
        memberId: c.get("membership").id,
      });
      return c.json({ draft_id: r.draftId, expense_id: r.expenseId }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/trips/{tripId}/expense-drafts/{draftId}",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member],
      request: { params },
      responses: {
        200: {
          description: "discarded",
          content: {
            "application/json": {
              schema: z
                .object({ id: z.string().uuid(), discarded: z.literal(true) })
                .openapi("DiscardDraftResult"),
            },
          },
        },
        ...errorResponses(403, 404),
      },
    }),
    async (c) => {
      const { tripId, draftId } = c.req.valid("param");
      await deps.service.discardDraft(tripId, c.get("membership").id, draftId);
      return c.json({ id: draftId, discarded: true as const }, 200);
    },
  );
}
