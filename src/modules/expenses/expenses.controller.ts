import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  requireAuth,
  requireTripMember,
  type SessionResolver,
  type MembershipLookup,
} from "../../core/guards.ts";
import { errorResponses, idempotencyKeyHeader } from "../../core/http.ts";
import { ValidationError } from "../../core/errors.ts";
import { idempotency, type IdempotencyStore } from "../../core/idempotency.ts";
import { parsePositiveRate } from "../fx/domain/convert.ts";
import type { TripDefaultsPort } from "../fx/fx.types.ts";
import {
  expenseResponseSchema,
  expenseListResponseSchema,
  listExpensesQuerySchema,
  createExpenseSchema,
  updateExpenseSchema,
  previewResponseSchema,
  fxDefaultRequestSchema,
} from "./expenses.schema.ts";
import type { ExpensesService } from "./expenses.service.ts";
import type { ExpenseRow } from "./expenses.repo.ts";

interface Deps {
  expensesService: ExpensesService<Record<string, unknown>>;
  resolver: SessionResolver;
  memberLookup: MembershipLookup;
  idempotencyStore: IdempotencyStore | null; // null이면 멱등 미들웨어 생략(테스트)
  tripDefaults: TripDefaultsPort;
}
const ok = <S extends z.ZodTypeAny>(schema: S) => ({
  200: { description: "ok", content: { "application/json": { schema } } },
});
const jsonBody = <S extends z.ZodTypeAny>(schema: S) => ({
  content: { "application/json": { schema } },
  required: true,
});

