import type { Context, Next } from "hono";
import { ForbiddenError } from "./errors.ts";

export interface SessionUser {
  id: string;
}
export type SessionResolver = (headers: Headers) => Promise<{ user: SessionUser } | null>;
export interface Membership {
  role: string;
  status: string;
}
export type MembershipLookup = (tripId: string, userId: string) => Promise<Membership | null>;

declare module "hono" {
  interface ContextVariableMap {
    user: SessionUser;
    membership: Membership;
  }
}

/** 인증: 세션 리졸버(주입)로 user 확립. 없으면 ForbiddenError(403). */
export function requireAuth(resolve: SessionResolver) {
  return async (c: Context, next: Next) => {
    const session = await resolve(c.req.raw.headers);
    if (!session) throw new ForbiddenError("authentication required");
    c.set("user", session.user);
    await next();
  };
}

/** 멤버십 게이팅: status=joined만 접근, role 지정 시 일치 필요. requireAuth 뒤에 둔다. */
export function requireTripMember(lookup: MembershipLookup, role?: "admin" | "member") {
  return async (c: Context, next: Next) => {
    const user = c.get("user");
    const tripId = c.req.param("tripId");
    if (!user || !tripId) throw new ForbiddenError("trip membership required");
    const m = await lookup(tripId, user.id);
    if (!m || m.status !== "joined")
      throw new ForbiddenError("not an active trip member", { tripId });
    if (role && m.role !== role) throw new ForbiddenError(`requires role ${role}`, { tripId });
    c.set("membership", m);
    await next();
  };
}
