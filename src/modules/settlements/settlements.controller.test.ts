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
});
