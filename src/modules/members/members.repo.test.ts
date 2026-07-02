import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { startDb, mkUser, mkTrip, mkMember, type Ctx } from "../../../tests/db/helpers.ts";
import { DrizzleMemberRepo } from "./members.repo.ts";
import { generateInviteToken, normalizeEmail } from "./domain/invite-token.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

const future = () => new Date(Date.now() + 3600_000);
const past = () => new Date(Date.now() - 1000);

describe("DrizzleMemberRepo", () => {
  it("createInvite → findByTokenHash 조회", async () => {
    const u = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const repo = new DrizzleMemberRepo(ctx.db);
    const { hash } = generateInviteToken();
    await repo.createInvite({
      tripId: trip,
      email: "Guest@example.com",
      hash,
      expiresAt: future(),
      displayName: "G",
    });
    const row = await repo.findByTokenHash(hash);
    expect(row?.normalized_invited_email).toBe("guest@example.com");
    expect(row?.status).toBe("invited");
  });

  it("acceptInviteCas: 유효 invite → 1행 바인딩(joined·user_id)", async () => {
    const u = await mkUser(ctx.sql);
    const me = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const repo = new DrizzleMemberRepo(ctx.db);
    const { hash } = generateInviteToken();
    const email = "cas@example.com";
    await repo.createInvite({ tripId: trip, email, hash, expiresAt: future(), displayName: "C" });
    const row = await repo.findByTokenHash(hash);
    const bound = await repo.acceptInviteCas({
      inviteId: row!.id,
      userId: me,
      hash,
      normalizedEmail: normalizeEmail(email),
    });
    expect(bound?.user_id).toBe(me);
    expect(bound?.status).toBe("joined");
  });

  it("acceptInviteCas 멱등: 같은 user 재수락 → 0행(이미 joined)", async () => {
    const u = await mkUser(ctx.sql);
    const me = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const repo = new DrizzleMemberRepo(ctx.db);
    const { hash } = generateInviteToken();
    const email = "idem@example.com";
    await repo.createInvite({ tripId: trip, email, hash, expiresAt: future(), displayName: "I" });
    const row = await repo.findByTokenHash(hash);
    await repo.acceptInviteCas({
      inviteId: row!.id,
      userId: me,
      hash,
      normalizedEmail: normalizeEmail(email),
    });
    const second = await repo.acceptInviteCas({
      inviteId: row!.id,
      userId: me,
      hash,
      normalizedEmail: normalizeEmail(email),
    });
    expect(second).toBeNull();
  });

  it("acceptInviteCas: 만료된 invite → 0행", async () => {
    const u = await mkUser(ctx.sql);
    const me = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const repo = new DrizzleMemberRepo(ctx.db);
    const { hash } = generateInviteToken();
    const email = "exp@example.com";
    await repo.createInvite({ tripId: trip, email, hash, expiresAt: past(), displayName: "E" });
    const row = await repo.findByTokenHash(hash);
    const bound = await repo.acceptInviteCas({
      inviteId: row!.id,
      userId: me,
      hash,
      normalizedEmail: normalizeEmail(email),
    });
    expect(bound).toBeNull();
  });

  it("rotateInviteToken: pending invite → 원자 교체(1행), 비-pending → 0행 (finding #3)", async () => {
    const u = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const repo = new DrizzleMemberRepo(ctx.db);
    const { hash: h1 } = generateInviteToken();
    await repo.createInvite({
      tripId: trip,
      email: "rot@example.com",
      hash: h1,
      expiresAt: future(),
      displayName: "R",
    });
    const row = await repo.findByTokenHash(h1);
    const { hash: h2 } = generateInviteToken();
    const rotated = await repo.rotateInviteToken(trip, row!.id, h2, future());
    expect(rotated?.id).toBe(row!.id);
    expect(await repo.findByTokenHash(h1)).toBeNull(); // 이전 hash 무효
    expect((await repo.findByTokenHash(h2))?.id).toBe(row!.id); // 새 hash 유효
    const me = await mkUser(ctx.sql);
    await repo.acceptInviteCas({
      inviteId: row!.id,
      userId: me,
      hash: h2,
      normalizedEmail: "rot@example.com",
    });
    expect(
      await repo.rotateInviteToken(trip, row!.id, generateInviteToken().hash, future()),
    ).toBeNull();
  });

  it("findMembership·countActiveAdmins", async () => {
    const u = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const repo = new DrizzleMemberRepo(ctx.db);
    await repo.ensureCreatorMembership({
      tripId: trip,
      userId: u,
      displayName: "Admin",
      email: "admin@example.com",
    });
    expect((await repo.findMembership(trip, u))?.role).toBe("admin");
    expect(await repo.countActiveAdmins(trip)).toBe(1);
  });

  it("ensureCreatorMembership 동시 호출 → 동일 멤버십·unique 위반 노출 없음 (finding #4)", async () => {
    const u = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const repo = new DrizzleMemberRepo(ctx.db);
    const args = { tripId: trip, userId: u, displayName: "Admin", email: "creator@example.com" };
    const results = await Promise.all([
      repo.ensureCreatorMembership(args),
      repo.ensureCreatorMembership(args),
    ]);
    expect(results[0].id).toBe(results[1].id);
    expect(await repo.countActiveAdmins(trip)).toBe(1);
  });
});

