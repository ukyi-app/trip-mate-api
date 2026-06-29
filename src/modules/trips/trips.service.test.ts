import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, type Ctx } from "../../../tests/db/helpers.ts";
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
const input = () => ({
  title: "도쿄",
  start_date: "2026-08-01",
  end_date: "2026-08-05",
  destination_countries: ["JP"],
  timezone: "Asia/Tokyo",
  primary_local_currency: "JPY",
  settlement_currency: "KRW",
});
const actor = (id: string, email = "a@example.com") => ({ id, email });

describe("TripsService", () => {
  it("createTrip → trip + 생성자 어드민 멤버십(joined)", async () => {
    const u = await mkUser(ctx.sql);
    const s = svc();
    const trip = await s.createTrip(input(), actor(u));
    expect(trip.settlement_currency).toBe("KRW");
    expect(await s.listTrips(u)).toHaveLength(1);
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
});
