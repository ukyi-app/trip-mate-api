import type { Hono } from "hono";
import { requireAuth, type SessionResolver } from "../../core/guards.ts";
import type { MembersService } from "./members.service.ts";

interface Deps {
  service: MembersService;
  resolver: SessionResolver;
  emailOf: (userId: string) => Promise<string>; // 세션 user.id → 이메일(운영은 Better Auth user, 테스트는 stub)
}

/** 얇은 accept 라우트(test-only — 프로덕션 /v1 라우트+OpenAPI DTO는 후속 슬라이스, finding #2 pass5).
 *  CSRF는 앱 전역 미들웨어가 선처리. */
export function registerAcceptRoute(app: Hono, deps: Deps): void {
  app.post("/invites/:token/accept", requireAuth(deps.resolver), async (c) => {
    const user = c.get("user");
    const email = await deps.emailOf(user.id);
    const token = c.req.param("token") ?? ""; // 라우트가 보장하나 Hono 타입은 string|undefined → 빈값은 findByTokenHash miss→ForbiddenError
    const row = await deps.service.acceptInvite(token, { id: user.id, email });
    return c.json({ status: row.status, role: row.role, trip_id: row.trip_id });
  });
}