describe("DrizzleMemberRepo.revokeInvite", () => {
  it("pending invite 취소 → invite_expired·토큰 null화(1행), 재취소 0행", async () => {
    const u = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const repo = new DrizzleMemberRepo(ctx.db);
    const { hash } = generateInviteToken();
    await repo.createInvite({
      tripId: trip,
      email: "rev@example.com",
      hash,
      expiresAt: future(),
      displayName: "R",
    });
    const row = await repo.findByTokenHash(hash);
    const revoked = await repo.revokeInvite(trip, row!.id);
    expect(revoked?.status).toBe("invite_expired");
    expect(await repo.findByTokenHash(hash)).toBeNull(); // 토큰 null화 → 조회 불가(uq_invite_token partial에서도 제거)
    expect(await repo.revokeInvite(trip, row!.id)).toBeNull(); // 재취소 0행(비-pending)
    expect((await repo.findMemberById(trip, row!.id))?.status).toBe("invite_expired");
  });

  it("교차-trip 취소 시도 → 0행(tripId 스코핑), 원본 불변", async () => {
    const u = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const other = await mkTrip(ctx.sql, await mkUser(ctx.sql));
    const repo = new DrizzleMemberRepo(ctx.db);
    const { hash } = generateInviteToken();
    await repo.createInvite({
      tripId: trip,
      email: "scope@example.com",
      hash,
      expiresAt: future(),
      displayName: "S",
    });
    const row = await repo.findByTokenHash(hash);
    expect(await repo.revokeInvite(other, row!.id)).toBeNull(); // 다른 trip → 0행
    expect((await repo.findMemberById(trip, row!.id))?.status).toBe("invited"); // 원본 invited 불변
  });
});

describe("DrizzleMemberRepo.transferAdmin (④ 어드민 양도)", () => {
  it("joined admin→member 강등 + joined bound member→admin 승격, 활성 어드민 1명 유지", async () => {
    const u1 = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u1);
    const fromId = await mkMember(ctx.sql, trip, { userId: u1, role: "admin", status: "joined" });
    const u2 = await mkUser(ctx.sql);
    const toId = await mkMember(ctx.sql, trip, { userId: u2, role: "member", status: "joined" });
    const repo = new DrizzleMemberRepo(ctx.db);

    const res = await repo.transferAdmin(trip, fromId, toId);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.member.id).toBe(toId);
      expect(res.member.role).toBe("admin");
    }
    expect((await repo.findMembership(trip, u1))?.role).toBe("member");
    expect((await repo.findMembership(trip, u2))?.role).toBe("admin");
    // 정확히 1명 → 강등이 승격보다 먼저 커밋됨을 증명(역순이면 uq_one_admin 23505로 tx 전체 실패).
    expect(await repo.countActiveAdmins(trip)).toBe(1);
  });

  it("대상이 invited(user_id null) → target_ineligible, 원자 롤백(강등 미반영)", async () => {
    const u1 = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u1);
    const fromId = await mkMember(ctx.sql, trip, { userId: u1, role: "admin", status: "joined" });
    const invitedId = await mkMember(ctx.sql, trip, { email: "pending@e.com" }); // user_id null, status invited
    const repo = new DrizzleMemberRepo(ctx.db);

    const res = await repo.transferAdmin(trip, fromId, invitedId);

    expect(res).toEqual({ ok: false, reason: "target_ineligible" });
    expect((await repo.findMembership(trip, u1))?.role).toBe("admin"); // 강등 롤백
  });

  it("대상 부재(존재하지 않는 id) → target_missing", async () => {
    const u1 = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u1);
    const fromId = await mkMember(ctx.sql, trip, { userId: u1, role: "admin", status: "joined" });
    const repo = new DrizzleMemberRepo(ctx.db);

    const res = await repo.transferAdmin(trip, fromId, randomUUID());

    expect(res).toEqual({ ok: false, reason: "target_missing" });
  });

  it("호출자가 admin 아님 → not_admin(쓰기 없음)", async () => {
    const u1 = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u1);
    const notAdmin = await mkMember(ctx.sql, trip, {
      userId: u1,
      role: "member",
      status: "joined",
    });
    const u2 = await mkUser(ctx.sql);
    const toId = await mkMember(ctx.sql, trip, { userId: u2, role: "member", status: "joined" });
    const repo = new DrizzleMemberRepo(ctx.db);

    const res = await repo.transferAdmin(trip, notAdmin, toId);

    expect(res).toEqual({ ok: false, reason: "not_admin" });
  });
});
