import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { startDb, mkUser, mkTrip, mkMember, mkExpense, mkSettlement, type Ctx } from "./helpers.ts";
import { DrizzleTripRepo } from "../../src/modules/trips/trips.repo.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

// trip_id 컬럼을 가진 모든 자식 테이블(복합 FK 포함) — 삭제 후 잔존 0 확인.
// (F3) settlement_currency_totals는 trip_id가 없어(settlement_id 경유 cascade) 아래에서 settlement_id로 별도 검증.
const CHILD_TABLES = [
  "trip_members",
  "expenses",
  "expense_participants",
  "expense_audit_logs",
  "settlements",
  "settlement_transfers",
  "settlement_transfer_events",
  "settlement_member_summaries",
  "trip_fx_defaults",
];

describe("trip 삭제 cascade 다이아몬드(복합 FK NO ACTION 무위반)", () => {
  it("가득 찬 trip 삭제 → 모든 자식 정리, FK 위반 없음", async () => {
    const u = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const m1 = await mkMember(ctx.sql, trip, { userId: u, role: "admin", status: "joined" });
    const m2 = await mkMember(ctx.sql, trip, { email: "m2@e.com" });
    // expense: (trip_id,paid_by)·(trip_id,created_by)→trip_members, (trip_id,settlement_currency)→trips 복합 FK(NO ACTION)
    const exp = await mkExpense(ctx.sql, trip, m1);
    await ctx.sql`insert into expense_participants (trip_id, expense_id, member_id) values (${trip}, ${exp}, ${m1})`;
    await ctx.sql`insert into expense_participants (trip_id, expense_id, member_id) values (${trip}, ${exp}, ${m2})`;
    await ctx.sql`insert into expense_audit_logs (trip_id, expense_id, changed_by_member_id, change_type) values (${trip}, ${exp}, ${m1}, 'create')`;
    const settlement = await mkSettlement(ctx.sql, trip, m1);
    const tid = randomUUID();
    await ctx.sql`insert into settlement_transfers (id, settlement_id, trip_id, basis, currency, from_member_id, to_member_id, amount)
      values (${tid}, ${settlement}, ${trip}, 'settlement', 'KRW', ${m2}, ${m1}, 100)`;
    // events: (trip_id,settlement_id,transfer_id)→settlement_transfers cascade, (trip_id,actor)→trip_members NO ACTION
    await ctx.sql`insert into settlement_transfer_events (transfer_id, trip_id, settlement_id, event_type, actor_member_id)
      values (${tid}, ${trip}, ${settlement}, 'paid', ${m1})`;
    await ctx.sql`insert into trip_fx_defaults (trip_id, base_currency, settlement_currency, rate) values (${trip}, 'THB', 'KRW', '37.9')`;
    // (F3) 정산 스냅샷 자식: currency_totals(settlement_id 경유, trip_id 없음)·member_summaries(trip_id 복합 FK cascade)
    await ctx.sql`insert into settlement_currency_totals (settlement_id, currency, total_amount) values (${settlement}, 'KRW', 9320)`;
    await ctx.sql`insert into settlement_member_summaries (settlement_id, trip_id, member_id, basis, currency, total_paid, total_share, net_amount)
      values (${settlement}, ${trip}, ${m1}, 'settlement', 'KRW', 9320, 4660, 4660)`;

    // 실제 삭제 경로(repo.delete, 신 시그니처 (tripId, callerMembershipId)) — 23503이 나면 여기서 throw → red.
    // m1 = 위에서 만든 admin 멤버십 → 재검증 통과. repo가 내부 tx로 원자 실행(F7·F8).
    const repo = new DrizzleTripRepo(ctx.db);
    expect(await repo.delete(trip, m1)).toBe("deleted");

    const count = async (t: string): Promise<number> =>
      (
        (await ctx.sql.unsafe(`select count(*)::int as n from ${t} where trip_id = $1`, [
          trip,
        ])) as {
          n: number;
        }[]
      )[0]!.n;
    for (const t of CHILD_TABLES) expect(await count(t), t).toBe(0);
    // (F3) settlement_currency_totals는 trip_id가 없어 캡처한 settlement_id로 검증
    const cur = await ctx.sql<
      { n: number }[]
    >`select count(*)::int as n from settlement_currency_totals where settlement_id=${settlement}`;
    expect(cur[0]!.n, "settlement_currency_totals").toBe(0);
    const trow = await ctx.sql<
      { n: number }[]
    >`select count(*)::int as n from trips where id=${trip}`;
    expect(trow[0]!.n).toBe(0);
  });

  // (F12 가드) DrizzleTripRepo.delete는 trips 삭제 전에 expenses·settlements를 선삭제해,
  // trip_members/trips를 NO ACTION 복합 FK로 참조하는 자식들을 폐포에서 먼저 비운다(다이아몬드 cascade 순서 위험 회피).
  // 이 가드는 그 NO ACTION 참조자 집합을 스키마 카탈로그에서 introspection해 "선삭제로 커버되는 폐포"에 고정한다.
  // 새 trip-scoped 자식이 trip_members/trips를 NO ACTION으로 참조하면서 이 폐포 밖(expenses/settlements 서브트리 밖)에
  // 추가되면 이 테스트가 red → repo.delete의 선삭제 커버리지를 갱신하고 아래 COVERED를 의식적으로 갱신하도록 강제한다.
  it("[F12 가드] trip_members/trips NO ACTION 참조 자식은 모두 repo.delete 선삭제 폐포(expenses·settlements 서브트리)에 포함", async () => {
    const rows = await ctx.sql<{ t: string }[]>`
      SELECT DISTINCT con.conrelid::regclass::text AS t
      FROM pg_constraint con
      JOIN pg_class ref ON ref.oid = con.confrelid
      WHERE con.contype = 'f'
        AND con.confdeltype = 'a'  -- ON DELETE NO ACTION
        AND ref.relname IN ('trip_members', 'trips')`;
    const actual = rows.map((r) => r.t.replace(/^public\./, "")).sort();
    // repo.delete가 `DELETE expenses`·`DELETE settlements`(하위 cascade 포함)로 최종 `DELETE trips` 이전에 비우는 테이블들.
    // 새 NO ACTION 참조자가 이 목록 밖에서 나타나면(=폐포 밖) F12 재발 위험 → 아래를 갱신하기 전 red.
    const COVERED = [
      "expense_audit_logs",
      "expense_participants",
      "expenses",
      "settlement_member_summaries",
      "settlement_transfers",
      "settlement_transfer_events",
      "settlements",
    ].sort();
    expect(actual).toEqual(COVERED);
  });
});
