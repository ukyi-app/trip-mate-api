import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, mkTrip, type Ctx } from "../../../tests/db/helpers.ts";
import { createApp } from "../../core/openapi.ts";
import { registerErrorFilter } from "../../core/errors.ts";
import { DrizzleMemberRepo } from "../members/members.repo.ts";
import { DrizzleExpenseRepo } from "./expenses.repo.ts";
import { ExpensesService } from "./expenses.service.ts";
import { registerExpenseRoutes } from "./expenses.controller.ts";
import { MemoryCache } from "../fx/cache/cache.memory.ts";
import { DrizzleTripDefaults } from "../fx/trip-defaults.repo.ts";
import type { SessionResolver } from "../../core/guards.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

async function setup() {
  const u = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, u, "KRW");
  const m = await new DrizzleMemberRepo(ctx.db).ensureCreatorMembership({
    tripId: trip,
    userId: u,
    displayName: "A",
    email: "a@example.com",
  });
  return { u, trip, memberId: m.id };
}
function appFor(userId: string) {
  const app = createApp();
  registerErrorFilter(app);
  const repo = new DrizzleExpenseRepo(ctx.db);
  const service = new ExpensesService(ctx.db, repo, {
    providers: [],
    cache: new MemoryCache(),
    tripDefaults: new DrizzleTripDefaults(ctx.db),
  });
  const resolver: SessionResolver = async () => ({ user: { id: userId } });
  const memberLookup = (t: string, uid: string) =>
    new DrizzleMemberRepo(ctx.db).findMembership(t, uid);
  registerExpenseRoutes(app, {
    expensesService: service,
    resolver,
    memberLookup,
    idempotencyStore: null,
  });
  return app;
}
const body = (memberId: string, over = {}) => ({
  title: "스시",
  local_amount: "37900",
  local_currency: "KRW",
  spent_at: "2026-08-02T12:30:00.000Z",
  paid_by_member_id: memberId,
  participant_member_ids: [memberId],
  payment_method: "card",
  category: "food",
  ...over,
});
const postExp = async (app: ReturnType<typeof appFor>, trip: string, memberId: string) =>
  app.request(`/trips/${trip}/expenses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body(memberId)),
  });

describe("expenses 라우트", () => {
  it("POST → 201, GET 목록 1개, GET 상세, 돈 string 왕복", async () => {
    const { u, trip, memberId } = await setup();
    const app = appFor(u);
    const created = await postExp(app, trip, memberId);
    expect([200, 201]).toContain(created.status);
    const exp = (await created.json()) as {
      id: string;
      settlement_amount: string;
      version: number;
    };
    expect(exp.settlement_amount).toBe("37900");
    const list = await app.request(`/trips/${trip}/expenses`);
    expect(((await list.json()) as unknown[]).length).toBe(1);
    expect((await app.request(`/trips/${trip}/expenses/${exp.id}`)).status).toBe(200);
  });
  it("비멤버 → 403", async () => {
    const { trip, memberId } = await setup();
    const outsider = await mkUser(ctx.sql);
    const res = await postExp(appFor(outsider), trip, memberId);
    expect(res.status).toBe(403);
  });
  it("PATCH 메타(version CAS) → 200·version+1; stale version → 409", async () => {
    const { u, trip, memberId } = await setup();
    const app = appFor(u);
    const id = ((await (await postExp(app, trip, memberId)).json()) as { id: string }).id;
    const okRes = await app.request(`/trips/${trip}/expenses/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 0, title: "수정" }),
    });
    expect(okRes.status).toBe(200);
    const stale = await app.request(`/trips/${trip}/expenses/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 0, title: "재수정" }),
    });
    expect(stale.status).toBe(409);
  });
  it("DELETE(?version=) → soft delete, 이후 GET 404", async () => {
    const { u, trip, memberId } = await setup();
    const app = appFor(u);
    const id = ((await (await postExp(app, trip, memberId)).json()) as { id: string }).id;
    expect(
      (await app.request(`/trips/${trip}/expenses/${id}?version=0`, { method: "DELETE" })).status,
    ).toBe(200);
    expect((await app.request(`/trips/${trip}/expenses/${id}`)).status).toBe(404);
  });
  it("해결불가 통화(JPY, manual 없음) → 422 FxUnresolved", async () => {
    const { u, trip, memberId } = await setup();
    const res = await appFor(u).request(`/trips/${trip}/expenses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body(memberId, { local_currency: "JPY" })),
    });
    expect(res.status).toBe(422);
  });
  it("finalized trip → 생성 mutation 409(finding #2 pass1)", async () => {
    const { u, trip, memberId } = await setup();
    await ctx.sql`update trips set settlement_status='finalized' where id=${trip}`;
    const res = await postExp(appFor(u), trip, memberId);
    expect(res.status).toBe(409);
  });
});
