# Settlement 슬라이스 구현 계획 (정산 계산·finalize·transfers)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 기존 `compute.ts` netting 코어와 settlements DB 스키마 위에 글루(schema/repo/service/controller)를 얹어 정산 API(GET·precheck·finalize·unlock·mark-paid)를 완성한다.

**Architecture:** functional core(`compute.ts`, 불변) / imperative shell(service+repo). finalize는 trips FOR UPDATE로 expense mutation과 상호 직렬화 + seen_expense_versions drift→409. 이중축(settlement/local) 스냅샷 영속화. api-routes의 buildV1App·guards·money·zod-openapi 패턴 재사용. **새 마이그레이션 불요.**

**Tech Stack:** Bun · Hono + @hono/zod-openapi(1.4, Zod v4) · Drizzle ORM · decimal.js · vitest + testcontainers(PG16)

**설계 근거:** `docs/plans/2026-06-30-settlement-design.md`

**전제 사실(검증됨):**
- `computeSettlement(input: { expenses: ExpenseInput[]; members: MemberId[] }): SettlementResult` — `compute.ts:217`.
- `ExpenseInput { id: ExpenseId; paid_by: MemberId; participants: MemberId[]; local: Money; settlement: Money; refund_of?: ExpenseId }` — `compute.ts:66`.
- `SettlementResult { settlement: AxisResult; local: Record<string, AxisResult> }`. `AxisResult { transfers: Transfer[]; summaries: Summary[]; total: Minor }`. `Transfer { from: MemberId; to: MemberId; amount: Minor; currency: CurrencyCode }`. `Summary { member: MemberId; total_paid: Minor; total_share: Minor; net: Minor }` — `compute.ts:33,74,80,85`.
- Σnet≠0·통화혼재 시 `SettlementInvariantError`(422) throw. 환불·이중축 내부 처리.
- `money.ts`: `Money{amount:Minor(bigint), currency:CurrencyCode}`, `minor(n)`, `money(amount,currency)`. 브랜드 타입(`as MemberId`/`as ExpenseId`/`as CurrencyCode` 캐스트 필요).
- enums: `settlement_status`(open|finalized, trips), `snapshot_status`(active|superseded, settlements), `payment_status`(pending|paid), `basis`(settlement|local).
- settlements: `version`·`status`(active/superseded)·`finalized_by_member_id`·`finalized_at`·`total_settlement_amount`(bigint). `uq_settlement_active`(부분 unique WHERE status='active')·`uq_settlement_version`(trip_id,version). settlement_transfers: `basis`·`currency`·`from_member_id`·`to_member_id`·`amount`·`payment_status`·`paid_at`·`marked_by_member_id`. settlement_member_summaries·settlement_currency_totals(스냅샷 자식). **정확 컬럼명은 `src/db/schema/settlements.ts`로 확인.**
- expenses: `expense_settlement_state`(included|personal|record_only)·`deleted_at`·`version`·`refund_of_expense_id`·`participant_member_ids`. `ix_exp_settle` 부분인덱스(included AND not deleted).
- trips: `settlement_status`(open/finalized)·`finalized_at`. expenses.repo가 모든 write에서 trips FOR UPDATE+open 확인(상호 직렬화 지점).
- guards: `requireTripMember(lookup, "admin")`, `c.get("membership").id`(member_id)·`.role`. money string DTO·`toResponse`(bigint→string)·제네릭 `jsonBody`/`ok` 헬퍼는 expenses.controller 패턴.

**strict-TS:** [[trip-mate-api-strict-ts-gotchas]]·[[trip-mate-api-zod-openapi-gotchas]](valid 제네릭 헬퍼·응답 enum 유니온·`.for("update")`·DrizzleQueryError.cause.code·`rows[0]!`).

> **공통 커밋:** 새 .ts 후 `bun run fmt && bun run check`(`&&` 체인). 한국어·AI마커 금지·`<type>(<scope>): 설명`.

---

## Task 0: settlements DTO 스키마

**Files:** Create `src/modules/settlements/settlements.schema.ts` · Create `src/modules/settlements/settlements.schema.test.ts`

**Step 1: 실패 테스트**

```ts
import { describe, it, expect } from "vitest";
import { settlementResponseSchema, finalizeRequestSchema } from "./settlements.schema.ts";

describe("settlements DTO", () => {
  it("응답: 돈 string·version nullable·seen_versions·transfers", () => {
    const ok = settlementResponseSchema.safeParse({
      trip_id: "11111111-1111-4111-8111-111111111111",
      settlement_status: "open",
      version: null,
      settlement_total: "0",
      seen_versions: [{ expense_id: "11111111-1111-4111-8111-111111111111", version: 0 }],
      transfers: [],
      summaries: [],
      currency_totals: [],
    });
    expect(ok.success).toBe(true);
  });
  it("finalize 요청: seen_expense_versions 필수", () => {
    expect(finalizeRequestSchema.safeParse({ seen_expense_versions: [{ expense_id: "11111111-1111-4111-8111-111111111111", version: 1 }] }).success).toBe(true);
    expect(finalizeRequestSchema.safeParse({}).success).toBe(false);
  });
});
```

**Step 2: 실패 확인** → FAIL.

**Step 3: 구현**

```ts
import { z } from "@hono/zod-openapi";

const minorSigned = z.string().regex(/^-?\d+$/); // net은 음수 가능

export const transferResponseSchema = z
  .object({
    id: z.string().uuid(),
    basis: z.enum(["settlement", "local"]),
    currency: z.string(),
    from_member_id: z.string().uuid(),
    to_member_id: z.string().uuid(),
    amount: z.string().regex(/^\d+$/),
    payment_status: z.enum(["pending", "paid"]),
    paid_at: z.string().nullable(),
  })
  .openapi("SettlementTransfer");

export const summaryResponseSchema = z
  .object({
    member_id: z.string().uuid(),
    basis: z.enum(["settlement", "local"]),
    currency: z.string(),
    total_paid: minorSigned,
    total_share: minorSigned,
    net_amount: minorSigned,
  })
  .openapi("SettlementSummary");

const seenVersionSchema = z.object({ expense_id: z.string().uuid(), version: z.number().int() });

export const settlementResponseSchema = z
  .object({
    trip_id: z.string().uuid(),
    settlement_status: z.enum(["open", "finalized"]),
    version: z.number().int().nullable(), // active 스냅샷 version(없으면 null)
    settlement_total: z.string().regex(/^\d+$/),
    seen_versions: z.array(seenVersionSchema),
    transfers: z.array(transferResponseSchema),
    summaries: z.array(summaryResponseSchema),
    currency_totals: z.array(z.object({ currency: z.string(), total_amount: z.string().regex(/^\d+$/) })),
  })
  .openapi("Settlement");

export const precheckResponseSchema = z
  .object({
    finalizable: z.boolean(),
    reasons: z.array(z.string()),
    settlement_total: z.string().regex(/^\d+$/),
    seen_versions: z.array(seenVersionSchema),
  })
  .openapi("SettlementPrecheck");

export const finalizeRequestSchema = z
  .object({ seen_expense_versions: z.array(seenVersionSchema).min(0) })
  .openapi("FinalizeSettlement");

export type SettlementResponse = z.infer<typeof settlementResponseSchema>;
export type FinalizeRequest = z.infer<typeof finalizeRequestSchema>;
```

