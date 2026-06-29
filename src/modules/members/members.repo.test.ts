import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, mkTrip, type Ctx } from "../../../tests/db/helpers.ts";
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
    const rotated = await repo.rotateInviteToken(row!.id, h2, future());
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
    expect(await repo.rotateInviteToken(row!.id, generateInviteToken().hash, future())).toBeNull();
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
