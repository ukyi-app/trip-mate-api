import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, mkTrip, type Ctx } from "../../../tests/db/helpers.ts";
import { createApp } from "../../core/openapi.ts";
import { DrizzleMemberRepo } from "./members.repo.ts";
import { MembersService } from "./members.service.ts";
import { registerMemberRoutes } from "./members.controller.ts";
import { registerErrorFilter } from "../../core/errors.ts";
import type { SessionResolver } from "../../core/guards.ts";
import type { Mailer, InviteEmail } from "../notifications/mailer.port.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

function appFor(userId: string, email: string, mailer?: Mailer) {
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
    ...(mailer ? { mailer, inviteBaseUrl: "https://trip-mate.ukyi.app" } : {}),
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
  it("초대 생성 시 mailer.sendInvite 호출(to·절대 URL)", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    await svc().ensureCreatorMembership(trip, admin, "Admin", "admin@example.com");
    const calls: InviteEmail[] = [];
    const mailer: Mailer = {
      sendInvite: async (m) => {
        calls.push(m);
      },
    };
    const res = await appFor(admin, "admin@example.com", mailer).request(`/trips/${trip}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "g@example.com", display_name: "G" }),
    });
    expect([200, 201]).toContain(res.status);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe("g@example.com");
    expect(calls[0]!.inviteUrl).toMatch(/^https:\/\/trip-mate\.ukyi\.app\/invite\/.+/);
  });
  it("mailer 실패해도 초대는 성공(best-effort)", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    await svc().ensureCreatorMembership(trip, admin, "Admin", "admin@example.com");
    const mailer: Mailer = {
      sendInvite: async () => {
        throw new Error("resend down");
      },
    };
    const res = await appFor(admin, "admin@example.com", mailer).request(`/trips/${trip}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "h@example.com", display_name: "H" }),
    });
    expect([200, 201]).toContain(res.status); // 발송 실패해도 초대는 생성됨
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

  it("취소된 초대는 멤버 목록에 invite_expired로 노출(응답 스키마 정합, 500 아님)", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const s = svc();
    await s.ensureCreatorMembership(trip, admin, "Admin", "admin@example.com");
    const cmd = await s.createInvite(trip, "listed@example.com", "L");
    await s.revokeInvite(trip, cmd.inviteId);
    const res = await appFor(admin, "admin@example.com").request(`/trips/${trip}/members`);
    expect(res.status).toBe(200); // memberResponseSchema enum이 invite_expired 수용 → serialize 성공
    const rows = (await res.json()) as { id: string; status: string }[];
    expect(rows.find((r) => r.id === cmd.inviteId)?.status).toBe("invite_expired");
  });

  it("invite_expired 행을 PATCH로 joined 위조 시도 → 거부(user_id null·전이 가드)", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const s = svc();
    await s.ensureCreatorMembership(trip, admin, "Admin", "admin@example.com");
    const cmd = await s.createInvite(trip, "guard@example.com", "G");
    await s.revokeInvite(trip, cmd.inviteId);
    const res = await appFor(admin, "admin@example.com").request(
      `/trips/${trip}/members/${cmd.inviteId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "joined" }),
      },
    );
    expect(res.status).not.toBe(200);
    expect([403, 404, 409, 422]).toContain(res.status); // updateMember: isNotNull(user_id)+status∈{joined,deactivated} 가드 0행 → 409
  });

  it("admin이 다른 joined 멤버에게 양도 → 200 + 신 admin", async () => {
    const adminU = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, adminU);
    const s = svc();
    await s.ensureCreatorMembership(trip, adminU, "Admin", "admin@example.com");
    const targetU = await mkUser(ctx.sql);
    const { token } = await s.createInvite(trip, "t@example.com", "T");
    const target = await s.acceptInvite(token, { id: targetU, email: "t@example.com" });
    const res = await appFor(adminU, "admin@example.com").request(
      `/trips/${trip}/members/${target.id}/transfer-admin`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe("admin");
  });
  it("비-admin 양도 시도 → 403", async () => {
    const adminU = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, adminU);
    const s = svc();
    await s.ensureCreatorMembership(trip, adminU, "Admin", "admin@example.com");
    const memberU = await mkUser(ctx.sql);
    const { token } = await s.createInvite(trip, "m@example.com", "M");
    const member = await s.acceptInvite(token, { id: memberU, email: "m@example.com" });
    const res = await appFor(memberU, "m@example.com").request(
      `/trips/${trip}/members/${member.id}/transfer-admin`,
      { method: "POST" },
    );
    expect(res.status).toBe(403);
  });
  it("대상이 invited(부적격) → 409", async () => {
    const adminU = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, adminU);
    const s = svc();
    await s.ensureCreatorMembership(trip, adminU, "Admin", "admin@example.com");
    const cmd = await s.createInvite(trip, "pending@example.com", "P");
    const res = await appFor(adminU, "admin@example.com").request(
      `/trips/${trip}/members/${cmd.inviteId}/transfer-admin`,
      { method: "POST" },
    );
    expect(res.status).toBe(409);
  });
  it("양도 성공 후 구 admin 재시도 → 403 (강등돼 admin 가드 우선, 거짓 성공/409 아님) [F4]", async () => {
    const adminU = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, adminU);
    const s = svc();
    await s.ensureCreatorMembership(trip, adminU, "Admin", "admin@example.com");
    const targetU = await mkUser(ctx.sql);
    const { token } = await s.createInvite(trip, "t2@example.com", "T2");
    const target = await s.acceptInvite(token, { id: targetU, email: "t2@example.com" });
    const path = `/trips/${trip}/members/${target.id}/transfer-admin`;
    expect(
      (await appFor(adminU, "admin@example.com").request(path, { method: "POST" })).status,
    ).toBe(200);
    // 재시도: 양도로 구 admin이 member로 강등됨 → requireTripMember(admin)가 먼저 403(service 미도달).
    // 무가드·멱등 미적용 결정 하에서 이 403이 권한변경 작업의 수용된 재시도 계약이다(F4 반영).
    expect(
      (await appFor(adminU, "admin@example.com").request(path, { method: "POST" })).status,
    ).toBe(403);
  });
});

describe("GET /me/invites (user-scoped 내 초대 목록)", () => {
  it("정규화 이메일이 매칭되는 pending 초대만 반환 — 불일치/수락/만료는 제외", async () => {
    const admin = await mkUser(ctx.sql);
    const me = await mkUser(ctx.sql);
    const myEmail = "discover@example.com";

    // (1) 매칭 + 유효(미만료) 초대 → 반환돼야 한다.
    const tripMatch = await mkTrip(ctx.sql, admin);
    await svc().createInvite(tripMatch, myEmail, "Match");

    // (2) 이메일 불일치 초대 → 제외(유효 만료지만 다른 이메일).
    const tripOther = await mkTrip(ctx.sql, admin);
    await svc().createInvite(tripOther, "someone-else@example.com", "Other");

    // (3) 수락됨(status=joined) → 제외.
    const tripAccepted = await mkTrip(ctx.sql, admin);
    const { token } = await svc().createInvite(tripAccepted, myEmail, "Acc");
    await svc().acceptInvite(token, { id: me, email: myEmail });

    // (4) 만료(status=invited이나 토큰 만료 시각이 과거) → 제외.
    const tripExpired = await mkTrip(ctx.sql, admin);
    const pastSvc = new MembersService(new DrizzleMemberRepo(ctx.db), {
      ttlHours: 168,
      now: () => new Date(Date.now() - 1000 * 60 * 60 * 24 * 30),
    });
    await pastSvc.createInvite(tripExpired, myEmail, "Exp");

    const res = await appFor(me, myEmail).request("/me/invites");
    expect(res.status).toBe(200);
    const items = (await res.json()) as { trip_id: string }[];
    const ids = items.map((i) => i.trip_id);
    expect(ids).toContain(tripMatch);
    expect(ids).not.toContain(tripOther); // 이메일 불일치
    expect(ids).not.toContain(tripAccepted); // 이미 수락
    expect(ids).not.toContain(tripExpired); // 만료
  });

  it("응답 아이템은 정확히 {trip_id,trip_title,role,invited_email,expires_at} — 토큰/user_id/member id 미노출", async () => {
    const admin = await mkUser(ctx.sql);
    const me = await mkUser(ctx.sql);
    const myEmail = "keys-check@example.com";
    const trip = await mkTrip(ctx.sql, admin);
    await svc().createInvite(trip, myEmail, "K");

    const res = await appFor(me, myEmail).request("/me/invites");
    expect(res.status).toBe(200);
    const items = (await res.json()) as Record<string, unknown>[];
    const item = items.find((i) => i.trip_id === trip);
    expect(item).toBeDefined();
    // 정확 키 집합 — 하나라도 초과/누락되면 실패.
    expect(Object.keys(item!).sort()).toEqual(
      ["expires_at", "invited_email", "role", "trip_id", "trip_title"].sort(),
    );
    // 내부/민감 필드는 어떤 형태로도 노출되면 안 된다.
    expect(item).not.toHaveProperty("invite_token_hash");
    expect(item).not.toHaveProperty("user_id");
    expect(item).not.toHaveProperty("id"); // trip_members.id(member_id)
    expect(item!.trip_title).toBe("T");
    expect(item!.invited_email).toBe(myEmail);
    expect(item!.role).toBe("member");
    expect(typeof item!.expires_at).toBe("string");
  });

  it("미인증(resolver null) → 403", async () => {
    const app = createApp();
    registerErrorFilter(app);
    const lookup = (t: string, u: string) => new DrizzleMemberRepo(ctx.db).findMembership(t, u);
    registerMemberRoutes(app, {
      service: svc(),
      resolver: async () => null,
      emailOf: async () => "x@example.com",
      memberLookup: lookup,
    });
    const res = await app.request("/me/invites");
    expect(res.status).toBe(403);
  });

  it("세션 유저 이메일이 빈 문자열 → [] (normalizeEmail 422 아님)", async () => {
    const me = await mkUser(ctx.sql);
    const res = await appFor(me, "").request("/me/invites");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
