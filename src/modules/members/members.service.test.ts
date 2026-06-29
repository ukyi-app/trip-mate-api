import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, mkTrip, type Ctx } from "../../../tests/db/helpers.ts";
import { DrizzleMemberRepo } from "./members.repo.ts";
import { MembersService } from "./members.service.ts";
import { generateInviteToken, hashToken } from "./domain/invite-token.ts";
import { ForbiddenError, ConflictError } from "../../core/errors.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

function svc() {
  return new MembersService(new DrizzleMemberRepo(ctx.db), {
    ttlHours: 168,
    now: () => new Date(),
  });
}
const actor = (userId: string, email: string) => ({ id: userId, email });

describe("MembersService.acceptInvite", () => {
  it("정규화 이메일 일치 + 유효 토큰 → joined", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const me = await mkUser(ctx.sql);
    const s = svc();
    const { token } = await s.createInvite(trip, "Guest+x@gmail.com", "Guest");
    const r = await s.acceptInvite(token, actor(me, "guest@gmail.com"));
    expect(r.status).toBe("joined");
    expect(r.user_id).toBe(me);
  });

  it("이메일 불일치 → ForbiddenError(이 trip만 거부)", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const me = await mkUser(ctx.sql);
    const s = svc();
    const { token } = await s.createInvite(trip, "invited@example.com", "G");
    await expect(s.acceptInvite(token, actor(me, "someoneelse@example.com"))).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("멱등 재클릭(같은 user) → 멱등 성공", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const me = await mkUser(ctx.sql);
    const s = svc();
    const { token } = await s.createInvite(trip, "idem@example.com", "G");
    await s.acceptInvite(token, actor(me, "idem@example.com"));
    const again = await s.acceptInvite(token, actor(me, "idem@example.com"));
    expect(again.status).toBe("joined");
    expect(again.user_id).toBe(me);
  });

  it("다른 user가 이미 바인딩된 토큰 → ConflictError", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const u1 = await mkUser(ctx.sql);
    const u2 = await mkUser(ctx.sql);
    const s = svc();
    const { token } = await s.createInvite(trip, "shared@example.com", "G");
    await s.acceptInvite(token, actor(u1, "shared@example.com"));
    await expect(s.acceptInvite(token, actor(u2, "shared@example.com"))).rejects.toThrow(
      ConflictError,
    );
  });

  it("존재하지 않는/폐기된 토큰 → ForbiddenError", async () => {
    const s = svc();
    const { token } = generateInviteToken();
    await expect(s.acceptInvite(token, actor("x", "a@b.com"))).rejects.toThrow(ForbiddenError);
  });

  it("동시 수락(같은 토큰·다른 user) → 정확히 1명 joined, 나머지 ConflictError", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const a = await mkUser(ctx.sql);
    const b = await mkUser(ctx.sql);
    const s = svc();
    const { token } = await s.createInvite(trip, "race@example.com", "G");
    const results = await Promise.allSettled([
      s.acceptInvite(token, actor(a, "race@example.com")),
      s.acceptInvite(token, actor(b, "race@example.com")),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok.length).toBe(1);
  });

  it("이미 이 trip 멤버인 actor가 다른 이메일 초대 수락 → 멱등 성공(uq_member_user raw 위반 없음, finding #3 pass2)", async () => {
    const me = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, me);
    const s = svc();
    await s.ensureCreatorMembership(trip, me, "Creator", "creator@example.com");
    const { token } = await s.createInvite(trip, "myother@example.com", "G");
    const r = await s.acceptInvite(token, actor(me, "myother@example.com"));
    expect(r.user_id).toBe(me);
    expect(r.status).toBe("joined");
  });
});

describe("MembersService.createInvite 중복 (finding #3 pass4)", () => {
  it("같은 trip·같은 정규화 이메일 재초대 → ConflictError(raw 500 아님)", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const s = svc();
    await s.createInvite(trip, "dup@example.com", "G");
    await expect(s.createInvite(trip, "dup@example.com", "G2")).rejects.toThrow(ConflictError);
  });
  it("이미 멤버인 이메일로 초대 → ConflictError", async () => {
    const u = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const s = svc();
    await s.ensureCreatorMembership(trip, u, "C", "member@example.com");
    await expect(s.createInvite(trip, "member@example.com", "G")).rejects.toThrow(ConflictError);
  });
});

describe("MembersService.resendInvite", () => {
  it("재발송 → 이전 토큰 무효·새 토큰 유효", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const me = await mkUser(ctx.sql);
    const s = svc();
    const { token: old } = await s.createInvite(trip, "re@example.com", "G");
    const invite = await new DrizzleMemberRepo(ctx.db).findByTokenHash(hashToken(old));
    const { token: fresh } = await s.resendInvite(trip, invite!.id);
    await expect(s.acceptInvite(old, actor(me, "re@example.com"))).rejects.toThrow(ForbiddenError);
    const r = await s.acceptInvite(fresh, actor(me, "re@example.com"));
    expect(r.status).toBe("joined");
  });
});

describe("MembersService.assertNotLastAdmin", () => {
  it("마지막 어드민 강등 차단 → ForbiddenError", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const s = svc();
    await s.ensureCreatorMembership(trip, admin, "Admin", "admin@example.com");
    await expect(s.assertNotLastAdmin(trip)).rejects.toThrow(ForbiddenError);
  });
});
