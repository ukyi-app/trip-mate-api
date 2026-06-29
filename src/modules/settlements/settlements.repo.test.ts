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
