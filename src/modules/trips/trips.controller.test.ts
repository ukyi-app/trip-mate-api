import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, type Ctx } from "../../../tests/db/helpers.ts";
import { createApp } from "../../core/openapi.ts";
import { DrizzleTripRepo } from "./trips.repo.ts";
import { DrizzleMemberRepo } from "../members/members.repo.ts";
import { MembersService } from "../members/members.service.ts";
import { TripsService } from "./trips.service.ts";
import { registerTripRoutes } from "./trips.controller.ts";
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

function appFor(userId: string, email = "a@example.com") {
  const app = createApp(); // 422 defaultHook 상속
  registerErrorFilter(app);
  const tripsService = new TripsService(
    ctx.db,
    new DrizzleTripRepo(ctx.db),
    new MembersService(new DrizzleMemberRepo(ctx.db), { ttlHours: 168 }),
  );
  const resolver: SessionResolver = async () => ({ user: { id: userId } });
  const memberLookup = (tripId: string, uid: string) =>
    new DrizzleMemberRepo(ctx.db).findMembership(tripId, uid);
  registerTripRoutes(app, { tripsService, resolver, emailOf: async () => email, memberLookup });
  return app;
}
const body = () => ({
  title: "도쿄",
  start_date: "2026-08-01",
  end_date: "2026-08-05",
  destination_countries: ["JP"],
  timezone: "Asia/Tokyo",
  primary_local_currency: "JPY",
  settlement_currency: "KRW",
});
const post = (app: ReturnType<typeof appFor>, b: unknown) =>
  app.request("/trips", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  });

describe("trips 라우트", () => {
  it("POST /trips → 200, GET /trips → 내 trip 1개", async () => {
    const u = await mkUser(ctx.sql);
    const app = appFor(u);
    expect([200, 201]).toContain((await post(app, body())).status);
    const list = await app.request("/trips");
    expect(((await list.json()) as unknown[]).length).toBe(1);
  });
  it("GET /trips/{tripId} 비멤버 → 403", async () => {
    const u1 = await mkUser(ctx.sql);
    const u2 = await mkUser(ctx.sql);
    const created = await post(appFor(u1), body());
    const id = ((await created.json()) as { id: string }).id;
    expect((await appFor(u2).request(`/trips/${id}`)).status).toBe(403);
  });
  it("입력 검증 실패(title 빈값) → 422", async () => {
    const u = await mkUser(ctx.sql);
    expect((await post(appFor(u), { ...body(), title: "" })).status).toBe(422);
  });
  it("멤버 GET·어드민 PATCH happy-path → 200 (finding #1 pass3)", async () => {
    const u = await mkUser(ctx.sql);
    const app = appFor(u);
    const id = ((await (await post(app, body())).json()) as { id: string }).id;
    expect((await app.request(`/trips/${id}`)).status).toBe(200);
    const patched = await app.request(`/trips/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "오사카" }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { title: string }).title).toBe("오사카");
  });
  it("역순 날짜 → 422 (finding #2/3)", async () => {
    const u = await mkUser(ctx.sql);
    expect(
      (await post(appFor(u), { ...body(), start_date: "2026-08-09", end_date: "2026-08-01" }))
        .status,
    ).toBe(422);
  });
  it("잘못된 달력 날짜 → 422 (finding #3 pass5)", async () => {
    const u = await mkUser(ctx.sql);
    expect((await post(appFor(u), { ...body(), start_date: "2026-99-99" })).status).toBe(422);
  });
  it("미지 통화 → 422(DB FK→ValidationError) (finding #2 pass3)", async () => {
    const u = await mkUser(ctx.sql);
    expect((await post(appFor(u), { ...body(), settlement_currency: "XYZ" })).status).toBe(422);
  });
  it("잘못된 timezone → 422 (finding #3 pass5)", async () => {
    const u = await mkUser(ctx.sql);
    expect((await post(appFor(u), { ...body(), timezone: "Mars/Phobos" })).status).toBe(422);
  });
});
