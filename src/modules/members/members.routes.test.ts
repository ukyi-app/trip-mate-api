import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, mkTrip, type Ctx } from "../../../tests/db/helpers.ts";
import { createApp } from "../../core/openapi.ts";
import { DrizzleMemberRepo } from "./members.repo.ts";
import { MembersService } from "./members.service.ts";
import { registerMemberRoutes } from "./members.controller.ts";
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

function appFor(userId: string, email: string) {
  const app = createApp();
  registerErrorFilter(app);
  const service = new MembersService(new DrizzleMemberRepo(ctx.db), { ttlHours: 168 });
  const resolver: SessionResolver = async () => ({ user: { id: userId } });
  const lookup = (t: string, u: string) => new DrizzleMemberRepo(ctx.db).findMembership(t, u);
  registerMemberRoutes(app, {
    service,
    resolver,
    emailOf: async () => email,
    memberLookup: lookup,
  });
  return app;
}
const svc = () => new MembersService(new DrizzleMemberRepo(ctx.db), { ttlHours: 168 });

describe("members/invites 라우트", () => {
  it("admin이 초대 생성 → 멤버 목록에 ≥2", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    await svc().ensureCreatorMembership(trip, admin, "Admin", "admin@example.com");
    const app = appFor(admin, "admin@example.com");
    const inv = await app.request(`/trips/${trip}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "g@example.com", display_name: "G" }),
    });
    expect([200, 201]).toContain(inv.status);
    const members = await app.request(`/trips/${trip}/members`);
    expect(((await members.json()) as unknown[]).length).toBeGreaterThanOrEqual(2);
  });
  it("비-admin 초대 → 403", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const memberU = await mkUser(ctx.sql);
    const s = svc();
    await s.ensureCreatorMembership(trip, admin, "Admin", "admin@example.com");
    const { token } = await s.createInvite(trip, "m@example.com", "M");
    await s.acceptInvite(token, { id: memberU, email: "m@example.com" });
    const res = await appFor(memberU, "m@example.com").request(`/trips/${trip}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x@example.com", display_name: "X" }),
    });
    expect(res.status).toBe(403);
  });
  it("POST /invites/{token}/accept → joined", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const me = await mkUser(ctx.sql);
    const s = svc();
    await s.ensureCreatorMembership(trip, admin, "Admin", "admin@example.com");
    const { token } = await s.createInvite(trip, "join@example.com", "J");
    const res = await appFor(me, "join@example.com").request(`/invites/${token}/accept`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("joined");
  });
  it("다른 trip admin이 교차-trip 초대 회전 시도 → 차단 (finding #1 pass4)", async () => {
    const adminA = await mkUser(ctx.sql);
    const tripA = await mkTrip(ctx.sql, adminA);
    const adminB = await mkUser(ctx.sql);
    const tripB = await mkTrip(ctx.sql, adminB);
    const s = svc();
    await s.ensureCreatorMembership(tripA, adminA, "A", "a@example.com");
    await s.ensureCreatorMembership(tripB, adminB, "B", "b@example.com");
    const cmd = await s.createInvite(tripB, "guest@example.com", "G");
    const res = await appFor(adminA, "a@example.com").request(
      `/trips/${tripA}/invites/${cmd.inviteId}/resend`,
      { method: "POST" },
    );
    expect(res.status).not.toBe(200);
    expect([403, 404, 409]).toContain(res.status);
  });
  it("invited 멤버를 PATCH로 joined 위조 시도 → 거부 (finding #3 pass3)", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const s = svc();
    await s.ensureCreatorMembership(trip, admin, "Admin", "admin@example.com");
    const cmd = await s.createInvite(trip, "pending@example.com", "P"); // invited row(user_id null)
    const res = await appFor(admin, "admin@example.com").request(
      `/trips/${trip}/members/${cmd.inviteId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "joined" }),
      },
    );
    expect(res.status).not.toBe(200);
    expect([403, 404, 409, 422]).toContain(res.status);
  });

  it("admin 초대 취소 → 200 invite_expired, 재취소 멱등 200", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const s = svc();
    await s.ensureCreatorMembership(trip, admin, "Admin", "admin@example.com");
    const cmd = await s.createInvite(trip, "revrt@example.com", "R");
    const app = appFor(admin, "admin@example.com");
    const res = await app.request(`/trips/${trip}/invites/${cmd.inviteId}/revoke`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("invite_expired");
    const again = await app.request(`/trips/${trip}/invites/${cmd.inviteId}/revoke`, {
      method: "POST",
    });
    expect(again.status).toBe(200); // 멱등 no-op
  });

  it("비-admin 취소 → 403", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const memberU = await mkUser(ctx.sql);
    const s = svc();
    await s.ensureCreatorMembership(trip, admin, "Admin", "admin@example.com");
    const cmd = await s.createInvite(trip, "target@example.com", "T");
    const { token } = await s.createInvite(trip, "m2@example.com", "M");
    await s.acceptInvite(token, { id: memberU, email: "m2@example.com" });
    const res = await appFor(memberU, "m2@example.com").request(
      `/trips/${trip}/invites/${cmd.inviteId}/revoke`,
      { method: "POST" },
    );
    expect(res.status).toBe(403);
  });

  it("존재하지 않는 초대 취소 → 404", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const s = svc();
    await s.ensureCreatorMembership(trip, admin, "Admin", "admin@example.com");
    const res = await appFor(admin, "admin@example.com").request(
      `/trips/${trip}/invites/00000000-0000-4000-8000-000000000000/revoke`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });
});
