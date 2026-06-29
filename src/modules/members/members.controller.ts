import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  requireAuth,
  requireTripMember,
  type SessionResolver,
  type MembershipLookup,
} from "../../core/guards.ts";
import { errorResponses } from "../../core/http.ts";
import {
  memberResponseSchema,
  createInviteSchema,
  updateMemberSchema,
  acceptResponseSchema,
} from "./members.schema.ts";
import type { MembersService } from "./members.service.ts";

interface Deps {
  service: MembersService;
  resolver: SessionResolver;
  emailOf: (userId: string) => Promise<string>;
  memberLookup: MembershipLookup;
}
const ok = <S extends z.ZodTypeAny>(schema: S) => ({
  200: { description: "ok", content: { "application/json": { schema } } },
});
const jsonBody = <S extends z.ZodTypeAny>(schema: S) => ({
  content: { "application/json": { schema } },
  required: true,
});

/** 멤버/초대 프로덕션 라우트(finding #2 pass5). 액션 경로는 `/resend`·`/accept` 세그먼트(finding #1 pass4). */
export function registerMemberRoutes(app: OpenAPIHono, deps: Deps): void {
  const auth = requireAuth(deps.resolver);
  const admin = requireTripMember(deps.memberLookup, "admin");
  const member = requireTripMember(deps.memberLookup);

  // 초대 생성(admin)
  app.openapi(
    createRoute({
      method: "post",
      path: "/trips/{tripId}/invites",
      security: [{ cookieAuth: [] }],
      middleware: [auth, admin],
      request: {
        params: z.object({ tripId: z.string().uuid() }),
        body: jsonBody(createInviteSchema),
      },
      responses: {
        ...ok(z.object({ inviteId: z.string(), link: z.string() }).openapi("InviteCreated")),
        ...errorResponses(403, 409, 422),
      },
    }),
    async (c) => {
      const { email, display_name } = c.req.valid("json");
      const cmd = await deps.service.createInvite(c.req.valid("param").tripId, email, display_name);
      return c.json({ inviteId: cmd.inviteId, link: cmd.link }, 200);
    },
  );

  // 멤버 목록(member)
  app.openapi(
    createRoute({
      method: "get",
      path: "/trips/{tripId}/members",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member],
      request: { params: z.object({ tripId: z.string().uuid() }) },
      responses: { ...ok(z.array(memberResponseSchema)), ...errorResponses(403) },
    }),
    async (c) => c.json(await deps.service.listMembers(c.req.valid("param").tripId), 200),
  );

  // 멤버 수정(admin) — display_name·status(비활성/복구). last-admin 가드·전이 제약은 service.
  app.openapi(
    createRoute({
      method: "patch",
      path: "/trips/{tripId}/members/{mid}",
      security: [{ cookieAuth: [] }],
      middleware: [auth, admin],
      request: {
        params: z.object({ tripId: z.string().uuid(), mid: z.string().uuid() }),
        body: jsonBody(updateMemberSchema),
      },
      responses: { ...ok(memberResponseSchema), ...errorResponses(403, 404, 409, 422) },
    }),
    async (c) => {
      const { tripId, mid } = c.req.valid("param");
      return c.json(await deps.service.updateMember(tripId, mid, c.req.valid("json")), 200);
    },
  );

  // 재발송(admin) — /resend 세그먼트, tripId 스코핑
  app.openapi(
    createRoute({
      method: "post",
      path: "/trips/{tripId}/invites/{iid}/resend",
      security: [{ cookieAuth: [] }],
      middleware: [auth, admin],
      request: { params: z.object({ tripId: z.string().uuid(), iid: z.string().uuid() }) },
      responses: {
        ...ok(z.object({ link: z.string() }).openapi("InviteResent")),
        ...errorResponses(403, 404, 409),
      },
    }),
    async (c) => {
      const { tripId, iid } = c.req.valid("param");
      return c.json({ link: (await deps.service.resendInvite(tripId, iid)).link }, 200);
    },
  );

  // 수락(인증만 — 토큰=포인터, 권한=email 매칭) — /accept 세그먼트
  app.openapi(
    createRoute({
      method: "post",
      path: "/invites/{token}/accept",
      security: [{ cookieAuth: [] }],
      middleware: [auth],
      request: { params: z.object({ token: z.string() }) },
      responses: { ...ok(acceptResponseSchema), ...errorResponses(403, 409) },
    }),
    async (c) => {
      const user = c.get("user");
      const email = await deps.emailOf(user.id);
      const row = await deps.service.acceptInvite(c.req.valid("param").token, {
        id: user.id,
        email,
      });
      return c.json(
        { trip_id: row.trip_id, role: row.role as "admin" | "member", status: row.status },
        200,
      );
    },
  );
}
