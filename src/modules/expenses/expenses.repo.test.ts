import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, mkTrip, mkMember, type Ctx } from "../../../tests/db/helpers.ts";
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
  it("멱등 마커: 같은 (trip, idempotency_key) 재생성 → replay·중복 차단", async () => {
    const { trip, memberId } = await setup();
    const repo = new DrizzleExpenseRepo(ctx.db);
    const a = await repo.create(mk(trip, memberId, { idempotency_key: "idem-1" }));
    const b = await repo.create(mk(trip, memberId, { idempotency_key: "idem-1" }));
    expect(b.id).toBe(a.id); // 같은 지출 replay
    const cnt = await ctx.sql<
      { n: number }[]
    >`select count(*)::int as n from expenses where trip_id=${trip}`;
    expect(cnt[0]!.n).toBe(1); // 새 insert 없음
  });
  it("멱등 마커: 다른 키 → 별개 지출", async () => {
    const { trip, memberId } = await setup();
    const repo = new DrizzleExpenseRepo(ctx.db);
    const a = await repo.create(mk(trip, memberId, { idempotency_key: "k-a" }));
    const b = await repo.create(mk(trip, memberId, { idempotency_key: "k-b" }));
    expect(b.id).not.toBe(a.id);
  });
  it("멱등 마커 없음(null) → 매번 신규(partial unique 제외)", async () => {
    const { trip, memberId } = await setup();
    const repo = new DrizzleExpenseRepo(ctx.db);
    const a = await repo.create(mk(trip, memberId));
    const b = await repo.create(mk(trip, memberId));
    expect(b.id).not.toBe(a.id);
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

describe("DrizzleExpenseRepo 목록(keyset·필터)", () => {
  const atIso = (min: number) => `2026-08-02T12:${String(min).padStart(2, "0")}:00.000Z`;

  it("정렬 (spent_at desc, id desc) + limit+1로 hasMore 판정", async () => {
    const { trip, memberId } = await setup();
    const repo = new DrizzleExpenseRepo(ctx.db);
    const e1 = await repo.create(mk(trip, memberId, { spent_at: new Date(atIso(1)) }));
    const e2 = await repo.create(mk(trip, memberId, { spent_at: new Date(atIso(2)) }));
    const e3 = await repo.create(mk(trip, memberId, { spent_at: new Date(atIso(3)) }));
    const page = await repo.listForTrip(trip, { limit: 2 });
    expect(page.rows.map((r) => r.id)).toEqual([e3.id, e2.id]); // 최신 우선
    expect(page.hasMore).toBe(true);
    const full = await repo.listForTrip(trip, { limit: 3 });
    expect(full.hasMore).toBe(false);
    expect(full.rows.map((r) => r.id)).toEqual([e3.id, e2.id, e1.id]);
  });

  it("keyset 커서 페이징: 경계 무중복·무누락 + 마지막 hasMore=false", async () => {
    const { trip, memberId } = await setup();
    const repo = new DrizzleExpenseRepo(ctx.db);
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++)
      ids.push((await repo.create(mk(trip, memberId, { spent_at: new Date(atIso(i)) }))).id);
    const seen: string[] = [];
    let cursor: { spentAt: Date; id: string } | undefined;
    let lastHasMore = true;
    for (let p = 0; p < 5; p++) {
      const res = await repo.listForTrip(trip, { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...res.rows.map((r) => r.id));
      const last = res.rows.at(-1);
      cursor = last ? { spentAt: last.spent_at, id: last.id } : undefined;
      lastHasMore = res.hasMore;
      if (!res.hasMore) break;
    }
    expect(lastHasMore).toBe(false);
    expect(new Set(seen).size).toBe(5); // 무중복
    expect([...seen].sort()).toEqual([...ids].sort()); // 무누락
  });

  it("동일 spent_at: id desc 타이브레이커로 정합 분할", async () => {
    const { trip, memberId } = await setup();
    const repo = new DrizzleExpenseRepo(ctx.db);
    const same = new Date(atIso(7));
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
      ids.push((await repo.create(mk(trip, memberId, { spent_at: same }))).id);
    const seen: string[] = [];
    let cursor: { spentAt: Date; id: string } | undefined;
    for (let p = 0; p < 3; p++) {
      const res = await repo.listForTrip(trip, { limit: 1, ...(cursor ? { cursor } : {}) });
      seen.push(...res.rows.map((r) => r.id));
      const last = res.rows.at(-1);
      cursor = last ? { spentAt: last.spent_at, id: last.id } : undefined;
      if (!res.hasMore) break;
    }
    expect(new Set(seen).size).toBe(3);
    expect(seen).toEqual([...ids].sort().reverse()); // 전역 id desc 정렬과 일치
  });

  it("필터: category·payment_method·local currency·state 각각·결합(AND)", async () => {
    const { trip, memberId } = await setup();
    const repo = new DrizzleExpenseRepo(ctx.db);
    await repo.create(
      mk(trip, memberId, {
        spent_at: new Date(atIso(1)),
        category: "food",
        payment_method: "cash",
        local_currency: "JPY",
        expense_settlement_state: "included",
      }),
    );
    await repo.create(
      mk(trip, memberId, {
        spent_at: new Date(atIso(2)),
        category: "transport",
        payment_method: "card",
        local_currency: "USD",
        expense_settlement_state: "personal",
      }),
    );
    const n = async (filters: Record<string, string>) =>
      (await repo.listForTrip(trip, { limit: 50, filters })).rows.length;
    expect(await n({ category: "transport" })).toBe(1);
    expect(await n({ payment_method: "cash" })).toBe(1);
    expect(await n({ currency: "USD" })).toBe(1);
    expect(await n({ state: "personal" })).toBe(1);
    expect(await n({ category: "food", currency: "USD" })).toBe(0); // 결합 AND
  });

  it("필터 member: 결제자 OR 참여자 합집합(타 멤버 지출 제외)", async () => {
    const { trip, memberId: m1 } = await setup();
    const m2 = await mkMember(ctx.sql, trip, { email: "m2@e.com" });
    const repo = new DrizzleExpenseRepo(ctx.db);
    const onlyM1 = await repo.create(mk(trip, m1, { spent_at: new Date(atIso(1)) }));
    const payM2 = await repo.create(mk(trip, m2, { spent_at: new Date(atIso(2)) }));
    const partM2 = await repo.create({
      ...mk(trip, m1, { spent_at: new Date(atIso(3)) }),
      participant_member_ids: [m1, m2],
    });
    const res = await repo.listForTrip(trip, { limit: 50, filters: { member: m2 } });
    const got = new Set(res.rows.map((r) => r.id));
    expect(got.has(payM2.id)).toBe(true); // 결제자
    expect(got.has(partM2.id)).toBe(true); // 참여자
    expect(got.has(onlyM1.id)).toBe(false);
    expect(res.rows.length).toBe(2);
  });

  it("deleted_at 제외 + trip 스코프", async () => {
    const { trip, memberId } = await setup();
    const repo = new DrizzleExpenseRepo(ctx.db);
    const keep = await repo.create(mk(trip, memberId, { spent_at: new Date(atIso(1)) }));
    const del = await repo.create(mk(trip, memberId, { spent_at: new Date(atIso(2)) }));
    await repo.softDelete(trip, del.id, 0, memberId);
    const u2 = await mkUser(ctx.sql);
    const trip2 = await mkTrip(ctx.sql, u2);
    const m2 = await new DrizzleMemberRepo(ctx.db).ensureCreatorMembership({
      tripId: trip2,
      userId: u2,
      displayName: "B",
      email: "b@example.com",
    });
    await repo.create(mk(trip2, m2.id, { spent_at: new Date(atIso(3)) }));
    const res = await repo.listForTrip(trip, { limit: 50 });
    expect(res.rows.map((r) => r.id)).toEqual([keep.id]); // 삭제·타trip 제외
  });

  it("필터+커서 동시: 페이지 경계에서도 필터 유지(무누락·무혼입)", async () => {
    const { trip, memberId } = await setup();
    const repo = new DrizzleExpenseRepo(ctx.db);
    const food: string[] = [];
    food.push(
      (await repo.create(mk(trip, memberId, { spent_at: new Date(atIso(1)), category: "food" })))
        .id,
    );
    await repo.create(mk(trip, memberId, { spent_at: new Date(atIso(2)), category: "transport" }));
    food.push(
      (await repo.create(mk(trip, memberId, { spent_at: new Date(atIso(3)), category: "food" })))
        .id,
    );
    await repo.create(mk(trip, memberId, { spent_at: new Date(atIso(4)), category: "transport" }));
    const seen: string[] = [];
    let cursor: { spentAt: Date; id: string } | undefined;
    for (let p = 0; p < 3; p++) {
      const res = await repo.listForTrip(trip, {
        limit: 1,
        filters: { category: "food" },
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...res.rows.map((r) => r.id));
      const last = res.rows.at(-1);
      cursor = last ? { spentAt: last.spent_at, id: last.id } : undefined;
      if (!res.hasMore) break;
    }
    expect(seen.length).toBe(2); // transport 혼입 없음
    expect([...seen].sort()).toEqual([...food].sort()); // food만, 무누락
  });
});
