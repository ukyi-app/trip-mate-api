import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { startDb, mkUser, mkMember, type Ctx } from "../../../tests/db/helpers.ts";
import { ForbiddenError, NotFoundError } from "../../core/errors.ts";
import { DrizzleTripRepo } from "./trips.repo.ts";
import { DrizzleMemberRepo } from "../members/members.repo.ts";
import { MembersService } from "../members/members.service.ts";
import { TripsService } from "./trips.service.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

function svc() {
  const members = new MembersService(new DrizzleMemberRepo(ctx.db), { ttlHours: 168 });
  return new TripsService(ctx.db, new DrizzleTripRepo(ctx.db), members);
}
const input = (over: Record<string, unknown> = {}) => ({
  title: "도쿄",
  start_date: "2026-08-01",
  end_date: "2026-08-05",
  destination_countries: ["JP"],
  timezone: "Asia/Tokyo",
  primary_local_currency: "JPY",
  settlement_currency: "KRW",
  admin_display_name: "여행대장",
  ...over,
});
const actor = (id: string, email = "a@example.com", name = "Google이름") => ({ id, email, name });

describe("TripsService", () => {
  it("createTrip → trip + 생성자 어드민 멤버십(joined), my_member_id=생성자 멤버십 id", async () => {
    const u = await mkUser(ctx.sql);
    const s = svc();
    const trip = await s.createTrip(input(), actor(u));
    expect(trip.settlement_currency).toBe("KRW");
    // my_member_id = 생성자 멤버십(ensureCreatorMembership)의 id.
    const rows = await ctx.sql<
      { id: string }[]
    >`select id from trip_members where trip_id=${trip.id} and user_id=${u}`;
    expect(trip.my_member_id).toBe(rows[0]!.id);
    expect(await s.listTrips(u)).toHaveLength(1);
  });
  it("생성자 멤버십 display_name = 입력한 admin_display_name(§6.1, 'Me' 하드코딩 아님)", async () => {
    const u = await mkUser(ctx.sql);
    const s = svc();
    const trip = await s.createTrip(input({ admin_display_name: "김대장" }), actor(u));
    const rows = await ctx.sql<{ display_name: string; role: string }[]>`
      select display_name, role from trip_members where trip_id = ${trip.id} and user_id = ${u}`;
    expect(rows[0]?.display_name).toBe("김대장");
    expect(rows[0]?.role).toBe("admin");
  });
  it("admin_display_name 미입력 → Google 계정 이름(actor.name) 폴백", async () => {
    const u = await mkUser(ctx.sql);
    const s = svc();
    const { admin_display_name: _omit, ...noName } = input();
    const trip = await s.createTrip(noName, actor(u, "x@y.com", "심우기"));
    const rows = await ctx.sql<{ display_name: string }[]>`
      select display_name from trip_members where trip_id = ${trip.id} and user_id = ${u}`;
    expect(rows[0]?.display_name).toBe("심우기");
  });
  it("listTrips는 내가 joined인 trip만", async () => {
    const u1 = await mkUser(ctx.sql);
    const u2 = await mkUser(ctx.sql);
    const s = svc();
    await s.createTrip(input(), actor(u1));
    expect(await s.listTrips(u2)).toHaveLength(0);
  });
  it("멤버십 생성 실패 시 trip 롤백(고아 없음, finding #2 pass1)", async () => {
    const u = await mkUser(ctx.sql);
    const repo = new DrizzleTripRepo(ctx.db);
    const boom = {
      ensureCreatorMembership: async () => {
        throw new Error("boom");
      },
    } as unknown as MembersService;
    const s = new TripsService(ctx.db, repo, boom);
    await expect(s.createTrip(input(), actor(u))).rejects.toThrow();
    const cnt = await ctx.sql<
      { n: number }[]
    >`select count(*)::int as n from trips where created_by_user_id = ${u}`;
    expect(cnt[0]!.n).toBe(0); // 롤백 — trip 미생성
  });
  it("deleteTrip → {id, deleted:true}, 이후 listTrips 비어있음", async () => {
    const u = await mkUser(ctx.sql);
    const s = svc();
    const trip = await s.createTrip(input(), actor(u));
    const rows = await ctx.sql<
      { id: string }[]
    >`select id from trip_members where trip_id=${trip.id} and user_id=${u}`;
    const mid = rows[0]!.id;
    const res = await s.deleteTrip(trip.id, mid);
    expect(res).toEqual({ id: trip.id, deleted: true });
    expect(await s.listTrips(u)).toHaveLength(0); // 멤버십도 cascade 제거
  });
  it("deleteTrip: 없는 tripId → NotFoundError(404)", async () => {
    const s = svc();
    await expect(
      s.deleteTrip("00000000-0000-0000-0000-000000000000", randomUUID()),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
  it("deleteTrip: 호출자가 admin 아님 → ForbiddenError(403)·삭제 안 됨 [F5]", async () => {
    const u = await mkUser(ctx.sql);
    const s = svc();
    const trip = await s.createTrip(input(), actor(u));
    const otherMid = await mkMember(ctx.sql, trip.id, {
      userId: await mkUser(ctx.sql),
      role: "member",
      status: "joined",
    });
    await expect(s.deleteTrip(trip.id, otherMid)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await s.getTrip(trip.id, otherMid)).toBeTruthy(); // 존재 유지
  });
});
