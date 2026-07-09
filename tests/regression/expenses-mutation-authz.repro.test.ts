// 원본 증상 repro (gated-bugfix release 증거: R-1).
// 사용자 시나리오 그대로: 여행방 joined 멤버지만 대상 지출의 작성자·결제자·admin이 아닌 사람이
// 남의 지출을 수정하려 한다. 수정 전 baseline에서는 200(성공)으로 "증상 재현", fix 후에는 403.
// 이 파일은 회귀 6케이스 매트릭스와 별개의 단일 시나리오 repro이며, symptomToken("G3-AUTHZ")을
// 제목·메시지에 쓰지 않는다(--verify-flip repro-gone 판정이 토큰에 오염되지 않도록).
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

describe("원본 증상 repro: 남의 지출 무단 수정", () => {
  it("여행방 멤버(비작성·비결제·비admin)의 타인 지출 수정 시도 → 거부(403)", async () => {
    // 1) owner(admin)가 여행방과 지출을 만든다(작성자=결제자=owner).
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
      body: JSON.stringify({
        title: "스시",
        local_amount: "37900",
        local_currency: "KRW",
        spent_at: "2026-08-02T12:30:00.000Z",
        paid_by_member_id: ownerMember.id,
        participant_member_ids: [ownerMember.id],
        payment_method: "card",
        category: "food",
      }),
    });
    const expenseId = ((await created.json()) as { id: string }).id;

    // 2) 무관한 사용자가 여행방에 합류(joined member지만 이 지출의 작성자·결제자·admin 아님).
    const outsider = await mkUser(ctx.sql);
    await mkMember(ctx.sql, trip, { userId: outsider, role: "member", status: "joined" });

    // 3) 그 사용자가 남의 지출을 수정하려 한다. 증상(수정 성공)은 재현되면 안 되고 403이어야 한다.
    const res = await appFor(outsider).request(`/trips/${trip}/expenses/${expenseId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 0, title: "무단수정" }),
    });
    expect(res.status, "타인 지출 무단 수정은 거부되어야 한다").toBe(403);
  });
});
