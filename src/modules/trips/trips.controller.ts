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
  tripListItemSchema,
  createTripSchema,
  updateTripSchema,
  deleteTripResponseSchema,
  type TripListItem,
} from "./trips.schema.ts";
import type { TripsService } from "./trips.service.ts";

/** settlement축 개인 net 배치 조회 PORT(app.ts가 settlementsService.netsForMemberships로 바인딩).
 *  값=bigint(0n 포함, no-activity 시 0n) 또는 null(해당 trip compute 오류). 키=tripId. */
export type TripNetLookup = (
  pairs: { tripId: string; memberId: string }[],
) => Promise<Map<string, bigint | null>>;

interface Deps {
  tripsService: TripsService<Record<string, unknown>>;
  resolver: SessionResolver;
  emailOf: (userId: string) => Promise<string>;
  nameOf: (userId: string) => Promise<string>; // Google 계정 이름(admin_display_name 폴백)
  memberLookup: MembershipLookup;
  netLookup: TripNetLookup;
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
      const [email, name] = await Promise.all([deps.emailOf(user.id), deps.nameOf(user.id)]);
      const trip = await deps.tripsService.createTrip(c.req.valid("json"), {
        id: user.id,
        email,
        name,
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
      responses: { ...ok(z.array(tripListItemSchema)), ...errorResponses(403) },
    }),
    async (c) => {
      const rows = await deps.tripsService.listTrips(c.get("user").id);
      // 배치 net 조회(D-C): tripId 전부를 한 번에 → repo가 IN-query 2개로 fetch, 순수 compute는 trip별 인메모리.
      const netMap = await deps.netLookup(
        rows.map((r) => ({ tripId: r.id, memberId: r.my_member_id })),
      );
      const items: TripListItem[] = rows.map((r) => {
        const net = netMap.get(r.id);
        return {
          ...r,
          // null=해당 trip compute 오류. 그 외(0n 포함/키 부재)는 부호 있는 문자열, no-activity→"0"(P-2).
          my_net_amount: net === null ? null : (net ?? 0n).toString(),
          net_currency: r.settlement_currency,
        };
      });
      return c.json(items, 200);
    },
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
    async (c) =>
      // my_member_id = requireTripMember가 계산한 호출자 자신의 멤버십 id.
      c.json(
        await deps.tripsService.getTrip(c.req.valid("param").tripId, c.get("membership").id),
        200,
      ),
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
        await deps.tripsService.updateTrip(
          c.req.valid("param").tripId,
          c.req.valid("json"),
          c.get("membership").id, // my_member_id = guard membership id
        ),
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
