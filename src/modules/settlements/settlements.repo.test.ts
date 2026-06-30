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
import { computeSettlement } from "./domain/compute.ts";
import { money } from "../../core/money.ts";

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
  const trip = await mkTrip(ctx.sql, u);
  const admin = await mkMember(ctx.sql, trip, { userId: u, role: "admin", status: "joined" });
  const u2 = await mkUser(ctx.sql);
  const m2 = await mkMember(ctx.sql, trip, { userId: u2, role: "member", status: "joined" });
  return { trip, admin, m2 };
}
const computeFrom = (
  rows: Awaited<ReturnType<DrizzleSettlementRepo<never>["listIncludedExpenses"]>>,
  members: string[],
) =>
  computeSettlement({
    expenses: rows.map((r) => ({
      id: r.id as never,
      paid_by: r.paid_by_member_id as never,
      participants: r.participant_member_ids as never[],
      local: money(r.local_amount, r.local_currency),
      settlement: money(r.settlement_amount, r.settlement_currency),
      ...(r.refund_of_expense_id ? { refund_of: r.refund_of_expense_id as never } : {}),
    })),
    members: members as never[],
  });

describe("DrizzleSettlementRepo", () => {
  it("listIncludedExpenses: included만·deleted 제외·participants 포함", async () => {
    const { trip, admin } = await setup();
    await mkExpense(ctx.sql, trip, admin);
    const repo = new DrizzleSettlementRepo(ctx.db);
    const rows = await repo.listIncludedExpenses(ctx.db, trip);
    expect(rows.length).toBe(1);
    expect(rows[0]!.paid_by_member_id).toBe(admin);
  });
  it("saveSnapshot: active 스냅샷+transfers·이전 active supersede", async () => {
    const { trip, admin, m2 } = await setup();
    const eid = await mkExpense(ctx.sql, trip, admin);
    await ctx.sql`insert into expense_participants (trip_id, expense_id, member_id) values (${trip}, ${eid}, ${admin}), (${trip}, ${eid}, ${m2})`;
    const repo = new DrizzleSettlementRepo(ctx.db);
    const rows = await repo.listIncludedExpenses(ctx.db, trip);
    const result = computeFrom(rows, [admin, m2]);
    const v1 = await ctx.db.transaction(async (tx) =>
      repo.saveSnapshot(tx, {
        tripId: trip,
        finalizedByMemberId: admin,
        result,
        settlementCurrency: "KRW",
      }),
    );
    expect(v1).toBe(1);
    const v2 = await ctx.db.transaction(async (tx) =>
      repo.saveSnapshot(tx, {
        tripId: trip,
        finalizedByMemberId: admin,
        result,
        settlementCurrency: "KRW",
      }),
    );
    expect(v2).toBe(2);
    const active =
      await ctx.sql`select version from settlements where trip_id=${trip} and status='active'`;
    expect(active.length).toBe(1); // 하나만 active(uq_settlement_active)
    expect(active[0]!.version).toBe(2);
  });
  it("mark-paid 스코프: finalized·active·settlement-basis만, open이면 null (finding #1 pass1)", async () => {
    const { trip, admin, m2 } = await setup();
    const eid = await mkExpense(ctx.sql, trip, admin);
    await ctx.sql`insert into expense_participants (trip_id, expense_id, member_id) values (${trip}, ${eid}, ${admin}), (${trip}, ${eid}, ${m2})`;
    const repo = new DrizzleSettlementRepo(ctx.db);
    const rows = await repo.listIncludedExpenses(ctx.db, trip);
    const result = computeFrom(rows, [admin, m2]);
    await ctx.db.transaction(async (tx) =>
      repo.saveSnapshot(tx, {
        tripId: trip,
        finalizedByMemberId: admin,
        result,
        settlementCurrency: "KRW",
      }),
    );
    const t =
      await ctx.sql`select id from settlement_transfers where trip_id=${trip} and basis='settlement' limit 1`;
    const tid = t[0]!.id as string;
    expect(await repo.getActiveSettlementTransfer(ctx.db, trip, tid)).toBeNull(); // open → 스코프 밖
    await ctx.sql`update trips set settlement_status='finalized' where id=${trip}`;
    expect(await repo.getActiveSettlementTransfer(ctx.db, trip, tid)).not.toBeNull();
    await repo.setTransferPaid(ctx.db, trip, tid, admin);
    expect(
      (await ctx.sql`select payment_status from settlement_transfers where id=${tid}`)[0]!
        .payment_status,
    ).toBe("paid");
    await repo.setTransferPaid(ctx.db, trip, tid, admin); // 멱등(0행)
    expect(await repo.hasActivePaidSettlementTransfer(ctx.db, trip)).toBe(true);
  });
});

