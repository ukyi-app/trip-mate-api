import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  requireAuth,
  requireTripMember,
  type SessionResolver,
  type MembershipLookup,
} from "../../core/guards.ts";
import { errorResponses, idempotencyKeyHeader } from "../../core/http.ts";
import { idempotency, type IdempotencyStore } from "../../core/idempotency.ts";
import {
  settlementResponseSchema,
  precheckResponseSchema,
  finalizeRequestSchema,
  settlementHistoryEntrySchema,
  transferEventSchema,
} from "./settlements.schema.ts";
import type { SettlementsService } from "./settlements.service.ts";

interface Deps {
  settlementsService: SettlementsService<Record<string, unknown>>;
  resolver: SessionResolver;
  memberLookup: MembershipLookup;
  idempotencyStore: IdempotencyStore | null;
}
const ok = <S extends z.ZodTypeAny>(schema: S) => ({
  200: { description: "ok", content: { "application/json": { schema } } },
});
const jsonBody = <S extends z.ZodTypeAny>(schema: S) => ({
  content: { "application/json": { schema } },
  required: true,
});

const markPaidResponse = z
  .object({ transferId: z.string(), payment_status: z.string() })
  .openapi("MarkPaidResult");
const markUnpaidResponse = z
  .object({ transferId: z.string(), payment_status: z.string() })
  .openapi("MarkUnpaidResult");

export function registerSettlementRoutes(app: OpenAPIHono, deps: Deps): void {
  const auth = requireAuth(deps.resolver);
  const member = requireTripMember(deps.memberLookup);
  const admin = requireTripMember(deps.memberLookup, "admin");
  const idem = deps.idempotencyStore ? [idempotency(deps.idempotencyStore)] : []; // finalize/unlock/mark-paid 재시도 replay(finding #1 pass3)
  const actorOf = (c: { get: (k: "membership") => { id: string; role: string } }) => ({
    memberId: c.get("membership").id,
    role: c.get("membership").role,
  });

  app.openapi(
    createRoute({
      method: "get",
      path: "/trips/{tripId}/settlement",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member],
      request: { params: z.object({ tripId: z.string().uuid() }) },
      responses: { ...ok(settlementResponseSchema), ...errorResponses(403, 404) },
    }),
    async (c) =>
      c.json(await deps.settlementsService.getSettlement(c.req.valid("param").tripId), 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/trips/{tripId}/settlement/precheck",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member],
      request: { params: z.object({ tripId: z.string().uuid() }) },
      responses: { ...ok(precheckResponseSchema), ...errorResponses(403, 404) },
    }),
    async (c) => c.json(await deps.settlementsService.precheck(c.req.valid("param").tripId), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/trips/{tripId}/settlement/finalize",
      security: [{ cookieAuth: [] }],
      middleware: [auth, admin, ...idem],
      request: {
        params: z.object({ tripId: z.string().uuid() }),
        headers: idempotencyKeyHeader,
        body: jsonBody(finalizeRequestSchema),
      },
      responses: { ...ok(settlementResponseSchema), ...errorResponses(403, 404, 409, 422) },
    }),
    async (c) => {
      const r = await deps.settlementsService.finalize(
        c.req.valid("param").tripId,
        c.req.valid("json").seen_expense_versions,
        actorOf(c),
      );
      return c.json(r, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/trips/{tripId}/settlement/unlock",
      security: [{ cookieAuth: [] }],
      middleware: [auth, admin, ...idem],
      request: {
        params: z.object({ tripId: z.string().uuid() }),
        headers: idempotencyKeyHeader,
      },
      responses: { ...ok(settlementResponseSchema), ...errorResponses(403, 404, 409, 422) },
    }),
    async (c) => {
      const tripId = c.req.valid("param").tripId;
      await deps.settlementsService.unlock(tripId, actorOf(c));
      return c.json(await deps.settlementsService.getSettlement(tripId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/trips/{tripId}/settlement/transfers/{transferId}/mark-paid",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member, ...idem],
      request: {
        params: z.object({ tripId: z.string().uuid(), transferId: z.string().uuid() }),
        headers: idempotencyKeyHeader,
      },
      responses: { ...ok(markPaidResponse), ...errorResponses(403, 404, 409, 422) },
    }),
    async (c) => {
      const { tripId, transferId } = c.req.valid("param");
      return c.json(await deps.settlementsService.markPaid(tripId, transferId, actorOf(c)), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/trips/{tripId}/settlement/transfers/{transferId}/mark-unpaid",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member, ...idem],
      request: {
        params: z.object({ tripId: z.string().uuid(), transferId: z.string().uuid() }),
        headers: idempotencyKeyHeader,
      },
      responses: { ...ok(markUnpaidResponse), ...errorResponses(403, 404, 409, 422) },
    }),
    async (c) => {
      const { tripId, transferId } = c.req.valid("param");
      return c.json(await deps.settlementsService.markUnpaid(tripId, transferId, actorOf(c)), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/trips/{tripId}/settlement/history",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member],
      request: { params: z.object({ tripId: z.string().uuid() }) },
      responses: { ...ok(z.array(settlementHistoryEntrySchema)), ...errorResponses(403, 404) },
    }),
    async (c) =>
      c.json(await deps.settlementsService.settlementHistory(c.req.valid("param").tripId), 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/trips/{tripId}/settlement/transfers/{transferId}/events",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member],
      request: { params: z.object({ tripId: z.string().uuid(), transferId: z.string().uuid() }) },
      responses: { ...ok(z.array(transferEventSchema)), ...errorResponses(403, 404) },
    }),
    async (c) => {
      const { tripId, transferId } = c.req.valid("param");
      return c.json(await deps.settlementsService.transferEvents(tripId, transferId), 200);
    },
  );
}
