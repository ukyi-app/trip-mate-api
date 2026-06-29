import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, mkTrip, type Ctx } from "../../../tests/db/helpers.ts";
import { DrizzleMemberRepo } from "../members/members.repo.ts";
import { DrizzleExpenseRepo, type ExpenseSnapshot } from "./expenses.repo.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

// trip(tz=Asia/Seoul, settlement=KRW) + 어드민 멤버십(member_id 확보)
async function setup() {
  const u = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, u); // 기본 KRW·timezone Asia/Seoul
  const m = await new DrizzleMemberRepo(ctx.db).ensureCreatorMembership({
    tripId: trip,
    userId: u,
    displayName: "A",
    email: "a@example.com",
  });
  return { u, trip, memberId: m.id };
}
const snapshot = (over: Partial<ExpenseSnapshot> = {}) => ({
  timezone: "Asia/Seoul",
  title: "스시",
  local_amount: 37900n,
  local_currency: "JPY",
  settlement_amount: 350000n,
  settlement_currency: "KRW",
  exchange_rate: "9.2345678900",
  exchange_rate_date: "2026-08-02",
  exchange_rate_source: "auto" as const,
  exchange_rate_provider: "oxr",
  exchange_rate_table_date: "2026-08-02",
  exchange_rate_fetched_at: new Date(),
  settlement_amount_source: "converted" as const,
  payment_method: "card",
  category: "food",
  spent_at: new Date("2026-08-02T12:30:00Z"),
  expense_settlement_state: "included" as const,
  memo: null,
  ...over,
});
const mk = (
  trip: string,
  memberId: string,
  over: Partial<ExpenseSnapshot> = {},
): ExpenseSnapshot => ({
  ...snapshot(over),
  trip_id: trip,
  paid_by_member_id: memberId,
  created_by_member_id: memberId,
  participant_member_ids: [memberId],
});

describe("DrizzleExpenseRepo", () => {
  it("create(snapshot+참여자+audit) → findById 조립", async () => {
    const { trip, memberId } = await setup();
    const repo = new DrizzleExpenseRepo(ctx.db);
    const exp = await repo.create(mk(trip, memberId));
    expect(exp.version).toBe(0);
    const found = await repo.findById(trip, exp.id);
    expect(found?.settlement_amount).toBe(350000n);
    expect(found?.participant_member_ids).toEqual([memberId]);
  });
  it("updateMeta CAS: version 일치 시 +1, 불일치 0행", async () => {
    const { trip, memberId } = await setup();
    const repo = new DrizzleExpenseRepo(ctx.db);
    const exp = await repo.create(mk(trip, memberId));
    const ok = await repo.updateMeta(trip, exp.id, 0, { title: "수정" }, memberId);
    expect(ok?.version).toBe(1);
    expect(await repo.updateMeta(trip, exp.id, 0, { title: "stale" }, memberId)).toBeNull(); // 이미 v1
  });
  it("softDelete CAS: deleted_at 셋·이후 findById null", async () => {
    const { trip, memberId } = await setup();
    const repo = new DrizzleExpenseRepo(ctx.db);
    const exp = await repo.create(mk(trip, memberId));
    expect(await repo.softDelete(trip, exp.id, 0, memberId)).toBe(true);
    expect(await repo.findById(trip, exp.id)).toBeNull();
  });
  it("stale timezone(snapshot.timezone ≠ 현재 trip tz) → create 409(finding #3 pass3)", async () => {
    const { trip, memberId } = await setup();
    const repo = new DrizzleExpenseRepo(ctx.db);
    await expect(
      repo.create(mk(trip, memberId, { timezone: "Europe/London" })),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("audit: update는 before/after 전체 스냅샷 기록(finding #3 pass1)", async () => {
    const { trip, memberId } = await setup();
    const repo = new DrizzleExpenseRepo(ctx.db);
    const exp = await repo.create(mk(trip, memberId));
    await repo.updateMeta(trip, exp.id, 0, { title: "수정됨" }, memberId);
    const logs = await ctx.sql<
      {
        change_type: string;
        before_value: { title: string } | null;
        after_value: { title: string } | null;
      }[]
    >`
      select change_type, before_value, after_value from expense_audit_logs where expense_id=${exp.id} order by created_at`;
    const upd = logs.find((l) => l.change_type === "update")!;
    expect(upd.before_value?.title).toBe("스시"); // 변경 전 보존
    expect(upd.after_value?.title).toBe("수정됨"); // 변경 후 보존
  });
});