**Step 4: green** → PASS.

**Step 5: Commit**
```bash
bun run fmt && bun run check
git add src/modules/settlements/settlements.schema.ts src/modules/settlements/settlements.schema.test.ts
git commit -m "feat(settlements): 정산 DTO 스키마(이중축 transfers/summaries·seen_versions·finalize 요청)"
```

---

## Task 1: settlements repo (포함지출·saveSnapshot·mark-paid)

**Files:** Create `src/modules/settlements/settlements.repo.ts` · Create `src/modules/settlements/settlements.repo.test.ts`

**핵심:** `listIncludedExpenses`는 GET(db)·finalize(tx) 양쪽. `saveSnapshot`은 supersede + 자식 일괄(이중축). `markTransferPaid`는 조건부 CAS.

**Step 1: 실패 테스트** (PG; expenses는 helpers의 mkExpense·mkMember 활용)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, mkTrip, mkMember, mkExpense, type Ctx } from "../../../tests/db/helpers.ts";
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
  const trip = await mkTrip(ctx.sql, u); // KRW·Asia/Seoul·status open
  const admin = await mkMember(ctx.sql, trip, { userId: u, role: "admin", status: "joined" });
  const u2 = await mkUser(ctx.sql);
  const m2 = await mkMember(ctx.sql, trip, { userId: u2, role: "member", status: "joined" });
  return { trip, admin, m2 };
}

describe("DrizzleSettlementRepo", () => {
  it("listIncludedExpenses: included만·deleted 제외·participants 포함", async () => {
    const { trip, admin } = await setup();
    await mkExpense(ctx.sql, trip, admin); // included
    const repo = new DrizzleSettlementRepo(ctx.db);
    const rows = await repo.listIncludedExpenses(ctx.db, trip);
    expect(rows.length).toBe(1);
    expect(rows[0]!.paid_by_member_id).toBe(admin);
  });
  it("saveSnapshot: active 스냅샷+transfers·이전 active supersede", async () => {
    const { trip, admin, m2 } = await setup();
    const eid = await mkExpense(ctx.sql, trip, admin); // 1000 JPY/9320 KRW, paid_by admin
    await ctx.sql`insert into expense_participants (trip_id, expense_id, member_id) values (${trip}, ${eid}, ${admin}), (${trip}, ${eid}, ${m2})`;
    const repo = new DrizzleSettlementRepo(ctx.db);
    const rows = await repo.listIncludedExpenses(ctx.db, trip);
    const result = computeSettlement({
      expenses: rows.map((r) => ({ id: r.id as never, paid_by: r.paid_by_member_id as never, participants: r.participant_member_ids as never[], local: money(r.local_amount, r.local_currency), settlement: money(r.settlement_amount, r.settlement_currency), ...(r.refund_of_expense_id ? { refund_of: r.refund_of_expense_id as never } : {}) })),
      members: [admin, m2] as never[],
    });
    const v1 = await ctx.db.transaction(async (tx) => repo.saveSnapshot(tx, { tripId: trip, finalizedByMemberId: admin, result, settlementCurrency: "KRW" }));
    expect(v1).toBe(1);
    const v2 = await ctx.db.transaction(async (tx) => repo.saveSnapshot(tx, { tripId: trip, finalizedByMemberId: admin, result, settlementCurrency: "KRW" }));
    expect(v2).toBe(2);
    const active = await ctx.sql`select version from settlements where trip_id=${trip} and status='active'`;
    expect(active.length).toBe(1); // 하나만 active(uq_settlement_active)
    expect(active[0]!.version).toBe(2);
  });
  it("mark-paid 스코프: finalized·active·settlement-basis만, open이면 null (finding #1 pass1)", async () => {
    const { trip, admin, m2 } = await setup();
    const eid = await mkExpense(ctx.sql, trip, admin);
    await ctx.sql`insert into expense_participants (trip_id, expense_id, member_id) values (${trip}, ${eid}, ${admin}), (${trip}, ${eid}, ${m2})`;
    const repo = new DrizzleSettlementRepo(ctx.db);
    const rows = await repo.listIncludedExpenses(ctx.db, trip);
    const result = computeSettlement({ expenses: rows.map((r) => ({ id: r.id as never, paid_by: r.paid_by_member_id as never, participants: r.participant_member_ids as never[], local: money(r.local_amount, r.local_currency), settlement: money(r.settlement_amount, r.settlement_currency) })), members: [admin, m2] as never[] });
    await ctx.db.transaction(async (tx) => repo.saveSnapshot(tx, { tripId: trip, finalizedByMemberId: admin, result, settlementCurrency: "KRW" }));
    const t = await ctx.sql`select id from settlement_transfers where trip_id=${trip} and basis='settlement' limit 1`;
    const tid = t[0]!.id as string;
    // open 상태(아직 trips.settlement_status='open') → 스코프 밖 null
    expect(await repo.getActiveSettlementTransfer(ctx.db, trip, tid)).toBeNull();
    await ctx.sql`update trips set settlement_status='finalized' where id=${trip}`; // finalize 상태로
    expect(await repo.getActiveSettlementTransfer(ctx.db, trip, tid)).not.toBeNull();
    await repo.setTransferPaid(ctx.db, trip, tid, admin);
    expect((await ctx.sql`select payment_status from settlement_transfers where id=${tid}`)[0]!.payment_status).toBe("paid");
    await repo.setTransferPaid(ctx.db, trip, tid, admin); // 멱등(0행)
  });
});
```
> ⚠️ mkExpense는 1000 JPY/9320 KRW·paid_by=memberId. participants는 테스트에서 직접 insert. compute 결과 transfer가 ≥1건 되려면 paid_by와 다른 participant 필요(admin 결제·m2 참여 → m2가 admin에게 송금).

**Step 2: 실패 확인** → FAIL.

**Step 3: 구현**

```ts
import { and, eq, inArray, isNull, sql, desc } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { expenses, expenseParticipants } from "../../db/schema/expenses.ts";
import { settlements, settlementTransfers, settlementMemberSummaries, settlementCurrencyTotals } from "../../db/schema/settlements.ts";
import { trips } from "../../db/schema/trips.ts";
import type { SettlementResult } from "./domain/compute.ts";

