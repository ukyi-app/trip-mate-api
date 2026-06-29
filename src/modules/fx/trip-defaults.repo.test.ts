import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, mkTrip, type Ctx } from "../../../tests/db/helpers.ts";
import { DrizzleTripDefaults } from "./trip-defaults.repo.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

describe("DrizzleTripDefaults", () => {
  it("upsert→get round-trip + 덮어쓰기", async () => {
    const u = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const repo = new DrizzleTripDefaults(ctx.db);
    expect(await repo.getRate(trip, "THB", "KRW")).toBeNull();
    await repo.upsertRate(trip, "THB", "KRW", "37.9000000000");
    expect(await repo.getRate(trip, "THB", "KRW")).toBe("37.9000000000");
    await repo.upsertRate(trip, "THB", "KRW", "38.0000000000"); // 덮어쓰기
    expect(await repo.getRate(trip, "THB", "KRW")).toBe("38.0000000000");
  });
});
