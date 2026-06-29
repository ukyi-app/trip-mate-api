import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, type Ctx } from "../../../tests/db/helpers.ts";
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
});