export interface IncludedExpenseRow {
  id: string;
  paid_by_member_id: string;
  local_amount: bigint;
  local_currency: string;
  settlement_amount: bigint;
  settlement_currency: string;
  version: number;
  refund_of_expense_id: string | null;
  participant_member_ids: string[];
}

const INC_COLS = {
  id: expenses.id,
  paid_by_member_id: expenses.paid_by_member_id,
  local_amount: expenses.local_amount,
  local_currency: expenses.local_currency,
  settlement_amount: expenses.settlement_amount,
  settlement_currency: expenses.settlement_currency,
  version: expenses.version,
  refund_of_expense_id: expenses.refund_of_expense_id,
};

// db 또는 tx 공용(select+update). finalize/mark-paid는 tx(직렬화·원자), GET은 db.
type Exec = Pick<PostgresJsDatabase<Record<string, unknown>>, "select" | "update">;

export class DrizzleSettlementRepo<T extends Record<string, unknown>> {
  constructor(private readonly db: PostgresJsDatabase<T>) {}

  /** 포함 지출(included·미삭제) + 참여자. exec=tx면 finalize 직렬화 컨텍스트. */
  async listIncludedExpenses(exec: Exec, tripId: string): Promise<IncludedExpenseRow[]> {
    const rows = await exec
      .select(INC_COLS)
      .from(expenses)
      .where(and(eq(expenses.trip_id, tripId), eq(expenses.expense_settlement_state, "included"), isNull(expenses.deleted_at)));
    if (rows.length === 0) return [];
    const parts = await exec
      .select({ expense_id: expenseParticipants.expense_id, member_id: expenseParticipants.member_id })
      .from(expenseParticipants)
      .where(inArray(expenseParticipants.expense_id, rows.map((r) => r.id)));
    const byExp = new Map<string, string[]>();
    for (const p of parts) byExp.set(p.expense_id, [...(byExp.get(p.expense_id) ?? []), p.member_id]);
    return rows.map((r) => ({ ...r, participant_member_ids: byExp.get(r.id) ?? [] })) as IncludedExpenseRow[];
  }

  async lockTrip(tx: Exec, tripId: string): Promise<{ status: string } | null> {
    const rows = await tx.select({ status: trips.settlement_status }).from(trips).where(eq(trips.id, tripId)).for("update");
    return rows[0] ?? null;
  }
  async setTripStatus(tx: PostgresJsDatabase<T>, tripId: string, status: "open" | "finalized"): Promise<void> {
    await tx.update(trips).set(status === "finalized" ? { settlement_status: status, finalized_at: sql`now()` } : { settlement_status: status }).where(eq(trips.id, tripId));
  }
  async getActiveVersion(tripId: string): Promise<number | null> {
    const rows = await this.db.select({ version: settlements.version }).from(settlements).where(and(eq(settlements.trip_id, tripId), eq(settlements.status, "active")));
    return rows[0]?.version ?? null;
  }

  /** 이전 active supersede + 새 스냅샷·이중축 transfers/summaries/currency_totals 일괄. 새 version 반환. */
  async saveSnapshot(tx: PostgresJsDatabase<T>, i: { tripId: string; finalizedByMemberId: string; result: SettlementResult; settlementCurrency: string }): Promise<number> {
    const prev = await tx.select({ v: settlements.version }).from(settlements).where(eq(settlements.trip_id, i.tripId)).orderBy(desc(settlements.version)).limit(1);
    const version = (prev[0]?.v ?? 0) + 1;
    await tx.update(settlements).set({ status: "superseded" }).where(and(eq(settlements.trip_id, i.tripId), eq(settlements.status, "active")));
    const ins = await tx
      .insert(settlements)
      .values({ trip_id: i.tripId, version, status: "active", finalized_by_member_id: i.finalizedByMemberId, finalized_at: sql`now()`, total_settlement_amount: i.result.settlement.total })
      .returning({ id: settlements.id });
    const sid = ins[0]!.id;
    // transfers: settlement축 + local축
    const allTransfers = [
      ...i.result.settlement.transfers.map((t) => ({ basis: "settlement" as const, ...t })),
      ...Object.values(i.result.local).flatMap((ax) => ax.transfers.map((t) => ({ basis: "local" as const, ...t }))),
    ];
    if (allTransfers.length > 0) {
      await tx.insert(settlementTransfers).values(
        allTransfers.map((t) => ({ settlement_id: sid, trip_id: i.tripId, basis: t.basis, currency: t.currency, from_member_id: t.from, to_member_id: t.to, amount: t.amount, payment_status: "pending" as const })),
      );
    }
    // summaries: settlement축 + local축. settlement축 통화는 호출자가 넘긴 trip 정산통화(Summary엔 currency 없음).
    const settleCcy = i.settlementCurrency;
    const allSummaries = [
      ...i.result.settlement.summaries.map((s) => ({ basis: "settlement" as const, currency: settleCcy, ...s })),
      ...Object.entries(i.result.local).flatMap(([ccy, ax]) => ax.summaries.map((s) => ({ basis: "local" as const, currency: ccy, ...s }))),
    ];
    if (allSummaries.length > 0) {
      await tx.insert(settlementMemberSummaries).values(
        allSummaries.map((s) => ({ settlement_id: sid, trip_id: i.tripId, member_id: s.member, basis: s.basis, currency: s.currency as string, total_paid: s.total_paid, total_share: s.total_share, net_amount: s.net })),
      );
    }
    // currency_totals: local축 통화별
    const totals = Object.entries(i.result.local).map(([ccy, ax]) => ({ settlement_id: sid, currency: ccy, total_amount: ax.total }));
    if (totals.length > 0) await tx.insert(settlementCurrencyTotals).values(totals);
    return version;
  }

