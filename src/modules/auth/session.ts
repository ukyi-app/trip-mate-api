import type { createAuth } from "../../auth.ts";
import type { SessionResolver } from "../../core/guards.ts";

type AuthInstance = ReturnType<typeof createAuth>;
export interface SessionPrincipal {
  id: string;
  email: string;
}

/** Better Auth 세션에서 principal(id+email) 해석. 핸들러가 actor로 사용. */
export function sessionPrincipal(auth: AuthInstance) {
  return async (headers: Headers): Promise<SessionPrincipal | null> => {
    const s = await auth.api.getSession({ headers });
    return s?.user ? { id: s.user.id, email: s.user.email } : null;
  };
}

/** guards.requireAuth용 리졸버(id만). 이메일은 sessionPrincipal로 별도 조회. */
export function authResolver(auth: AuthInstance): SessionResolver {
  return async (headers) => {
    const s = await auth.api.getSession({ headers });
    return s?.user ? { user: { id: s.user.id } } : null;
  };
}
