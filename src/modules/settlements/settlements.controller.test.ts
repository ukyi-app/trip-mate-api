import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startDb,
  mkUser,
  mkTrip,
  mkMember,
  mkExpense,
  type Ctx,
} from "../../../tests/db/helpers.ts";
import { createApp } from "../../core/openapi.ts";
import { registerErrorFilter } from "../../core/errors.ts";
import { DrizzleMemberRepo } from "../members/members.repo.ts";
import { DrizzleSettlementRepo } from "./settlements.repo.ts";
import { SettlementsService } from "./settlements.service.ts";
import { registerSettlementRoutes } from "./settlements.controller.ts";
import type { SessionResolver } from "../../core/guards.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

async function scene() {
  const u = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, u);
  const admin = await mkMember(ctx.sql, trip, { userId: u, role: "admin", status: "joined" });
  const u2 = await mkUser(ctx.sql);
  const m2 = await mkMember(ctx.sql, trip, { userId: u2, role: "member", status: "joined" });
  const eid = await mkExpense(ctx.sql, trip, admin);
  await ctx.sql`insert into expense_participants (trip_id, expense_id, member_id) values (${trip}, ${eid}, ${admin}), (${trip}, ${eid}, ${m2})`;
  return { trip, u, u2, admin, m2, eid };
}
function appFor(userId: string) {
  const app = createApp();
  registerErrorFilter(app);
  const service = new SettlementsService(ctx.db, new DrizzleSettlementRepo(ctx.db));
  const resolver: SessionResolver = async () => ({ user: { id: userId } });
  const memberLookup = (t: string, uid: string) =>
    new DrizzleMemberRepo(ctx.db).findMembership(t, uid);
  registerSettlementRoutes(app, {
    settlementsService: service,
    resolver,
    memberLookup,
    idempotencyStore: null,
  });
  return app;
}
const getSeen = async (app: ReturnType<typeof appFor>, trip: string) =>
  (
    (await (await app.request(`/trips/${trip}/settlement`)).json()) as {
      seen_versions: { expense_id: string; version: number }[];
    }
  ).seen_versions;
const finalize = (app: ReturnType<typeof appFor>, trip: string, seen: unknown) =>
  app.request(`/trips/${trip}/settlement/finalize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ seen_expense_versions: seen }),
  });
const aTid = async (trip: string) =>
  (
    await ctx.sql`select id from settlement_transfers where trip_id=${trip} and basis='settlement' limit 1`
  )[0]!.id as string;
const markPaid = (app: ReturnType<typeof appFor>, trip: string, tid: string) =>
  app.request(`/trips/${trip}/settlement/transfers/${tid}/mark-paid`, { method: "POST" });
const markUnpaid = (app: ReturnType<typeof appFor>, trip: string, tid: string) =>
  app.request(`/trips/${trip}/settlement/transfers/${tid}/mark-unpaid`, { method: "POST" });
const unlock = (app: ReturnType<typeof appFor>, trip: string) =>
  app.request(`/trips/${trip}/settlement/unlock`, { method: "POST" });

describe("settlement 라우트", () => {
  it("GET → 200·transfers, admin finalize → 200·finalized", async () => {
    const { trip, u } = await scene();
    const app = appFor(u);
    const get = await app.request(`/trips/${trip}/settlement`);
    expect(get.status).toBe(200);
    const seen = await getSeen(app, trip);
    const fin = await finalize(app, trip, seen);
    expect(fin.status).toBe(200);
    expect(((await fin.json()) as { settlement_status: string }).settlement_status).toBe(
      "finalized",
    );
  });
  it("비-admin finalize → 403", async () => {
    const { trip, u, u2 } = await scene();
    const seen = await getSeen(appFor(u), trip);
    expect((await finalize(appFor(u2), trip, seen)).status).toBe(403); // u2=member
  });
  it("reviewed-set drift → 409", async () => {
    const { trip, u, eid } = await scene();
    expect((await finalize(appFor(u), trip, [{ expense_id: eid, version: 999 }])).status).toBe(409);
  });
  it("mark-paid: admin → 200(paid)", async () => {
    const { trip, u } = await scene();
    const app = appFor(u);
    await finalize(app, trip, await getSeen(app, trip));
    const t =
      await ctx.sql`select id from settlement_transfers where trip_id=${trip} and basis='settlement' limit 1`;
    const res = await app.request(`/trips/${trip}/settlement/transfers/${t[0]!.id}/mark-paid`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { payment_status: string }).payment_status).toBe("paid");
  });

  it("mark-unpaid: 수취인 → 200(pending), 회귀: 이후 unlock 가능", async () => {
    const { trip, u } = await scene();
    const app = appFor(u);
    await finalize(app, trip, await getSeen(app, trip));
    const tid = await aTid(trip);
    await markPaid(app, trip, tid); // admin=수취인
    const res = await markUnpaid(app, trip, tid);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { payment_status: string }).payment_status).toBe("pending");
    expect((await unlock(app, trip)).status).toBe(200); // reversal로 paid 없음 → unlock 가능
  });
  it("mark-unpaid: 비수취인·비admin(member) → 403", async () => {
    const { trip, u, u2 } = await scene();
    const app = appFor(u);
    await finalize(app, trip, await getSeen(app, trip));
    const tid = await aTid(trip);
    await markPaid(app, trip, tid);
    expect((await markUnpaid(appFor(u2), trip, tid)).status).toBe(403); // u2=member, 수취인 아님
  });
  it("mark-unpaid: 미존재 transfer → 404", async () => {
    const { trip, u } = await scene();
    const app = appFor(u);
    await finalize(app, trip, await getSeen(app, trip));
    const res = await markUnpaid(app, trip, "11111111-1111-4111-8111-111111111111");
    expect(res.status).toBe(404);
  });
  it("mark-unpaid: finalized 아님(unlock 후) → 409", async () => {
    const { trip, u } = await scene();
    const app = appFor(u);
    await finalize(app, trip, await getSeen(app, trip));
    const tid = await aTid(trip);
    await unlock(app, trip); // pending이라 가능
    expect((await markUnpaid(app, trip, tid)).status).toBe(409);
  });
  it("GET history: 재확정 후 2건(v2 active, v1 superseded)", async () => {
    const { trip, u } = await scene();
    const app = appFor(u);
    await finalize(app, trip, await getSeen(app, trip));
    await unlock(app, trip);
    await finalize(app, trip, await getSeen(app, trip));
    const res = await app.request(`/trips/${trip}/settlement/history`);
    expect(res.status).toBe(200);
    const h = (await res.json()) as { version: number; status: string }[];
    expect(h.map((x) => [x.version, x.status])).toEqual([
      [2, "active"],
      [1, "superseded"],
    ]);
  });
  it("GET events: paid→unpaid 후 2건, 타 transfer → 404", async () => {
    const { trip, u } = await scene();
    const app = appFor(u);
    await finalize(app, trip, await getSeen(app, trip));
    const tid = await aTid(trip);
    await markPaid(app, trip, tid);
    await markUnpaid(app, trip, tid);
    const res = await app.request(`/trips/${trip}/settlement/transfers/${tid}/events`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(2);
    const nf = await app.request(
      `/trips/${trip}/settlement/transfers/11111111-1111-4111-8111-111111111111/events`,
    );
    expect(nf.status).toBe(404);
  });
});