function toResponse(row: ExpenseRow): z.infer<typeof expenseResponseSchema> {
  return {
    id: row.id,
    trip_id: row.trip_id,
    title: row.title,
    local_amount: row.local_amount.toString(),
    local_currency: row.local_currency,
    settlement_amount: row.settlement_amount.toString(),
    settlement_currency: row.settlement_currency,
    exchange_rate: row.exchange_rate,
    exchange_rate_source: row.exchange_rate_source,
    settlement_amount_source: row.settlement_amount_source,
    payment_method: row.payment_method,
    category: row.category,
    paid_by_member_id: row.paid_by_member_id,
    participant_member_ids: row.participant_member_ids,
    spent_at: row.spent_at.toISOString(),
    expense_settlement_state: row.expense_settlement_state,
    memo: row.memo,
    version: row.version,
    created_by_member_id: row.created_by_member_id,
    last_modified_by_member_id: row.last_modified_by_member_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function registerExpenseRoutes(app: OpenAPIHono, deps: Deps): void {
  const auth = requireAuth(deps.resolver);
  const member = requireTripMember(deps.memberLookup);
  const admin = requireTripMember(deps.memberLookup, "admin");
  const idem = deps.idempotencyStore ? [idempotency(deps.idempotencyStore)] : []; // scope=c.req.path(실 tripId)

  app.openapi(
    createRoute({
      method: "post",
      path: "/trips/{tripId}/expenses",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member, ...idem],
      request: {
        params: z.object({ tripId: z.string().uuid() }),
        headers: idempotencyKeyHeader,
        body: jsonBody(createExpenseSchema),
      },
      responses: { ...ok(expenseResponseSchema), ...errorResponses(403, 404, 409, 422) },
    }),
    async (c) => {
      const row = await deps.expensesService.createExpense(
        c.req.valid("param").tripId,
        c.req.valid("json"),
        { memberId: c.get("membership").id },
        c.req.header("idempotency-key"), // 멱등 마커(미들웨어 미스/크래시-갭에도 DB-레벨 dedup)
      );
      return c.json(toResponse(row), 200);
    },
  );

  // 미영속 미리보기(FX·균등분할). 멱등 없음, 영속 없음.
  app.openapi(
    createRoute({
      method: "post",
      path: "/trips/{tripId}/expenses/preview",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member],
      request: {
        params: z.object({ tripId: z.string().uuid() }),
        body: jsonBody(createExpenseSchema),
      },
      responses: { ...ok(previewResponseSchema), ...errorResponses(403, 404, 422) },
    }),
    async (c) =>
      c.json(
        await deps.expensesService.previewExpense(c.req.valid("param").tripId, c.req.valid("json")),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/trips/{tripId}/expenses",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member],
      request: {
        params: z.object({ tripId: z.string().uuid() }),
        query: listExpensesQuerySchema,
      },
      responses: { ...ok(expenseListResponseSchema), ...errorResponses(403, 422) },
    }),
    async (c) => {
      const {
        limit,
        cursor,
        category,
        payment_method,
        currency,
        member: memberFilter,
        state,
      } = c.req.valid("query");
      const { items, nextCursor } = await deps.expensesService.listExpenses(
        c.req.valid("param").tripId,
        {
          limit,
          ...(cursor !== undefined ? { cursor } : {}),
          filters: { category, payment_method, currency, member: memberFilter, state },
        },
      );
      return c.json({ items: items.map(toResponse), next_cursor: nextCursor }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/trips/{tripId}/expenses/{expenseId}",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member],
      request: { params: z.object({ tripId: z.string().uuid(), expenseId: z.string().uuid() }) },
      responses: { ...ok(expenseResponseSchema), ...errorResponses(403, 404) },
    }),
    async (c) =>
      c.json(
        toResponse(
          await deps.expensesService.getExpense(
            c.req.valid("param").tripId,
            c.req.valid("param").expenseId,
          ),
        ),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/trips/{tripId}/expenses/{expenseId}",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member],
      request: {
        params: z.object({ tripId: z.string().uuid(), expenseId: z.string().uuid() }),
        body: jsonBody(updateExpenseSchema),
      },
      responses: { ...ok(expenseResponseSchema), ...errorResponses(403, 404, 409, 422) },
    }),
    async (c) => {
      const { tripId, expenseId } = c.req.valid("param");
      const m = c.get("membership");
      const row = await deps.expensesService.updateExpense(tripId, expenseId, c.req.valid("json"), {
        memberId: m.id,
        role: m.role,
      });
      return c.json(toResponse(row), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/trips/{tripId}/expenses/{expenseId}",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member],
      request: {
        params: z.object({ tripId: z.string().uuid(), expenseId: z.string().uuid() }),
        query: z.object({ version: z.coerce.number().int() }),
      },
      responses: {
        ...ok(z.object({ id: z.string(), deleted: z.boolean() }).openapi("ExpenseDeleted")),
        ...errorResponses(403, 404, 409),
      },
    }),
    async (c) => {
      const { tripId, expenseId } = c.req.valid("param");
      const m = c.get("membership");
      await deps.expensesService.deleteExpense(tripId, expenseId, c.req.valid("query").version, {
        memberId: m.id,
        role: m.role,
      });
      return c.json({ id: expenseId, deleted: true }, 200);
    },
  );

  // trip_default 환율 설정(admin). rate 정규화(10dp·>0·<10^10) 후 upsert(finding #3 pass1).
  app.openapi(
    createRoute({
      method: "put",
      path: "/trips/{tripId}/fx-defaults",
      security: [{ cookieAuth: [] }],
      middleware: [auth, admin],
      request: {
        params: z.object({ tripId: z.string().uuid() }),
        body: jsonBody(fxDefaultRequestSchema),
      },
      responses: {
        ...ok(z.object({ ok: z.boolean() }).openapi("FxDefaultSet")),
        ...errorResponses(403, 404, 422),
      },
    }),
    async (c) => {
      const tripId = c.req.valid("param").tripId;
      const { base_currency, settlement_currency, rate } = c.req.valid("json");
      let norm: string;
      try {
        norm = parsePositiveRate(rate).toFixed(10); // ≤0·round-to-zero·>10^10 → throw
      } catch {
        throw new ValidationError("invalid rate (≤0 or out of range)", { rate });
      }
      await deps.tripDefaults.upsertRate(tripId, base_currency, settlement_currency, norm);
      return c.json({ ok: true }, 200);
    },
  );
}