  /** **active·finalized 스냅샷의 settlement-basis transfer만**(finding #1 pass1). 인가-선행용 read.
   *  superseded 스냅샷·open/unlocked trip·local-basis transfer는 매칭 안 됨(null) → 결제상태 오염 차단. */
  async getActiveSettlementTransfer(exec: Exec, tripId: string, transferId: string): Promise<{ to_member_id: string; payment_status: string } | null> {
    const rows = await exec
      .select({ to: settlementTransfers.to_member_id, status: settlementTransfers.payment_status })
      .from(settlementTransfers)
      .innerJoin(settlements, eq(settlementTransfers.settlement_id, settlements.id))
      .innerJoin(trips, eq(settlements.trip_id, trips.id))
      .where(and(
        eq(settlementTransfers.trip_id, tripId),
        eq(settlementTransfers.id, transferId),
        eq(settlementTransfers.basis, "settlement"),
        eq(settlements.status, "active"),
        eq(trips.settlement_status, "finalized"),
      ));
    const r = rows[0];
    return r ? { to_member_id: r.to, payment_status: r.status } : null;
  }

  /** CAS pending→paid(멱등 — 이미 paid면 0행). **인가 tx(exec) 위에서 실행**(finding #2 pass3, 롤백 시 paid 잔존 방지). */
  async setTransferPaid(exec: Exec, tripId: string, transferId: string, actorMemberId: string): Promise<void> {
    await exec
      .update(settlementTransfers)
      .set({ payment_status: "paid", paid_at: sql`now()`, marked_by_member_id: actorMemberId })
      .where(and(eq(settlementTransfers.trip_id, tripId), eq(settlementTransfers.id, transferId), eq(settlementTransfers.payment_status, "pending")));
  }

  /** **finalized GET용**(finding #2 pass1): active 스냅샷의 영속 transfers/summaries/currency_totals + version·total.
   *  exec=getSettlement의 일관-읽기 tx(FOR SHARE 보유)로 호출(finding #2 pass2). */
  async getActiveSnapshotFull(exec: Exec, tripId: string): Promise<{
    version: number;
    total: bigint;
    transfers: { id: string; basis: string; currency: string; from_member_id: string; to_member_id: string; amount: bigint; payment_status: string; paid_at: Date | null }[];
    summaries: { member_id: string; basis: string; currency: string; total_paid: bigint; total_share: bigint; net_amount: bigint }[];
    currencyTotals: { currency: string; total_amount: bigint }[];
  } | null> {
    const s = await exec.select({ id: settlements.id, version: settlements.version, total: settlements.total_settlement_amount }).from(settlements).where(and(eq(settlements.trip_id, tripId), eq(settlements.status, "active")));
    if (!s[0]) return null;
    const sid = s[0].id;
    const transfers = await exec.select({ id: settlementTransfers.id, basis: settlementTransfers.basis, currency: settlementTransfers.currency, from_member_id: settlementTransfers.from_member_id, to_member_id: settlementTransfers.to_member_id, amount: settlementTransfers.amount, payment_status: settlementTransfers.payment_status, paid_at: settlementTransfers.paid_at }).from(settlementTransfers).where(eq(settlementTransfers.settlement_id, sid));
    const summaries = await exec.select({ member_id: settlementMemberSummaries.member_id, basis: settlementMemberSummaries.basis, currency: settlementMemberSummaries.currency, total_paid: settlementMemberSummaries.total_paid, total_share: settlementMemberSummaries.total_share, net_amount: settlementMemberSummaries.net_amount }).from(settlementMemberSummaries).where(eq(settlementMemberSummaries.settlement_id, sid));
    const currencyTotals = await exec.select({ currency: settlementCurrencyTotals.currency, total_amount: settlementCurrencyTotals.total_amount }).from(settlementCurrencyTotals).where(eq(settlementCurrencyTotals.settlement_id, sid));
    return { version: s[0].version, total: s[0].total, transfers, summaries, currencyTotals } as never;
  }

  /** active settlement-basis transfer 중 paid가 있는지(unlock 차단용, finding #1 pass2). */
  async hasActivePaidSettlementTransfer(exec: Exec, tripId: string): Promise<boolean> {
    const rows = await exec
      .select({ id: settlementTransfers.id })
      .from(settlementTransfers)
      .innerJoin(settlements, eq(settlementTransfers.settlement_id, settlements.id))
      .where(and(eq(settlementTransfers.trip_id, tripId), eq(settlementTransfers.basis, "settlement"), eq(settlementTransfers.payment_status, "paid"), eq(settlements.status, "active")));
    return rows.length > 0;
  }
}
```
> ⚠️ **`saveSnapshot`의 settlement축 통화 표기 결함**: `Summary`엔 currency가 없어 settlement축 summary의 currency를 위 의사코드처럼 추론하면 안 됨. **해결: `saveSnapshot`이 `settlementCurrency: string`을 인자로 받도록**(호출 service가 trip 정산통화 전달). 위 `settleCcy` 추론 라인은 구현 시 인자로 교체. 정확 컬럼명(`net_amount` vs `net`·`total_amount`·summaries에 trip_id 유무)은 `settlements.ts`로 확인.

**Step 4: green** → PASS.

**Step 5: Commit**
```bash
bun run fmt && bun run check
git add src/modules/settlements/settlements.repo.ts src/modules/settlements/settlements.repo.test.ts
git commit -m "feat(settlements): SettlementRepo(포함지출·saveSnapshot 이중축 supersede·markTransferPaid CAS·trip lock)"
```

---

## Task 2: settlements service (GET·precheck·finalize·unlock·mark-paid)

**Files:** Create `src/modules/settlements/settlements.service.ts` · Create `src/modules/settlements/settlements.service.test.ts`

**핵심 흐름:** `toExpenseInputs`(IncludedExpenseRow→ExpenseInput, 브랜드 캐스트·members=결제자∪참여자). finalize는 tx에서 lock→open확인→listIncluded(tx)→drift→compute→saveSnapshot→setStatus.

**Step 1: 실패 테스트** (PG)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, mkTrip, mkMember, mkExpense, type Ctx } from "../../../tests/db/helpers.ts";
import { DrizzleSettlementRepo } from "./settlements.repo.ts";
import { SettlementsService } from "./settlements.service.ts";

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
  const eid = await mkExpense(ctx.sql, trip, admin); // paid_by admin, 9320 KRW
  await ctx.sql`insert into expense_participants (trip_id, expense_id, member_id) values (${trip}, ${eid}, ${admin}), (${trip}, ${eid}, ${m2})`;
  return { trip, admin, m2, eid };
}
const svc = () => new SettlementsService(ctx.db, new DrizzleSettlementRepo(ctx.db));

describe("SettlementsService", () => {
  it("getSettlement: 라이브 계산·seen_versions·transfers", async () => {
    const { trip, eid } = await scene();
    const s = await svc().getSettlement(trip);
    expect(s.settlement_status).toBe("open");
    expect(s.seen_versions.some((v) => v.expense_id === eid)).toBe(true);
    expect(s.transfers.length).toBeGreaterThanOrEqual(1); // m2→admin
  });
  it("finalize: 스냅샷·trips finalized·version 1", async () => {
    const { trip, admin, eid } = await scene();
    const live = await svc().getSettlement(trip);
    const r = await svc().finalize(trip, live.seen_versions.map((v) => ({ expense_id: v.expense_id, version: v.version })), { memberId: admin, role: "admin" });
    expect(r.version).toBe(1);
    expect(r.settlement_status).toBe("finalized");
    const t = await ctx.sql`select settlement_status from trips where id=${trip}`;
    expect(t[0]!.settlement_status).toBe("finalized");
  });
  it("finalize: reviewed-set drift(버전 불일치) → 409", async () => {
    const { trip, admin, eid } = await scene();
    await expect(svc().finalize(trip, [{ expense_id: eid, version: 999 }], { memberId: admin, role: "admin" })).rejects.toMatchObject({ status: 409 });
  });
  it("finalize: 이미 finalized → 409", async () => {
    const { trip, admin } = await scene();
    const live = await svc().getSettlement(trip);
    const seen = live.seen_versions.map((v) => ({ expense_id: v.expense_id, version: v.version }));
    await svc().finalize(trip, seen, { memberId: admin, role: "admin" });
    await expect(svc().finalize(trip, seen, { memberId: admin, role: "admin" })).rejects.toMatchObject({ status: 409 });
  });
  it("unlock: finalized→open", async () => {
    const { trip, admin } = await scene();
    const live = await svc().getSettlement(trip);
    await svc().finalize(trip, live.seen_versions.map((v) => ({ expense_id: v.expense_id, version: v.version })), { memberId: admin, role: "admin" });
    await svc().unlock(trip, { memberId: admin, role: "admin" });
    const t = await ctx.sql`select settlement_status from trips where id=${trip}`;
    expect(t[0]!.settlement_status).toBe("open");
  });
});
```

