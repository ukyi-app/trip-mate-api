import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  requireAuth,
  requireTripMember,
  type SessionResolver,
  type MembershipLookup,
} from "../../core/guards.ts";
import { errorResponses } from "../../core/http.ts";
import {
  tripResponseSchema,
  createTripSchema,
  updateTripSchema,
  deleteTripResponseSchema,
} from "./trips.schema.ts";
import type { TripsService } from "./trips.service.ts";

interface Deps {
  tripsService: TripsService<Record<string, unknown>>;
  resolver: SessionResolver;
  emailOf: (userId: string) => Promise<string>;
  memberLookup: MembershipLookup;
}

// 제네릭으로 스키마 타입(S) 보존 → zod-openapi가 c.req.valid("json") 타입 추론(z.ZodTypeAny면 unknown 됨).
const jsonBody = <S extends z.ZodTypeAny>(schema: S) => ({
  content: { "application/json": { schema } },
  required: true,
});
const ok = <S extends z.ZodTypeAny>(schema: S) => ({
  200: { description: "ok", content: { "application/json": { schema } } },
});

export function registerTripRoutes(app: OpenAPIHono, deps: Deps): void {
  const auth = requireAuth(deps.resolver);

  app.openapi(
    createRoute({
      method: "post",
      path: "/trips",
      security: [{ cookieAuth: [] }],
      middleware: [auth],
      request: { body: jsonBody(createTripSchema) },
      responses: { ...ok(tripResponseSchema), ...errorResponses(403, 422) },
    }),
    async (c) => {
      const user = c.get("user");
      const trip = await deps.tripsService.createTrip(c.req.valid("json"), {
        id: user.id,
        email: await deps.emailOf(user.id),
      });
      return c.json(trip, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/trips",
      security: [{ cookieAuth: [] }],
      middleware: [auth],
      responses: { ...ok(z.array(tripResponseSchema)), ...errorResponses(403) },
    }),
    async (c) => c.json(await deps.tripsService.listTrips(c.get("user").id), 200),
  );

  // 파라미터명은 requireTripMember가 읽는 `tripId`로 통일(finding #1 pass3).
  app.openapi(
    createRoute({
      method: "get",
      path: "/trips/{tripId}",
      security: [{ cookieAuth: [] }],
      middleware: [auth, requireTripMember(deps.memberLookup)],
      request: { params: z.object({ tripId: z.string().uuid() }) },
      responses: { ...ok(tripResponseSchema), ...errorResponses(403, 404) },
    }),
    async (c) => c.json(await deps.tripsService.getTrip(c.req.valid("param").tripId), 200),
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/trips/{tripId}",
      security: [{ cookieAuth: [] }],
      middleware: [auth, requireTripMember(deps.memberLookup, "admin")],
      request: {
        params: z.object({ tripId: z.string().uuid() }),
        body: jsonBody(updateTripSchema),
      },
      responses: { ...ok(tripResponseSchema), ...errorResponses(403, 404, 422) },
    }),
    async (c) =>
      c.json(
        await deps.tripsService.updateTrip(c.req.valid("param").tripId, c.req.valid("json")),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/trips/{tripId}",
      security: [{ cookieAuth: [] }],
      middleware: [auth, requireTripMember(deps.memberLookup, "admin")],
      request: { params: z.object({ tripId: z.string().uuid() }) },
      responses: { ...ok(deleteTripResponseSchema), ...errorResponses(403, 404) },
    }),
    async (c) =>
      c.json(
        await deps.tripsService.deleteTrip(c.req.valid("param").tripId, c.get("membership").id),
        200,
      ),
  );
}
