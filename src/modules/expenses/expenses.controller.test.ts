import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, mkTrip, mkMember, type Ctx } from "../../../tests/db/helpers.ts";
import { createApp } from "../../core/openapi.ts";
import { registerErrorFilter } from "../../core/errors.ts";
import { DrizzleMemberRepo } from "../members/members.repo.ts";
import { DrizzleExpenseRepo } from "./expenses.repo.ts";
import { ExpensesService } from "./expenses.service.ts";
import { registerExpenseRoutes } from "./expenses.controller.ts";
import { MemoryCache } from "../fx/cache/cache.memory.ts";
import { DrizzleTripDefaults } from "../fx/trip-defaults.repo.ts";
import type { SessionResolver } from "../../core/guards.ts";

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
  const trip = await mkTrip(ctx.sql, u, "KRW");
  const m = await new DrizzleMemberRepo(ctx.db).ensureCreatorMembership({
    tripId: trip,
    userId: u,
    displayName: "A",
    email: "a@example.com",
  });
  return { u, trip, memberId: m.id };
}
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
const postExp = async (app: ReturnType<typeof appFor>, trip: string, memberId: string) =>
  app.request(`/trips/${trip}/expenses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body(memberId)),
  });

describe("expenses 라우트", () => {
  it("preview: identity → per_member 균등분할(미영속)", async () => {
    const { u, trip, memberId } = await setup();
    const res = await appFor(u).request(`/trips/${trip}/expenses/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body(memberId)),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { per_member: unknown[] }).per_member.length).toBe(1);
    expect(
      ((await (await appFor(u).request(`/trips/${trip}/expenses`)).json()) as { items: unknown[] })
        .items.length,
    ).toBe(0); // 미영속
  });
  it("preview: 미지/타-trip member_id → 422(멤버십 검증, finding #2 pass2)", async () => {
    const { u, trip } = await setup();
    const outsider = "11111111-1111-4111-8111-111111111111";
    const res = await appFor(u).request(`/trips/${trip}/expenses/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body(outsider)),
    });
    expect(res.status).toBe(422);
  });
  it("POST → 201, GET 목록 1개, GET 상세, 돈 string 왕복", async () => {
    const { u, trip, memberId } = await setup();
    const app = appFor(u);
    const created = await postExp(app, trip, memberId);
    expect([200, 201]).toContain(created.status);
    const exp = (await created.json()) as {
      id: string;
      settlement_amount: string;
      version: number;
    };
    expect(exp.settlement_amount).toBe("37900");
    const list = await app.request(`/trips/${trip}/expenses`);
    expect(((await list.json()) as { items: unknown[] }).items.length).toBe(1);
    expect((await app.request(`/trips/${trip}/expenses/${exp.id}`)).status).toBe(200);
  });
  it("비멤버 → 403", async () => {
    const { trip, memberId } = await setup();
    const outsider = await mkUser(ctx.sql);
    const res = await postExp(appFor(outsider), trip, memberId);
    expect(res.status).toBe(403);
  });
  it("PATCH 메타(version CAS) → 200·version+1; stale version → 409", async () => {
    const { u, trip, memberId } = await setup();
    const app = appFor(u);
    const id = ((await (await postExp(app, trip, memberId)).json()) as { id: string }).id;
    const okRes = await app.request(`/trips/${trip}/expenses/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 0, title: "수정" }),
    });
    expect(okRes.status).toBe(200);
    const stale = await app.request(`/trips/${trip}/expenses/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 0, title: "재수정" }),
    });
    expect(stale.status).toBe(409);
  });
  it("DELETE(?version=) → soft delete, 이후 GET 404", async () => {
    const { u, trip, memberId } = await setup();
    const app = appFor(u);
    const id = ((await (await postExp(app, trip, memberId)).json()) as { id: string }).id;
    expect(
      (await app.request(`/trips/${trip}/expenses/${id}?version=0`, { method: "DELETE" })).status,
    ).toBe(200);
    expect((await app.request(`/trips/${trip}/expenses/${id}`)).status).toBe(404);
  });
  it("해결불가 통화(JPY, manual 없음) → 422 FxUnresolved", async () => {
    const { u, trip, memberId } = await setup();
    const res = await appFor(u).request(`/trips/${trip}/expenses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body(memberId, { local_currency: "JPY" })),
    });
    expect(res.status).toBe(422);
  });
  it("finalized trip → 생성 mutation 409(finding #2 pass1)", async () => {
    const { u, trip, memberId } = await setup();
    await ctx.sql`update trips set settlement_status='finalized' where id=${trip}`;
    const res = await postExp(appFor(u), trip, memberId);
    expect(res.status).toBe(409);
  });
  it("PUT fx-defaults(admin) → 200, 이후 JPY expense가 trip_default로 해석", async () => {
    const { u, trip, memberId } = await setup();
    const app = appFor(u);
    const put = await app.request(`/trips/${trip}/fx-defaults`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_currency: "JPY", settlement_currency: "KRW", rate: "9.5" }),
    });
    expect(put.status).toBe(200);
    const res = await app.request(`/trips/${trip}/expenses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body(memberId, { local_currency: "JPY" })),
    });
    expect([200, 201]).toContain(res.status); // provider 없음·manual 없음인데 trip_default 9.5로 해석
  });
  it("비-admin 멤버 PUT fx-defaults → 403", async () => {
    const { trip } = await setup();
    const u2 = await mkUser(ctx.sql);
    await mkMember(ctx.sql, trip, { userId: u2, role: "member", status: "joined" });
    const res = await appFor(u2).request(`/trips/${trip}/fx-defaults`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_currency: "JPY", settlement_currency: "KRW", rate: "9.5" }),
    });
    expect(res.status).toBe(403);
  });
  it("fx-defaults: 0·round-to-zero·oversize rate → 422(정규화, finding #3 pass1)", async () => {
    const { u, trip } = await setup();
    const app = appFor(u);
    for (const rate of ["0", "0.00000000001", "99999999999"]) {
      const res = await app.request(`/trips/${trip}/fx-defaults`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ base_currency: "JPY", settlement_currency: "KRW", rate }),
      });
      expect(res.status).toBe(422);
    }
  });

  it("GET 목록: {items, next_cursor} 커서 페이징(무중복·무누락)", async () => {
    const { u, trip, memberId } = await setup();
    const app = appFor(u);
    const made: string[] = [];
    for (const min of ["01", "02", "03"]) {
      const r = await app.request(`/trips/${trip}/expenses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body(memberId, { spent_at: `2026-08-02T12:${min}:00.000Z` })),
      });
      made.push(((await r.json()) as { id: string }).id);
    }
    const p1 = (await (await app.request(`/trips/${trip}/expenses?limit=2`)).json()) as {
      items: { id: string }[];
      next_cursor: string | null;
    };
    expect(p1.items.length).toBe(2);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = (await (
      await app.request(
        `/trips/${trip}/expenses?limit=2&cursor=${encodeURIComponent(p1.next_cursor as string)}`,
      )
    ).json()) as { items: { id: string }[]; next_cursor: string | null };
    expect(p2.items.length).toBe(1);
    expect(p2.next_cursor).toBeNull();
    const seen = [...p1.items, ...p2.items].map((e) => e.id);
    expect(new Set(seen).size).toBe(3); // 무중복
    expect([...seen].sort()).toEqual([...made].sort()); // 무누락
  });

  it("GET 목록: 디코드 불가 커서 → 422", async () => {
    const { u, trip } = await setup();
    const res = await appFor(u).request(`/trips/${trip}/expenses?cursor=not_a_valid_cursor`);
    expect(res.status).toBe(422);
  });

  it("GET 목록: category 필터 end-to-end", async () => {
    const { u, trip, memberId } = await setup();
    const app = appFor(u);
    await app.request(`/trips/${trip}/expenses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body(memberId, { category: "food" })),
    });
    await app.request(`/trips/${trip}/expenses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        body(memberId, { category: "transport", spent_at: "2026-08-02T13:00:00.000Z" }),
      ),
    });
    const res = (await (
      await app.request(`/trips/${trip}/expenses?category=transport`)
    ).json()) as { items: unknown[] };
    expect(res.items.length).toBe(1);
  });

  it("GET 목록: member 필터(참여자) end-to-end", async () => {
    const { u, trip, memberId } = await setup();
    const app = appFor(u);
    const u2 = await mkUser(ctx.sql);
    const m2 = await mkMember(ctx.sql, trip, { userId: u2, role: "member", status: "joined" });
    await app.request(`/trips/${trip}/expenses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body(memberId, { spent_at: "2026-08-02T12:01:00.000Z" })),
    }); // 참여 [m1]
    await app.request(`/trips/${trip}/expenses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        body(memberId, {
          spent_at: "2026-08-02T12:02:00.000Z",
          participant_member_ids: [memberId, m2],
        }),
      ),
    }); // 참여 [m1, m2]
    const res = (await (await app.request(`/trips/${trip}/expenses?member=${m2}`)).json()) as {
      items: unknown[];
    };
    expect(res.items.length).toBe(1); // m2가 참여한 지출만
  });

  it("GET 목록: 잘못된 필터 enum → 422", async () => {
    const { u, trip } = await setup();
    const res = await appFor(u).request(`/trips/${trip}/expenses?category=bogus`);
    expect(res.status).toBe(422);
  });

  it("멱등 마커: 같은 Idempotency-Key 두 번 POST → 같은 지출(미들웨어 off에서도 DB dedup)", async () => {
    const { u, trip, memberId } = await setup();
    const app = appFor(u); // idempotencyStore: null → 미들웨어 비활성, in-tx 마커만 작동
    const payload = JSON.stringify(body(memberId));
    const headers = { "content-type": "application/json", "idempotency-key": "dup-key-1" };
    const r1 = await app.request(`/trips/${trip}/expenses`, {
      method: "POST",
      headers,
      body: payload,
    });
    const r2 = await app.request(`/trips/${trip}/expenses`, {
      method: "POST",
      headers,
      body: payload,
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const id1 = ((await r1.json()) as { id: string }).id;
    const id2 = ((await r2.json()) as { id: string }).id;
    expect(id2).toBe(id1); // 중복 생성 안 됨 — 기존 지출 replay
    const list = (await (await app.request(`/trips/${trip}/expenses`)).json()) as {
      items: unknown[];
    };
    expect(list.items.length).toBe(1);
  });

  // ── 소유권 인가 positive(경계 보존): 과잉차단 방지 + 인가 통과 후 잠금/버전은 그대로 409 ──
  describe("소유권 인가(경계)", () => {
    const idOf = async (r: Response) => ((await r.json()) as { id: string }).id;
    const patch = (app: ReturnType<typeof appFor>, trip: string, id: string, version: number) =>
      app.request(`/trips/${trip}/expenses/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version, title: "수정" }),
      });
    const del = (app: ReturnType<typeof appFor>, trip: string, id: string, version: number) =>
      app.request(`/trips/${trip}/expenses/${id}?version=${version}`, { method: "DELETE" });

    // 작성자=결제자=admin(owner): PATCH·DELETE 200 (명시)
    it("작성자 PATCH → 200", async () => {
      const { u, trip, memberId } = await setup();
      const app = appFor(u);
      const id = await idOf(await postExp(app, trip, memberId));
      expect((await patch(app, trip, id, 0)).status).toBe(200);
    });
    it("작성자 DELETE → 200", async () => {
      const { u, trip, memberId } = await setup();
      const app = appFor(u);
      const id = await idOf(await postExp(app, trip, memberId));
      expect((await del(app, trip, id, 0)).status).toBe(200);
    });

    // created_by 단독 인가: m2(member, non-admin)가 paid_by=owner로 생성 → m2는 작성자일 뿐(결제자·admin 아님).
    // created_by 절만이 허용 근거 → authz에서 created_by 절 제거 시 이 케이스가 깨진다(변이 내성).
    it("작성자(비결제자·비admin) PATCH → 200 (created_by 단독 인가)", async () => {
      const { trip, memberId } = await setup(); // memberId = owner(admin) member
      const u2 = await mkUser(ctx.sql);
      await mkMember(ctx.sql, trip, { userId: u2, role: "member", status: "joined" });
      const id = await idOf(await postExp(appFor(u2), trip, memberId)); // created_by=m2, paid_by=owner
      expect((await patch(appFor(u2), trip, id, 0)).status).toBe(200);
    });
    it("작성자(비결제자·비admin) DELETE → 200 (created_by 단독 인가)", async () => {
      const { trip, memberId } = await setup();
      const u2 = await mkUser(ctx.sql);
      await mkMember(ctx.sql, trip, { userId: u2, role: "member", status: "joined" });
      const id = await idOf(await postExp(appFor(u2), trip, memberId)); // created_by=m2, paid_by=owner
      expect((await del(appFor(u2), trip, id, 0)).status).toBe(200);
    });

    // 결제자(비작성자): owner가 paid_by=m2로 생성(created_by=owner) → m2가 PATCH·DELETE 200
    it("결제자(비작성자) PATCH → 200", async () => {
      const { u, trip } = await setup();
      const u2 = await mkUser(ctx.sql);
      const m2 = await mkMember(ctx.sql, trip, { userId: u2, role: "member", status: "joined" });
      const id = await idOf(await postExp(appFor(u), trip, m2)); // created_by=owner, paid_by=m2
      expect((await patch(appFor(u2), trip, id, 0)).status).toBe(200);
    });
    it("결제자(비작성자) DELETE → 200", async () => {
      const { u, trip } = await setup();
      const u2 = await mkUser(ctx.sql);
      const m2 = await mkMember(ctx.sql, trip, { userId: u2, role: "member", status: "joined" });
      const id = await idOf(await postExp(appFor(u), trip, m2));
      expect((await del(appFor(u2), trip, id, 0)).status).toBe(200);
    });

    // admin(작성자·결제자 모두 아님): 일반멤버 m2가 생성(created_by=paid_by=m2) → admin owner가 PATCH·DELETE 200
    it("admin(비작성자·비결제자) PATCH → 200", async () => {
      const { u, trip } = await setup(); // u=admin creator
      const u2 = await mkUser(ctx.sql);
      const m2 = await mkMember(ctx.sql, trip, { userId: u2, role: "member", status: "joined" });
      const id = await idOf(await postExp(appFor(u2), trip, m2)); // created_by=paid_by=m2
      expect((await patch(appFor(u), trip, id, 0)).status).toBe(200); // admin이지만 작성자·결제자 아님
    });
    it("admin(비작성자·비결제자) DELETE → 200", async () => {
      const { u, trip } = await setup();
      const u2 = await mkUser(ctx.sql);
      const m2 = await mkMember(ctx.sql, trip, { userId: u2, role: "member", status: "joined" });
      const id = await idOf(await postExp(appFor(u2), trip, m2));
      expect((await del(appFor(u), trip, id, 0)).status).toBe(200);
    });

    // 인가 통과 후에도 잠금/버전은 그대로 409 (authz는 그 앞 단계지 대체가 아님)
    it("인가 actor + finalized trip PATCH → 409(잠금 유지)", async () => {
      const { u, trip, memberId } = await setup();
      const app = appFor(u);
      const id = await idOf(await postExp(app, trip, memberId));
      await ctx.sql`update trips set settlement_status='finalized' where id=${trip}`;
      expect((await patch(app, trip, id, 0)).status).toBe(409);
    });
    it("인가 actor + finalized trip DELETE → 409(잠금 유지)", async () => {
      const { u, trip, memberId } = await setup();
      const app = appFor(u);
      const id = await idOf(await postExp(app, trip, memberId));
      await ctx.sql`update trips set settlement_status='finalized' where id=${trip}`;
      expect((await del(app, trip, id, 0)).status).toBe(409);
    });
    it("인가 actor + stale version PATCH → 409(버전충돌 유지)", async () => {
      const { u, trip, memberId } = await setup();
      const app = appFor(u);
      const id = await idOf(await postExp(app, trip, memberId));
      expect((await patch(app, trip, id, 99)).status).toBe(409);
    });
    it("인가 actor + stale version DELETE → 409(버전충돌 유지)", async () => {
      const { u, trip, memberId } = await setup();
      const app = appFor(u);
      const id = await idOf(await postExp(app, trip, memberId));
      expect((await del(app, trip, id, 99)).status).toBe(409);
    });
  });
});