**Step 2: 실패 확인** → FAIL.

**Step 3: 구현**

```ts
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { trips } from "../../db/schema/trips.ts";
import { ConflictError, NotFoundError, ForbiddenError, SettlementInvariantError } from "../../core/errors.ts";
import { computeSettlement, type ExpenseInput } from "./domain/compute.ts";
import { money, type MemberId, type ExpenseId } from "../../core/money.ts";
import { DrizzleSettlementRepo, type IncludedExpenseRow } from "./settlements.repo.ts";
import type { SettlementResponse } from "./settlements.schema.ts";

export interface SettleActor {
  memberId: string;
  role: string;
}

function toInputs(rows: IncludedExpenseRow[]): { expenses: ExpenseInput[]; members: MemberId[] } {
  const members = new Set<string>();
  const expenses = rows.map((r) => {
    members.add(r.paid_by_member_id);
    for (const p of r.participant_member_ids) members.add(p);
    return {
      id: r.id as ExpenseId,
      paid_by: r.paid_by_member_id as MemberId,
      participants: r.participant_member_ids as MemberId[],
      local: money(r.local_amount, r.local_currency),
      settlement: money(r.settlement_amount, r.settlement_currency),
      ...(r.refund_of_expense_id ? { refund_of: r.refund_of_expense_id as ExpenseId } : {}),
    } satisfies ExpenseInput;
  });
  return { expenses, members: [...members] as MemberId[] };
}

export class SettlementsService<T extends Record<string, unknown>> {
  constructor(
    private readonly db: PostgresJsDatabase<T>,
    private readonly repo: DrizzleSettlementRepo<T>,
  ) {}

  /** GET(finding #2 pass1): finalized면 **영속 active 스냅샷**(실 transfer id·결제상태) 반환,
   *  open이면 **라이브 compute**(합성 id·비-actionable·전부 pending). unlock 후 stale 스냅샷 노출 차단. */
  async getSettlement(tripId: string): Promise<SettlementResponse> {
    // 일관 읽기(finding #2 pass2): trips FOR SHARE로 finalize/unlock(FOR UPDATE)과 직렬화 → status·데이터 원자.
    return this.db.transaction(async (tx) => {
      const tripRow = await tx.select({ status: trips.settlement_status }).from(trips).where(eq(trips.id, tripId)).for("share");
      if (!tripRow[0]) throw new NotFoundError("trip not found");
      const status = tripRow[0].status as "open" | "finalized";
      const rows = await this.repo.listIncludedExpenses(tx, tripId);
      const seen = rows.map((r) => ({ expense_id: r.id, version: r.version }));

      if (status === "finalized") {
        const snap = await this.repo.getActiveSnapshotFull(tx, tripId);
      if (!snap) return emptyResponse(tripId, "finalized", null, seen);
      return {
        trip_id: tripId,
        settlement_status: "finalized",
        version: snap.version,
        settlement_total: snap.total.toString(),
        seen_versions: seen,
        transfers: snap.transfers.map((t) => ({ id: t.id, basis: t.basis as "settlement" | "local", currency: t.currency, from_member_id: t.from_member_id, to_member_id: t.to_member_id, amount: t.amount.toString(), payment_status: t.payment_status as "pending" | "paid", paid_at: t.paid_at ? t.paid_at.toISOString() : null })),
        summaries: snap.summaries.map((s) => ({ member_id: s.member_id, basis: s.basis as "settlement" | "local", currency: s.currency, total_paid: s.total_paid.toString(), total_share: s.total_share.toString(), net_amount: s.net_amount.toString() })),
        currency_totals: snap.currencyTotals.map((c) => ({ currency: c.currency, total_amount: c.total_amount.toString() })),
      };
    }
    // open: 라이브
    if (rows.length === 0) return emptyResponse(tripId, "open", null, seen);
    const settleCcy = rows[0]!.settlement_currency;
    const result = computeSettlement(toInputs(rows));
    const liveTransfers = [
      ...result.settlement.transfers.map((t) => ({ basis: "settlement" as const, currency: settleCcy, t })),
      ...Object.entries(result.local).flatMap(([ccy, ax]) => ax.transfers.map((t) => ({ basis: "local" as const, currency: ccy, t }))),
    ];
    return {
      trip_id: tripId,
      settlement_status: "open",
      version: null,
      settlement_total: result.settlement.total.toString(),
      seen_versions: seen,
      // 합성 id — 미영속·비-actionable(mark-paid은 active 스냅샷에서만, finding #1)
      transfers: liveTransfers.map((x) => ({ id: randomUUID(), basis: x.basis, currency: x.currency, from_member_id: x.t.from, to_member_id: x.t.to, amount: x.t.amount.toString(), payment_status: "pending" as const, paid_at: null })),
      summaries: [
        ...result.settlement.summaries.map((s) => ({ member_id: s.member, basis: "settlement" as const, currency: settleCcy, total_paid: s.total_paid.toString(), total_share: s.total_share.toString(), net_amount: s.net.toString() })),
        ...Object.entries(result.local).flatMap(([ccy, ax]) => ax.summaries.map((s) => ({ member_id: s.member, basis: "local" as const, currency: ccy, total_paid: s.total_paid.toString(), total_share: s.total_share.toString(), net_amount: s.net.toString() }))),
      ],
        currency_totals: Object.entries(result.local).map(([ccy, ax]) => ({ currency: ccy, total_amount: ax.total.toString() })),
      };
    });
  }

  async precheck(tripId: string): Promise<{ finalizable: boolean; reasons: string[]; settlement_total: string; seen_versions: { expense_id: string; version: number }[] }> {
    const rows = await this.repo.listIncludedExpenses(this.db, tripId);
    const seen_versions = rows.map((r) => ({ expense_id: r.id, version: r.version }));
    const reasons: string[] = [];
    if (rows.length === 0) reasons.push("no included expenses");
    let total = "0";
    try {
      const result = rows.length > 0 ? computeSettlement(toInputs(rows)) : null;
      total = (result?.settlement.total ?? 0n).toString();
    } catch (e) {
      if (e instanceof SettlementInvariantError) reasons.push(e.message);
      else throw e;
    }
    return { finalizable: reasons.length === 0, reasons, settlement_total: total, seen_versions };
  }

  /** finalize: trips FOR UPDATE → open 확인 → drift 대조 → compute → saveSnapshot → status='finalized'. */
  async finalize(tripId: string, seen: { expense_id: string; version: number }[], actor: SettleActor): Promise<SettlementResponse> {
    const version = await this.db.transaction(async (tx) => {
      const lock = await this.repo.lockTrip(tx, tripId);
      if (!lock) throw new NotFoundError("trip not found");
      if (lock.status !== "open") throw new ConflictError("settlement already finalized", { tripId });
      const rows = await this.repo.listIncludedExpenses(tx, tripId); // 잠긴 trip 컨텍스트
      assertNoDrift(seen, rows);
      if (rows.length === 0) throw new SettlementInvariantError("no included expenses to finalize");
      const inputs = toInputs(rows);
      const result = computeSettlement(inputs); // Σnet≠0·통화혼재면 throw(422)
      const settleCcy = rows[0]!.settlement_currency;
      const v = await this.repo.saveSnapshot(tx, { tripId, finalizedByMemberId: actor.memberId, result, settlementCurrency: settleCcy });
      await this.repo.setTripStatus(tx, tripId, "finalized");
      return v;
    });
    void version;
    return this.getSettlement(tripId); // finalized → 영속 스냅샷(새 version 포함) 반환
  }

  async unlock(tripId: string, _actor: SettleActor): Promise<void> {
    await this.db.transaction(async (tx) => {
      const lock = await this.repo.lockTrip(tx, tripId);
      if (!lock) throw new NotFoundError("trip not found");
      if (lock.status !== "finalized") throw new ConflictError("settlement not finalized", { tripId });
      // 결제 시작 후 재오픈 금지(finding #1 pass2) — paid 기록 고립/중복결제 차단. reversal/carry-forward는 후속.
      if (await this.repo.hasActivePaidSettlementTransfer(tx, tripId)) throw new ConflictError("settlement has paid transfers; cannot unlock", { tripId });
      await this.repo.setTripStatus(tx, tripId, "open");
    });
  }

  /** mark-paid(finding #1 pass1): trips FOR UPDATE→finalized 확인→active·settlement-basis transfer만→**인가 선행**→CAS.
   *  superseded/open/local transfer는 getActiveSettlementTransfer가 null → 결제상태 오염 차단. */
  async markPaid(tripId: string, transferId: string, actor: SettleActor): Promise<{ transferId: string; payment_status: string }> {
    return this.db.transaction(async (tx) => {
      const lock = await this.repo.lockTrip(tx, tripId);
      if (!lock) throw new NotFoundError("trip not found");
      if (lock.status !== "finalized") throw new ConflictError("settlement not finalized; no payable transfers", { tripId });
      const xfer = await this.repo.getActiveSettlementTransfer(tx, tripId, transferId);
      if (!xfer) throw new NotFoundError("transfer not found in active settlement");
      // 인가(mutation 전): 수취인 또는 admin
      if (xfer.to_member_id !== actor.memberId && actor.role !== "admin") throw new ForbiddenError("only recipient or admin may mark paid", { transferId });
      if (xfer.payment_status !== "paid") await this.repo.setTransferPaid(tx, tripId, transferId, actor.memberId); // 동일 tx → 원자·롤백 안전(finding #2 pass3)
      return { transferId, payment_status: "paid" };
    });
  }
}

// 빈/없음 응답(지출 0건 또는 미finalize 스냅샷 없음)
function emptyResponse(tripId: string, status: "open" | "finalized", version: number | null, seen: { expense_id: string; version: number }[]): SettlementResponse {
  return { trip_id: tripId, settlement_status: status, version, settlement_total: "0", seen_versions: seen, transfers: [], summaries: [], currency_totals: [] };
}

function assertNoDrift(seen: { expense_id: string; version: number }[], current: IncludedExpenseRow[]): void {
  const seenMap = new Map(seen.map((s) => [s.expense_id, s.version]));
  const curMap = new Map(current.map((c) => [c.id, c.version]));
  if (seenMap.size !== curMap.size) throw new ConflictError("reviewed-set drift (expense added/removed)");
  for (const [id, v] of curMap) {
    if (seenMap.get(id) !== v) throw new ConflictError("reviewed-set drift (version changed)", { expense_id: id });
  }
}
```
> **해소(pass1):** mark-paid 인가는 `getActiveSettlementTransfer` 후 mutation 전(403 검증). GET은 finalized→영속 스냅샷·open→라이브 합성id(위 구체 구현). `Exec` 타입은 select+update 포함하도록 확장(`type Exec = Pick<PostgresJsDatabase<Record<string, unknown>>, "select" | "update">`); tx의 Exec 할당 불일치 시 구현에서 PgTransaction 타입 또는 인라인.

