import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  requireAuth,
  requireTripMember,
  type SessionResolver,
  type MembershipLookup,
} from "./guards.ts";

const userSession =
  (id: string): SessionResolver =>
  async () => ({ user: { id } });
const noSession: SessionResolver = async () => null;

const lookup =
  (rows: Record<string, { role: string; status: string }>): MembershipLookup =>
  async (tripId, userId) => {
    const r = rows[`${tripId}:${userId}`];
    return r ? { id: `m-${userId}`, ...r } : null;
  };

function appWith(resolver: SessionResolver, look: MembershipLookup) {
  const app = new Hono();
  app.onError((e, c) =>
    c.json(
      { code: (e as { code?: string }).code ?? "Error" },
      ((e as { status?: number }).status ?? 500) as 403 | 500,
    ),
  );
  app.use("/trips/:tripId/*", requireAuth(resolver), requireTripMember(look));
  app.get("/trips/:tripId/x", (c) => c.json({ user: c.get("user"), m: c.get("membership") }));
  app.use("/admin/:tripId/*", requireAuth(resolver), requireTripMember(look, "admin"));
  app.get("/admin/:tripId/x", (c) => c.json({ ok: true }));
  return app;
}

describe("requireAuth", () => {
  it("세션 없음 → 403", async () => {
    const app = appWith(noSession, lookup({}));
    expect((await app.request("/trips/t1/x")).status).toBe(403);
  });
});

describe("requireTripMember", () => {
  it("joined 멤버 → 통과 + membership 노출", async () => {
    const app = appWith(
      userSession("u1"),
      lookup({ "t1:u1": { role: "member", status: "joined" } }),
    );
    const res = await app.request("/trips/t1/x");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { m: { role: string } }).m.role).toBe("member");
  });
  it("비멤버 → 403", async () => {
    const app = appWith(userSession("u9"), lookup({}));
    expect((await app.request("/trips/t1/x")).status).toBe(403);
  });
  it("invited(미참여) 상태 → 403(joined만 접근)", async () => {
    const app = appWith(
      userSession("u1"),
      lookup({ "t1:u1": { role: "member", status: "invited" } }),
    );
    expect((await app.request("/trips/t1/x")).status).toBe(403);
  });
  it("role=admin 요구인데 member → 403", async () => {
    const app = appWith(
      userSession("u1"),
      lookup({ "t1:u1": { role: "member", status: "joined" } }),
    );
    expect((await app.request("/admin/t1/x")).status).toBe(403);
  });
  it("admin 요구 + admin → 200", async () => {
    const app = appWith(
      userSession("u1"),
      lookup({ "t1:u1": { role: "admin", status: "joined" } }),
    );
    expect((await app.request("/admin/t1/x")).status).toBe(200);
  });
});
