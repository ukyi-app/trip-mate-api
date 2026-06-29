import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startDb,
  mkUser,
  mkTrip,
  mkMember,
  mkExpense,
  type Ctx,
} from "../../../tests/db/helpers.ts";
import { DrizzleSettlementRepo } from "./settlements.repo.ts";
import { SettlementsService } from "./settlements.service.ts";

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
  const eid = await mkExpense(ctx.sql, trip, admin); // paid_by admin, 9320 KRW
  await ctx.sql`insert into expense_participants (trip_id, expense_id, member_id) values (${trip}, ${eid}, ${admin}), (${trip}, ${eid}, ${m2})`;
  return { trip, admin, m2, eid };
}
const svc = () => new SettlementsService(ctx.db, new DrizzleSettlementRepo(ctx.db));
const seenOf = (live: Awaited<ReturnType<SettlementsService<never>["getSettlement"]>>) =>
  live.seen_versions.map((v) => ({ expense_id: v.expense_id, version: v.version }));

describe("SettlementsService", () => {
  it("getSettlement: 라이브 계산·seen_versions·transfers", async () => {
    const { trip, eid } = await scene();
    const s = await svc().getSettlement(trip);
    expect(s.settlement_status).toBe("open");
    expect(s.seen_versions.some((v) => v.expense_id === eid)).toBe(true);
    expect(s.transfers.length).toBeGreaterThanOrEqual(1); // m2→admin
  });
  it("finalize: 스냅샷·trips finalized·version 1", async () => {
    const { trip, admin } = await scene();
    const live = await svc().getSettlement(trip);
    const r = await svc().finalize(trip, seenOf(live), { memberId: admin, role: "admin" });
    expect(r.version).toBe(1);
    expect(r.settlement_status).toBe("finalized");
    expect(
      (await ctx.sql`select settlement_status from trips where id=${trip}`)[0]!.settlement_status,
    ).toBe("finalized");
  });
  it("finalize: reviewed-set drift(버전 불일치) → 409", async () => {
    const { trip, admin, eid } = await scene();
    await expect(
      svc().finalize(trip, [{ expense_id: eid, version: 999 }], { memberId: admin, role: "admin" }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("finalize: 이미 finalized → 409", async () => {
    const { trip, admin } = await scene();
    const seen = seenOf(await svc().getSettlement(trip));
    await svc().finalize(trip, seen, { memberId: admin, role: "admin" });
    await expect(
      svc().finalize(trip, seen, { memberId: admin, role: "admin" }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("unlock: finalized→open", async () => {
    const { trip, admin } = await scene();
    await svc().finalize(trip, seenOf(await svc().getSettlement(trip)), {
      memberId: admin,
      role: "admin",
    });
    await svc().unlock(trip, { memberId: admin, role: "admin" });
    expect(
      (await ctx.sql`select settlement_status from trips where id=${trip}`)[0]!.settlement_status,
    ).toBe("open");
  });
  it("mark-paid: 비-수취인·비-admin → 403 (인가 선행, finding #1 pass1)", async () => {
    const { trip, admin, m2 } = await scene();
    await svc().finalize(trip, seenOf(await svc().getSettlement(trip)), {
      memberId: admin,
      role: "admin",
    });
    const t =
      await ctx.sql`select id, to_member_id from settlement_transfers where trip_id=${trip} and basis='settlement' limit 1`;
    const tid = t[0]!.id as string;
    const recipient = t[0]!.to_member_id as string;
    const other = recipient === admin ? m2 : admin;
    if (other !== admin)
      await expect(
        svc().markPaid(trip, tid, { memberId: other, role: "member" }),
      ).rejects.toMatchObject({ status: 403 });
  });
  it("unlock 후 지출 편집 → GET은 라이브(stale 스냅샷 미사용, finding #2 pass1)", async () => {
    const { trip, admin } = await scene();
    await svc().finalize(trip, seenOf(await svc().getSettlement(trip)), {
      memberId: admin,
      role: "admin",
    });
    await svc().unlock(trip, { memberId: admin, role: "admin" });
    await ctx.sql`update expenses set settlement_amount = settlement_amount + 1000, version = version + 1 where trip_id=${trip}`;
    const after = await svc().getSettlement(trip);
    expect(after.settlement_status).toBe("open");
    expect(after.version).toBeNull();
  });
  it("paid transfer 있으면 unlock → 409 (finding #1 pass2)", async () => {
    const { trip, admin } = await scene();
    await svc().finalize(trip, seenOf(await svc().getSettlement(trip)), {
      memberId: admin,
      role: "admin",
    });
    const t =
      await ctx.sql`select id from settlement_transfers where trip_id=${trip} and basis='settlement' limit 1`;
    await svc().markPaid(trip, t[0]!.id as string, { memberId: admin, role: "admin" }); // admin이 mark-paid
    await expect(svc().unlock(trip, { memberId: admin, role: "admin" })).rejects.toMatchObject({
      status: 409,
    });
  });
});