**추가 테스트**(service.test에 포함):
```ts
  it("mark-paid: 비-수취인·비-admin → 403 (인가 선행, finding #1 pass1)", async () => {
    const { trip, admin, m2 } = await scene();
    const live = await svc().getSettlement(trip);
    await svc().finalize(trip, live.seen_versions.map((v) => ({ expense_id: v.expense_id, version: v.version })), { memberId: admin, role: "admin" });
    const t = await ctx.sql`select id, to_member_id from settlement_transfers where trip_id=${trip} and basis='settlement' limit 1`;
    const tid = t[0]!.id as string;
    const recipient = t[0]!.to_member_id as string;
    const other = recipient === admin ? m2 : admin;
    // other가 수취인도 admin도 아니면 403 (admin은 항상 허용 → other를 비-admin 일반멤버로)
    if (other !== admin) await expect(svc().markPaid(trip, tid, { memberId: other, role: "member" })).rejects.toMatchObject({ status: 403 });
  });
  it("unlock 후 지출 편집 → GET은 라이브(stale 스냅샷 미사용, finding #2 pass1)", async () => {
    const { trip, admin } = await scene();
    const live = await svc().getSettlement(trip);
    await svc().finalize(trip, live.seen_versions.map((v) => ({ expense_id: v.expense_id, version: v.version })), { memberId: admin, role: "admin" });
    await svc().unlock(trip, { memberId: admin, role: "admin" });
    await ctx.sql`update expenses set settlement_amount = settlement_amount + 1000, version = version + 1 where trip_id=${trip}`; // 편집
    const after = await svc().getSettlement(trip);
    expect(after.settlement_status).toBe("open"); // 라이브 분기
    // 영속 스냅샷(이전 version) 대신 라이브 seen_versions(증가된 version) 노출
    expect(after.version).toBeNull();
  });
  it("paid transfer 있으면 unlock → 409 (finding #1 pass2)", async () => {
    const { trip, admin } = await scene();
    const live = await svc().getSettlement(trip);
    await svc().finalize(trip, live.seen_versions.map((v) => ({ expense_id: v.expense_id, version: v.version })), { memberId: admin, role: "admin" });
    const t = await ctx.sql`select id from settlement_transfers where trip_id=${trip} and basis='settlement' limit 1`;
    await svc().markPaid(trip, t[0]!.id as string, { memberId: admin, role: "admin" }); // admin이 mark-paid
    await expect(svc().unlock(trip, { memberId: admin, role: "admin" })).rejects.toMatchObject({ status: 409 });
  });
```
> finalize/unlock 테스트의 actor는 `{ memberId, role }`(SettleActor). 위 기존 테스트의 `admin`(string) 호출도 `{ memberId: admin, role: "admin" }`로 통일.

