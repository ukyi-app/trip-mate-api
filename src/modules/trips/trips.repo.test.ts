import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { startDb, mkUser, mkMember, type Ctx } from "../../../tests/db/helpers.ts";
import { DrizzleTripRepo } from "./trips.repo.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

const input = (over = {}) => ({
  title: "도쿄",
  start_date: "2026-08-01",
  end_date: "2026-08-05",
  destination_countries: ["JP"],
  timezone: "Asia/Tokyo",
  primary_local_currency: "JPY",
  settlement_currency: "KRW",
  ...over,
});

describe("DrizzleTripRepo", () => {
  it("create→findById", async () => {
    const u = await mkUser(ctx.sql);
    const repo = new DrizzleTripRepo(ctx.db);
    const trip = await repo.create(input(), u);
    expect(trip.title).toBe("도쿄");
    expect((await repo.findById(trip.id))?.settlement_currency).toBe("KRW");
  });
  it("update title", async () => {
    const u = await mkUser(ctx.sql);
    const repo = new DrizzleTripRepo(ctx.db);
    const trip = await repo.create(input(), u);
    const updated = await repo.update(trip.id, { title: "오사카" });
    expect(updated?.title).toBe("오사카");
  });
  it("delete → 'deleted'(admin 재검증 통과·내부 tx FOR UPDATE), findById null", async () => {
    const u = await mkUser(ctx.sql);
    const repo = new DrizzleTripRepo(ctx.db);
    const trip = await repo.create(input(), u);
    const adminMid = await mkMember(ctx.sql, trip.id, {
      userId: u,
      role: "admin",
      status: "joined",
    });
    expect(await repo.delete(trip.id, adminMid)).toBe("deleted");
    expect(await repo.findById(trip.id)).toBeNull();
  });
  it("delete: 없는 tripId → 'not_found'", async () => {
    const repo = new DrizzleTripRepo(ctx.db);
    expect(await repo.delete("00000000-0000-0000-0000-000000000000", randomUUID())).toBe(
      "not_found",
    );
  });
  it("delete: 호출자가 admin 아님(강등/비활성) → 'forbidden'(삭제 안 됨) [F5]", async () => {
    const u = await mkUser(ctx.sql);
    const repo = new DrizzleTripRepo(ctx.db);
    const trip = await repo.create(input(), u);
    const memberMid = await mkMember(ctx.sql, trip.id, {
      userId: u,
      role: "member",
      status: "joined",
    });
    expect(await repo.delete(trip.id, memberMid)).toBe("forbidden");
    expect(await repo.findById(trip.id)).not.toBeNull(); // 삭제되지 않음
  });
});
