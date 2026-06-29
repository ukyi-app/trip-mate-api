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
import { DrizzleExpenseRepo } from "../expenses/expenses.repo.ts";
import { ExpensesService } from "../expenses/expenses.service.ts";
import { MemoryCache } from "../fx/cache/cache.memory.ts";
import { DrizzleTripDefaults } from "../fx/trip-defaults.repo.ts";

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
  return { trip, admin };
}
const settle = () => new SettlementsService(ctx.db, new DrizzleSettlementRepo(ctx.db));
const expensesSvc = () =>
  new ExpensesService(ctx.db, new DrizzleExpenseRepo(ctx.db), {
    providers: [],
    cache: new MemoryCache(),
    tripDefaults: new DrizzleTripDefaults(ctx.db),
  });
const input = (memberId: string) => ({
  title: "추가",
  local_amount: "1000",
  local_currency: "KRW",
  spent_at: "2026-08-03T10:00:00.000Z",
  paid_by_member_id: memberId,
  participant_member_ids: [memberId],
  payment_method: "card" as const,
  category: "food" as const,
});

describe("settlement ↔ expense 상호 직렬화", () => {
  it("finalize 후 expense create → 409, unlock 후 재허용", async () => {
    const { trip, admin } = await scene();
    const s = settle();
    const seen = (await s.getSettlement(trip)).seen_versions.map((v) => ({
      expense_id: v.expense_id,
      version: v.version,
    }));
    await s.finalize(trip, seen, { memberId: admin, role: "admin" });
    // finalized trip → expense 생성 차단(409)
    await expect(
      expensesSvc().createExpense(trip, input(admin), { memberId: admin }),
    ).rejects.toMatchObject({ status: 409 });
    // unlock → 재허용
    await s.unlock(trip, { memberId: admin, role: "admin" });
    const created = await expensesSvc().createExpense(trip, input(admin), { memberId: admin });
    expect(created.id).toBeDefined();
  });
});