describe("DrizzleSettlementRepo reversal/history", () => {
  async function finalizedScene() {
    const { trip, admin, m2 } = await setup();
    const eid = await mkExpense(ctx.sql, trip, admin);
    await ctx.sql`insert into expense_participants (trip_id, expense_id, member_id) values (${trip}, ${eid}, ${admin}), (${trip}, ${eid}, ${m2})`;
    const repo = new DrizzleSettlementRepo(ctx.db);
    const rows = await repo.listIncludedExpenses(ctx.db, trip);
    const result = computeFrom(rows, [admin, m2]);
    await ctx.db.transaction((tx) =>
      repo.saveSnapshot(tx, {
        tripId: trip,
        finalizedByMemberId: admin,
        result,
        settlementCurrency: "KRW",
      }),
    );
    await ctx.sql`update trips set settlement_status='finalized' where id=${trip}`;
    const t =
      await ctx.sql`select id, settlement_id from settlement_transfers where trip_id=${trip} and basis='settlement' limit 1`;
    return { trip, admin, m2, repo, tid: t[0]!.id as string, sid: t[0]!.settlement_id as string };
  }

  it("getActiveSettlementTransfer가 settlement_id 반환", async () => {
    const { trip, repo, tid, sid } = await finalizedScene();
    const x = await repo.getActiveSettlementTransfer(ctx.db, trip, tid);
    expect(x?.settlement_id).toBe(sid);
  });

  it("setTransferUnpaid: paid→pending CAS(paid_at·marked_by null)", async () => {
    const { trip, admin, repo, tid } = await finalizedScene();
    await repo.setTransferPaid(ctx.db, trip, tid, admin);
    await repo.setTransferUnpaid(ctx.db, trip, tid);
    const row =
      await ctx.sql`select payment_status, paid_at, marked_by_member_id from settlement_transfers where id=${tid}`;
    expect(row[0]!.payment_status).toBe("pending");
    expect(row[0]!.paid_at).toBeNull();
    expect(row[0]!.marked_by_member_id).toBeNull();
  });

  it("insertTransferEvent + listTransferEvents: seq desc(삽입 순서)", async () => {
    const { trip, admin, repo, tid, sid } = await finalizedScene();
    await repo.insertTransferEvent(ctx.db, {
      transferId: tid,
      tripId: trip,
      settlementId: sid,
      eventType: "paid",
      actorMemberId: admin,
    });
    await repo.insertTransferEvent(ctx.db, {
      transferId: tid,
      tripId: trip,
      settlementId: sid,
      eventType: "unpaid",
      actorMemberId: admin,
    });
    const ev = await repo.listTransferEvents(ctx.db, trip, tid);
    expect(ev.map((e) => e.event_type)).toEqual(["unpaid", "paid"]);
  });

  it("listTransferEvents: created_at 역전이어도 seq(삽입 순서)로 정렬", async () => {
    const { trip, admin, repo, tid, sid } = await finalizedScene();
    await ctx.sql`insert into settlement_transfer_events (transfer_id, trip_id, settlement_id, event_type, actor_member_id, created_at)
      values (${tid}, ${trip}, ${sid}, 'paid', ${admin}, '2030-01-01T00:00:00Z')`;
    await ctx.sql`insert into settlement_transfer_events (transfer_id, trip_id, settlement_id, event_type, actor_member_id, created_at)
      values (${tid}, ${trip}, ${sid}, 'unpaid', ${admin}, '2020-01-01T00:00:00Z')`;
    const ev = await repo.listTransferEvents(ctx.db, trip, tid);
    expect(ev.map((e) => e.event_type)).toEqual(["unpaid", "paid"]); // 둘째 삽입(unpaid)이 seq 큼
  });

  it("getTransferTripScope: 존재=true, 부재=false", async () => {
    const { trip, repo, tid } = await finalizedScene();
    expect(await repo.getTransferTripScope(ctx.db, trip, tid)).toBe(true);
    expect(
      await repo.getTransferTripScope(ctx.db, trip, "11111111-1111-4111-8111-111111111111"),
    ).toBe(false);
  });

  it("listSettlementVersions: 재스냅샷 후 [v2 active, v1 superseded]", async () => {
    const { trip, admin, m2, repo } = await finalizedScene();
    const rows = await repo.listIncludedExpenses(ctx.db, trip);
    await ctx.db.transaction((tx) =>
      repo.saveSnapshot(tx, {
        tripId: trip,
        finalizedByMemberId: admin,
        result: computeFrom(rows, [admin, m2]),
        settlementCurrency: "KRW",
      }),
    );
    const vs = await repo.listSettlementVersions(ctx.db, trip);
    expect(vs.map((v) => [v.version, v.status])).toEqual([
      [2, "active"],
      [1, "superseded"],
    ]);
  });
});
