import type { createApp } from "../../core/openapi.ts";
import type { createAuth } from "../../auth.ts";
import type { SessionResolver } from "../../core/guards.ts";

type App = ReturnType<typeof createApp>; // createApp()와 정확히 동일한 OpenAPIHono 타입(Env 변성 불일치 회피)
type AuthInstance = ReturnType<typeof createAuth>; // 싱글톤이 아니라 팩토리 반환 타입(finding #2)

/** /api/auth/* 를 Better Auth web fetch 핸들러로 마운트. */
export function mountAuth(app: App, auth: AuthInstance): void {
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
}

/** 운영 세션 리졸버: Better Auth가 헤더(쿠키)로 세션 해석. */
export function betterAuthSessionResolver(auth: AuthInstance): SessionResolver {
  return async (headers) => {
    const session = await auth.api.getSession({ headers });
    return session?.user ? { user: { id: session.user.id } } : null;
  };
}