**Step 4: green** → PASS.

**Step 5: Commit**
```bash
bun run fmt && bun run check
git add src/modules/settlements/settlements.service.ts src/modules/settlements/settlements.service.test.ts
git commit -m "feat(settlements): SettlementsService(라이브 GET·precheck·finalize drift·unlock·mark-paid)"
```

---

## Task 3: settlements controller (5 라우트)

**Files:** Create `src/modules/settlements/settlements.controller.ts` · Create `src/modules/settlements/settlements.controller.test.ts`

**라우트:** GET `/settlement`(member)·GET `/settlement/precheck`(member)·POST `/settlement/finalize`(admin)·POST `/settlement/unlock`(admin)·POST `/settlement/transfers/{transferId}/mark-paid`(member; 인가는 service).

**Step 1: 실패 테스트**(PG; createApp+registerErrorFilter+registerSettlementRoutes, resolver/memberLookup stub) — 핵심만:
```ts
// finalize happy·drift 409·비admin 403·GET 200·mark-paid. (expenses.controller.test 패턴 차용)
```
> 멤버 fixture에서 admin/일반멤버 구분(requireTripMember(lookup,"admin")). drift는 seen에 틀린 version.

**Step 2: 실패 확인** → FAIL.

**Step 3: 구현** — expenses.controller 패턴. `registerSettlementRoutes(app, { settlementsService, resolver, memberLookup, idempotencyStore })`.
- Deps에 `idempotencyStore: IdempotencyStore | null`. `const idem = deps.idempotencyStore ? [idempotency(deps.idempotencyStore)] : []`(finding #1 pass3 — finalize/unlock 응답 유실 재시도 시 replay).
- **POST finalize/unlock/mark-paid**: `middleware: [auth, admin|member, ...idem]`(상태변경 POST에 멱등). GET·precheck는 idem 없음.
- finalize 핸들러: `service.finalize(tripId, c.req.valid("json").seen_expense_versions, { memberId: c.get("membership").id, role: c.get("membership").role })`. admin 라우트는 `requireTripMember(deps.memberLookup, "admin")`, mark-paid는 `requireTripMember(deps.memberLookup)`(인가는 service가 수취인/admin 판정).
- **replay 테스트**(controller.test): 같은 Idempotency-Key로 finalize 2회 → 둘째가 첫 200 응답 replay(409 아님).

**Step 4: green** → PASS.

**Step 5: Commit**
```bash
bun run fmt && bun run check
git add src/modules/settlements/settlements.controller.ts src/modules/settlements/settlements.controller.test.ts
git commit -m "feat(settlements): 정산 zod-openapi 라우트(GET·precheck·finalize·unlock·mark-paid)"
```

---

## Task 4: buildV1App·main 배선

**Files:** Modify `src/app.ts`(V1Deps+settlementsService·registerSettlementRoutes) · `src/main.ts`(인스턴스화) · `src/openapi-gen.ts`·`src/openapi-doc.test.ts`·`src/v1-security.test.ts`(stub settlementsService 추가)

**Step 1~3:**
- app.ts: `import { registerSettlementRoutes }`·`import type { SettlementsService }`. V1Deps `settlementsService: SettlementsService<Record<string,unknown>>`. buildV1App 끝에 `registerSettlementRoutes(v1, { settlementsService: deps.settlementsService, resolver: deps.resolver, memberLookup: deps.memberLookup, idempotencyStore: deps.idempotencyStore })`(idempotencyStore는 기존 V1Deps 필드 재사용, finding #1 pass3).
- main.ts: `const settlementsService = new SettlementsService(core.db, new DrizzleSettlementRepo(core.db))`. buildV1App에 추가.
- 모든 buildV1App stub 호출(openapi-gen·openapi-doc.test·v1-security.test)에 `settlementsService: {} as never` 추가.

**Step 4: 검증**
```bash
bun run fmt && bun run check
env -u DATABASE_URL -u VALKEY_URL -u BETTER_AUTH_SECRET bun run gen:openapi  # settlement 경로 포함 확인
```

**Step 5: Commit**
```bash
git add src/app.ts src/main.ts src/openapi-gen.ts src/openapi-doc.test.ts src/v1-security.test.ts
git commit -m "feat(api): settlement 라우트 buildV1App·main 배선"
```

---

## Task 5: 계약·교차-슬라이스 테스트

**Files:** Create `src/settlement-doc.test.ts` · 교차-슬라이스는 settlements.controller.test 또는 별도

**Step 1~3:**
- `settlement-doc.test.ts`: buildV1App stub→스펙. settlement 경로(`/v1/trips/{tripId}/settlement`·`/settlement/finalize`·`/settlement/transfers/{transferId}/mark-paid`)·Settlement 스키마 컴포넌트.
- **교차-슬라이스**(PG): finalize 후 ExpensesService.createExpense→409(trips finalized); unlock 후 createExpense 재허용. (expenses+settlements service 함께 구성.)

**Step 4: 전체 스위트** — `bun run test`(기존 215 + 신규, 0 실패) + `bun run check`.

**Step 5: Commit**
```bash
bun run fmt && bun run check
git add src/settlement-doc.test.ts
git commit -m "test(settlements): 정산 OpenAPI 계약 + finalize↔expense 직렬화 교차-슬라이스"
```

---

## Definition of Done
- [ ] GET 라이브 계산·precheck·finalize(drift→409·이중축 스냅샷·trips finalized)·unlock·mark-paid(멱등) 동작
- [ ] finalize↔expense mutation 상호 직렬화(finalize 후 create 409·unlock 후 재허용)
- [ ] reviewed-set drift·이미확정·비-finalized unlock → 409; Σnet≠0 → 422
- [ ] gen:openapi 무-IO·settlement 경로 포함
- [ ] 전체 스위트 0 실패·check 통과

## Out of scope (후속, forward-ref)
transfer 결제취소(revert)·local-basis 결제추적·정산 이력 목록 API·부분정산·DB-durable 멱등·**paid 후 unlock(reversal/carry-forward)**(현재는 paid 있으면 unlock 409).

---

## Adversarial review dispositions

Codex 적대적 리뷰(working-tree 모드) **3 passes(cap)**. **총 6건 finding 전부 Accept(전부 계획 반영, 스코프-이관 0).** high 추세 2→1→1, 매 pass 다른 정합성 영역(스냅샷 격리→unlock 결제안전/GET 일관→멱등/tx 원자)으로 수렴. cap 3패스 후 **사용자 결정으로 확정**(미해결 없음). 이 섹션은 확정 후 감사추적이며 재리뷰 대상 아님.

| pass | # | finding | sev | 결정 | 반영 |
|---|---|---|---|---|---|
| 1 | 1 | mark-paid이 active·finalized 스냅샷 미스코프 | high | Accept | getActiveSettlementTransfer(active·finalized·settlement-basis JOIN)·인가 선행·CAS |
| 1 | 2 | GET이 unlock 후 stale 스냅샷 transfer 노출 | high | Accept | GET: finalized=영속 스냅샷·open=라이브 합성id |
| 2 | 1 | unlock이 paid transfer 무효화·복구정책 부재 | high | Accept | paid 있으면 unlock 409(MVP 불변식, reversal 후속) |
| 2 | 2 | GET이 status·스냅샷 비원자 읽기(race) | med | Accept | getSettlement tx + trips FOR SHARE 일관 읽기 |
| 3 | 1 | settlement POST가 Idempotency 미들웨어 누락 | high | Accept | finalize/unlock/mark-paid에 idempotency 미들웨어·replay 테스트 |
| 3 | 2 | mark-paid update가 인가 tx 밖 | med | Accept | setTransferPaid가 tx(exec) 받아 동일 tx 원자 |

**최종 pass3 `summary`:** "broken retry semantics for settlement state changes, mark-paid escapes its transaction boundary." → 멱등 미들웨어·tx-scoped mark-paid 반영으로 해소.

---

## Execution directives
- **Skill:** `executing-plans`로 **이 워크트리**(`~/workspace/trip-mate-api/.worktrees/settlement`, 브랜치 `feat/settlement`)에서 Task 0→5 구현.
- **연속 실행:** 일상 리뷰로 멈추지 말 것. 진짜 블로커에서만 정지. Docker 필요(testcontainers PG16). compute.ts 코어·DB 스키마는 기존재 — 글루만. **drizzle `.for("update")`·`.for("share")`·innerJoin·bigint·tx↔Exec 타입은 설치 타입/런타임 확인**하되 의미(이중축 스냅샷·drift 409·FOR SHARE 일관읽기·tx 원자 mark-paid·멱등)는 고정. strict-TS는 메모리 [[trip-mate-api-strict-ts-gotchas]]·[[trip-mate-api-zod-openapi-gotchas]] 참조. **정확 컬럼명**(`settlements.ts`의 summaries `net_amount`·`total_amount`·trip_id 유무)·**compute.ts 실제 시그니처**(`{expenses, members}`·throw 기반)는 코드로 확인.
- **커밋 — 직접 적용, `Skill(commit)` 금지:** 한국어·**AI 마커 금지**·`<type>(<scope>): 설명`·type은 `feat`/`fix`/`refactor`/`docs`/`style`/`test`/`chore`만. 각 Task Commit 스텝에서 `feat/settlement` 워크트리에 직접. 새 .ts 후 `bun run fmt && bun run check`(`&&` 체인).
- **시작점:** Task 0(DTO)→5 순서. SSOT 충돌 시 `api-contract-design` > 본 plan > `settlement-engine-design`/`settlement-design` > `architecture` > PRD.
