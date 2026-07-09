// 회귀 락 (gated-bugfix: expense-mutation-authz / G3)
// 단일 플립: 여행방의 joined 멤버이지만 대상 지출의 작성자도 결제자도 admin도 아닌 사용자가
// PATCH/DELETE로 남의 지출을 수정·삭제할 수 있다(현재 200) → 403이어야 한다.
// baseline(수정 전)에서 이 파일은 RED. symptomToken "G3-AUTHZ"는 제목·단언 메시지에 실려 RED 출력에 나타난다.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, mkTrip, mkMember, type Ctx } from "../db/helpers.ts";
import { createApp } from "../../src/core/openapi.ts";
import { registerErrorFilter } from "../../src/core/errors.ts";
import { DrizzleMemberRepo } from "../../src/modules/members/members.repo.ts";
import { DrizzleExpenseRepo } from "../../src/modules/expenses/expenses.repo.ts";
import { ExpensesService } from "../../src/modules/expenses/expenses.service.ts";
import { registerExpenseRoutes } from "../../src/modules/expenses/expenses.controller.ts";
import { MemoryCache } from "../../src/modules/fx/cache/cache.memory.ts";
import { DrizzleTripDefaults } from "../../src/modules/fx/trip-defaults.repo.ts";
import type { SessionResolver } from "../../src/core/guards.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

// 컨트롤러 테스트와 동일 하네스: session=userId 스텁, memberLookup은 실제 DrizzleMemberRepo.
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
    tripDefaults: new DrizzleTripDefaults(ctx.db),
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

// 소유자(작성자=결제자=admin creator) 아래에서 지출을 만들고, 무관한 joined 멤버를 반환.
async function ownerAndOutsider() {
  const owner = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, owner, "KRW");
  const ownerMember = await new DrizzleMemberRepo(ctx.db).ensureCreatorMembership({
    tripId: trip,
    userId: owner,
    displayName: "Owner",
    email: "owner@example.com",
  });
  const created = await appFor(owner).request(`/trips/${trip}/expenses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body(ownerMember.id)),
  });
  const expenseId = ((await created.json()) as { id: string }).id;
  // 무관한 사용자: 여행방의 joined 멤버지만 이 지출의 작성자도 결제자도 admin도 아님.
  const outsiderUser = await mkUser(ctx.sql);
  await mkMember(ctx.sql, trip, { userId: outsiderUser, role: "member", status: "joined" });
  return { trip, expenseId, outsiderUser };
}

describe("G3-AUTHZ: 지출 수정/삭제 소유권 인가", () => {
  it("G3-AUTHZ: 비소유·비결제·비어드민 멤버의 PATCH → 403", async () => {
    const { trip, expenseId, outsiderUser } = await ownerAndOutsider();
    const res = await appFor(outsiderUser).request(`/trips/${trip}/expenses/${expenseId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 0, title: "남의 지출 무단수정" }),
    });
    expect(res.status, "G3-AUTHZ: non-owner PATCH must be forbidden (403)").toBe(403);
  });

  it("G3-AUTHZ: 비소유·비결제·비어드민 멤버의 DELETE → 403", async () => {
    const { trip, expenseId, outsiderUser } = await ownerAndOutsider();
    const res = await appFor(outsiderUser).request(
      `/trips/${trip}/expenses/${expenseId}?version=0`,
      { method: "DELETE" },
    );
    expect(res.status, "G3-AUTHZ: non-owner DELETE must be forbidden (403)").toBe(403);
  });
});
