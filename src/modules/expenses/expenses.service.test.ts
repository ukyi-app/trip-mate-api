import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, mkTrip, type Ctx } from "../../../tests/db/helpers.ts";
import { DrizzleMemberRepo } from "../members/members.repo.ts";
import { DrizzleExpenseRepo } from "./expenses.repo.ts";
import { ExpensesService } from "./expenses.service.ts";
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

// providers 빈 배열 + MemoryCache(빈) + tripDefaults(빈) → identity/manual만 해결, 그 외 needsManual
function svc() {
  const repo = new DrizzleExpenseRepo(ctx.db);
  const fxDeps = {
    providers: [],
    cache: new MemoryCache(),
    tripDefaults: new DrizzleTripDefaults(ctx.db),
  };
  return new ExpensesService(ctx.db, repo, fxDeps);
}
async function setup(settlement = "KRW") {
  const u = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, u, settlement);
  const m = await new DrizzleMemberRepo(ctx.db).ensureCreatorMembership({
    tripId: trip,
    userId: u,
    displayName: "A",
    email: "a@example.com",
  });
  return { u, trip, memberId: m.id };
}
const input = (memberId: string, over = {}) => ({
  title: "스시",
  local_amount: "37900",
  local_currency: "KRW", // identity(정산=KRW)로 결정적
  spent_at: "2026-08-02T12:30:00.000Z",
  paid_by_member_id: memberId,
  participant_member_ids: [memberId],
  payment_method: "card" as const,
  category: "food" as const,
  ...over,
});

describe("ExpensesService", () => {
  it("identity(현지=정산) → settlement_amount=local, source=identity 저장", async () => {
    const { trip, memberId } = await setup("KRW");
    const exp = await svc().createExpense(trip, input(memberId), { memberId });
    expect(exp.settlement_amount).toBe(37900n);
    expect(exp.exchange_rate_source).toBe("identity");
  });
  it("card_billed: settlement_amount=입력값·source=card_billed·rate null", async () => {
    const { trip, memberId } = await setup("KRW");
    const exp = await svc().createExpense(
      trip,
      input(memberId, { local_currency: "JPY", card_billed_settlement_amount: "350000" }),
      { memberId },
    );
    expect(exp.settlement_amount).toBe(350000n);
    expect(exp.settlement_amount_source).toBe("card_billed");
    expect(exp.exchange_rate_source).toBeNull();
  });
  it("편집재계산: local_amount 변경 → settlement_amount 재계산·local도 영속(identity, finding #1 pass3)", async () => {
    const { trip, memberId } = await setup("KRW");
    const exp = await svc().createExpense(trip, input(memberId), { memberId }); // KRW identity 37900
    const updated = await svc().updateExpense(
      trip,
      exp.id,
      { version: 0, local_amount: "50000" },
      { memberId, role: "admin" },
    );
    expect(updated.settlement_amount).toBe(50000n); // identity 재계산
    expect(updated.local_amount).toBe(50000n); // local 원본도 갱신
    expect((await svc().getExpense(trip, exp.id)).local_amount).toBe(50000n); // 재로드 정합
  });
  it("source 전환(card_billed→converted) 시도 → 422", async () => {
    const { trip, memberId } = await setup("KRW");
    const exp = await svc().createExpense(
      trip,
      input(memberId, { local_currency: "JPY", card_billed_settlement_amount: "350000" }),
      { memberId },
    );
    await expect(
      svc().updateExpense(
        trip,
        exp.id,
        { version: 0, local_amount: "1", manualRate: "9" },
        { memberId, role: "admin" },
      ),
    ).rejects.toMatchObject({ status: 422 });
  });
  it("편집재계산 미해결(JPY·manual 없음·provider 없음) → 422·구행 보존(finding #2 pass1)", async () => {
    const { trip, memberId } = await setup("KRW");
    const exp = await svc().createExpense(trip, input(memberId), { memberId }); // KRW identity 37900
    await expect(
      svc().updateExpense(
        trip,
        exp.id,
        { version: 0, local_currency: "JPY", local_amount: "1000" },
        { memberId, role: "admin" },
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect((await svc().getExpense(trip, exp.id)).settlement_amount).toBe(37900n); // 구행 보존
  });
  it("manualRate 제공(현지≠정산) → manual 환산 저장", async () => {
    const { trip, memberId } = await setup("KRW");
    const exp = await svc().createExpense(
      trip,
      input(memberId, { local_currency: "JPY", manualRate: "9" }),
      { memberId },
    );
    expect(exp.exchange_rate_source).toBe("manual");
  });
  it("해결 불가(JPY, manual 없음, provider 없음) → FxUnresolvedError(422)", async () => {
    const { trip, memberId } = await setup("KRW");
    await expect(
      svc().createExpense(trip, input(memberId, { local_currency: "JPY" }), { memberId }),
    ).rejects.toMatchObject({ status: 422, code: "FxUnresolvedError" });
  });
  it("미지 통화 → 422(currencies 부재)", async () => {
    const { trip, memberId } = await setup("KRW");
    await expect(
      svc().createExpense(trip, input(memberId, { local_currency: "XYZ" }), { memberId }),
    ).rejects.toMatchObject({ status: 422 });
  });
  it("finalized trip → 생성 409(잠금, finding #2 pass1)", async () => {
    const { trip, memberId } = await setup("KRW");
    await ctx.sql`update trips set settlement_status='finalized' where id=${trip}`;
    await expect(svc().createExpense(trip, input(memberId), { memberId })).rejects.toMatchObject({
      status: 409,
    });
  });
});
