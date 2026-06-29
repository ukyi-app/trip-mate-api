import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { startDb, mkUser, mkTrip, type Ctx } from "../../../tests/db/helpers.ts";
import { DrizzleMemberRepo } from "./members.repo.ts";
import { MembersService } from "./members.service.ts";
import { registerAcceptRoute } from "./members.controller.ts";
import { csrf } from "../../core/csrf.ts";
import { registerErrorFilter } from "../../core/errors.ts";
import type { SessionResolver } from "../../core/guards.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

const ORIGIN = "https://app.ukyi.app";
const corsMw = cors({
  origin: [ORIGIN],
  credentials: true,
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type"],
});
function appFor(userId: string, email: string) {
  const app = new Hono();
  registerErrorFilter(app);
  app.use("*", corsMw); // CORS → CSRF → 라우트 (main.ts 동일 체인)
  app.use("*", csrf([ORIGIN]));
  const resolver: SessionResolver = async () => ({ user: { id: userId } });
  const service = new MembersService(new DrizzleMemberRepo(ctx.db), { ttlHours: 168 });
  registerAcceptRoute(app, { service, resolver, emailOf: async () => email });
  return app;
}

async function makeInvite(trip: string, email: string) {
  const s = new MembersService(new DrizzleMemberRepo(ctx.db), { ttlHours: 168 });
  const { token } = await s.createInvite(trip, email, "G");
  return token;
}

describe("POST /invites/:token/accept (통합)", () => {
  it("정확 Origin + 세션 + 이메일 일치 → 200 joined", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const me = await mkUser(ctx.sql);
    const token = await makeInvite(trip, "ok@example.com");
    const res = await appFor(me, "ok@example.com").request(`/invites/${token}/accept`, {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("joined");
  });

  it("형제 Origin → 403(CSRF, 서비스 도달 전 차단)", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const me = await mkUser(ctx.sql);
    const token = await makeInvite(trip, "csrf@example.com");
    const res = await appFor(me, "csrf@example.com").request(`/invites/${token}/accept`, {
      method: "POST",
      headers: { origin: "https://evil.ukyi.app" },
    });
    expect(res.status).toBe(403);
  });

  it("Origin 누락 → 403", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const me = await mkUser(ctx.sql);
    const token = await makeInvite(trip, "noorigin@example.com");
    const res = await appFor(me, "noorigin@example.com").request(`/invites/${token}/accept`, {
      method: "POST",
    });
    expect(res.status).toBe(403);
  });

  it("이메일 불일치 → 403(problem+json code=ForbiddenError)", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const me = await mkUser(ctx.sql);
    const token = await makeInvite(trip, "real@example.com");
    const res = await appFor(me, "attacker@example.com").request(`/invites/${token}/accept`, {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("ForbiddenError");
  });

  // ── CORS (credentialed 교차 서브도메인, finding pass3) ──
  it("CORS preflight(OPTIONS) 정확 origin → ACAO·ACAC 헤더", async () => {
    const res = await appFor("u", "u@example.com").request("/invites/x/accept", {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "POST" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
  it("CORS 외부 origin → ACAO 미부여(브라우저 거부)", async () => {
    const res = await appFor("u", "u@example.com").request("/invites/x/accept", {
      method: "OPTIONS",
      headers: { origin: "https://evil.com", "access-control-request-method": "POST" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("credentialed POST 응답에 ACAO·ACAC", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const me = await mkUser(ctx.sql);
    const token = await makeInvite(trip, "cors-ok@example.com");
    const res = await appFor(me, "cors-ok@example.com").request(`/invites/${token}/accept`, {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
});
