# 정산 reversal/history 구현 플랜

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 정산 transfer 결제 되돌리기(mark-unpaid) + 결제 이벤트 감사 + 정산 버전이력/이벤트 조회 API를 추가한다.

**Architecture:** 기존 settlements 모듈(schema·repo·service·controller) 확장. 신규 append-only 감사 테이블 `settlement_transfer_events`. 모든 결제 상태 변이는 단일 tx + `trips` FOR UPDATE로 finalize/unlock과 직렬화. mark-paid/unpaid는 실제 상태 전이 시에만 이벤트 기록(멱등 유지). 설계: `docs/plans/2026-06-30-settlement-reversal-history-design.md`.

**Tech Stack:** TypeScript(strict), Drizzle ORM(postgres-js), @hono/zod-openapi(Zod v4), vitest + testcontainers(postgres), drizzle-kit migrations.

**주의(레포 함정):** noUncheckedIndexedAccess(`rows[0]!`/`?.`), exactOptionalPropertyTypes(optional에 undefined 대입 금지·조건부 spread), DrizzleQueryError는 SQLSTATE가 `e.cause.code`. 새 .ts마다 `bun run fmt`→`bun run check`. 워크트리는 이미 `bun install` 됨. 모든 명령은 워크트리 `.worktrees/settlement-reversal`에서 실행.

---

### Task 1: `settlement_transfer_events` 스키마 + 마이그레이션

**Files:**
- Modify: `src/db/schema/settlements.ts` (테이블 추가)
- Modify: `tests/db/helpers.ts` (제약 위반 주입 헬퍼 2개)
- Test: `src/db/schema.constraints.test.ts` (기존 제약 통합테스트 파일에 추가; 파일명은 실제 존재명에 맞춤)

**Step 1: 위반 주입 헬퍼 추가** (`tests/db/helpers.ts` 끝에)

```ts
// settlement_transfer_events: event_type CHECK 위반
export async function insertBadTransferEvent(ctx: Ctx) {
  const { trip, m1, m2, settlement } = await transferBase(ctx);
  const tid = randomUUID();
  await ctx.sql`insert into settlement_transfers (id, settlement_id, trip_id, basis, currency, from_member_id, to_member_id, amount)
    values (${tid}, ${settlement}, ${trip}, 'settlement', 'KRW', ${m2}, ${m1}, 100)`;
  await ctx.sql`insert into settlement_transfer_events (id, transfer_id, trip_id, settlement_id, event_type, actor_member_id)
    values (${randomUUID()}, ${tid}, ${trip}, ${settlement}, 'bogus', ${m1})`; // transfer_event_type_check
}
// 타 trip actor → 복합 FK 위반(23503)
export async function insertCrossTripTransferEventActor(ctx: Ctx) {
  const { trip, m1, m2, settlement } = await transferBase(ctx);
  const tid = randomUUID();
  await ctx.sql`insert into settlement_transfers (id, settlement_id, trip_id, basis, currency, from_member_id, to_member_id, amount)
    values (${tid}, ${settlement}, ${trip}, 'settlement', 'KRW', ${m2}, ${m1}, 100)`;
  const uX = await mkUser(ctx.sql);
  const tripX = await mkTrip(ctx.sql, uX);
  const mX = await mkMember(ctx.sql, tripX, { userId: uX, role: "admin", status: "joined" });
  await ctx.sql`insert into settlement_transfer_events (id, transfer_id, trip_id, settlement_id, event_type, actor_member_id)
    values (${randomUUID()}, ${tid}, ${trip}, ${settlement}, 'paid', ${mX})`; // (trip_id, actor)→trip_members 23503
}
// 이벤트의 settlement_id가 transfer의 실제 settlement와 불일치 → 복합 FK 위반(23503)
export async function insertMismatchedTransferEvent(ctx: Ctx) {
  const { trip, m1, m2, settlement } = await transferBase(ctx);
  const tid = randomUUID();
  await ctx.sql`insert into settlement_transfers (id, settlement_id, trip_id, basis, currency, from_member_id, to_member_id, amount)
    values (${tid}, ${settlement}, ${trip}, 'settlement', 'KRW', ${m2}, ${m1}, 100)`;
  await ctx.sql`insert into settlement_transfer_events (id, transfer_id, trip_id, settlement_id, event_type, actor_member_id)
    values (${randomUUID()}, ${tid}, ${trip}, ${randomUUID()}, 'paid', ${m1})`; // (trip,settlement,transfer)↛settlement_transfers 23503
}
```

**Step 2: 제약 테스트 작성**(기존 제약 테스트 파일에 it 2개 추가). 먼저 `grep -rl "insertDuplicateFxDefault" src` 로 제약 테스트 파일을 찾고, 그 describe에 추가:

```ts
it("settlement_transfer_events: 잘못된 event_type → CHECK 위반", async () => {
  await expect(insertBadTransferEvent(ctx)).rejects.toMatchObject({ code: expect.stringMatching(/23514|23P0|23/) });
});
it("settlement_transfer_events: 타 trip actor → 복합 FK 23503", async () => {
  await expect(insertCrossTripTransferEventActor(ctx)).rejects.toMatchObject({ code: "23503" });
});
it("settlement_transfer_events: transfer와 settlement 불일치 → 복합 FK 23503", async () => {
  await expect(insertMismatchedTransferEvent(ctx)).rejects.toMatchObject({ code: "23503" });
});
```
(import에 `insertBadTransferEvent, insertCrossTripTransferEventActor, insertMismatchedTransferEvent` 추가)

**Step 3: 테스트 실패 확인(테이블 없음)**

Run: `npx vitest run <제약테스트파일>`
Expected: FAIL — relation "settlement_transfer_events" does not exist

**Step 4: 스키마 변경** (`src/db/schema/settlements.ts`). 기존 import(`check, foreignKey, index, uniqueIndex, pgTable, text, timestamp, uuid, sql, pk, tripMembers, settlements, settlementTransfers`)로 충분.

4a. **settlementTransfers에 복합 FK 타깃 추가**(Codex pass1 #2 — 이벤트가 transfer의 trip/settlement에서 발산 못 하도록): `settlementTransfers`의 컬럼 정의 배열 `(t) => [...]`에 추가
```ts
uniqueIndex("uq_transfer_trip_settlement_id").on(t.trip_id, t.settlement_id, t.id),
```
(`t.id`는 이미 PK이라 trivially unique — 복합 FK 타깃 전용)

4b. **이벤트 테이블 추가**(파일 끝). transfer 참조를 `(trip_id, settlement_id, transfer_id)` **복합 FK 하나로 일원화** → 이벤트의 trip/settlement가 실제 transfer와 항상 일치(별도 settlements FK 불필요·제거). `import`에 `bigint` 추가:
```ts
// 결제 이벤트 감사(append-only): mark-paid/unpaid 전이 기록. 설계 §3.
// 이력: 마이그레이션 이후 전이 + 기존 paid는 백필(아래 Step 5b). Codex pass1#1·pass2#2·pass3#2.
export const settlementTransferEvents = pgTable(
  "settlement_transfer_events",
  {
    id: pk(),
    // 단조 증가 정렬키(Codex pass2 #1): created_at=now()는 tx 시작시각이라 락 대기 시 역전 가능.
    // 삽입 순서를 보장하는 identity로 정렬 → 인과 안전.
    seq: bigint({ mode: "number" }).generatedAlwaysAsIdentity(),
    transfer_id: uuid().notNull(),
    trip_id: uuid().notNull(),
    settlement_id: uuid().notNull(),
    event_type: text().notNull(), // paid | unpaid
    actor_member_id: uuid().notNull(),
    created_at: timestamp({ withTimezone: true }).defaultNow().notNull(), // 표시용(정렬은 seq)
  },
  (t) => [
    check("transfer_event_type_check", sql`${t.event_type} IN ('paid','unpaid')`),
    // (trip_id, settlement_id, transfer_id)가 실제 transfer와 일치하도록 강제(발산 차단)
    foreignKey({
      columns: [t.trip_id, t.settlement_id, t.transfer_id],
      foreignColumns: [settlementTransfers.trip_id, settlementTransfers.settlement_id, settlementTransfers.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.trip_id, t.actor_member_id],
      foreignColumns: [tripMembers.trip_id, tripMembers.id],
    }),
    index("ix_transfer_event").on(t.transfer_id, t.seq.desc()),
  ],
);
```
> **cascade 근거(Codex pass2 #3, Reject):** `onDelete cascade`는 의도적이다. settlement_transfers·settlements는 **하드 삭제 경로가 없다**(saveSnapshot은 supersede만, 삭제 안 함; 삭제 엔드포인트 없음). cascade는 **trip 하드 삭제 시에만** 발동하며, 스키마 전체(expenses·members·settlements·transfers 전부)가 `trip`에 cascade한다. 감사는 trip-scoped이므로 trip 삭제 시 함께 제거가 일관·정합(삭제된 trip의 결제 이력을 보존할 이유 없음).
`src/db/schema/index.ts`가 `export * from "./settlements.ts"`인지 확인(아니면 export 추가).

**Step 5: 마이그레이션 생성**

Run: `bun run db:generate`
Expected: `src/db/migrations/XXXX_*.sql`(CREATE TABLE settlement_transfer_events + settlement_transfers UNIQUE index) + meta 스냅샷 갱신. SQL을 열어 CHECK·복합 FK·unique 포함 확인.

**Step 5b: 멱등 백필 추가**(Codex pass2 #2 — prospective 가정을 코드로 제거). 생성된 마이그레이션 `.sql` **끝에** 추가(CREATE TABLE 이후 실행되도록):

```sql
--> statement-breakpoint
-- 기존 paid transfer → 합성 'paid' 이벤트(멱등: 이미 이벤트 있으면 skip). 미배포라 보통 0건이나 가정 의존 제거.
INSERT INTO "settlement_transfer_events" ("transfer_id", "trip_id", "settlement_id", "event_type", "actor_member_id", "created_at")
SELECT st."id", st."trip_id", st."settlement_id", 'paid', st."marked_by_member_id", st."paid_at"
FROM "settlement_transfers" st
WHERE st."payment_status" = 'paid' AND st."marked_by_member_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "settlement_transfer_events" e
    WHERE e."transfer_id" = st."id" AND e."event_type" = 'paid'
  );
```
(`id`·`seq`는 default/identity로 자동. drizzle 마이그레이션은 `--> statement-breakpoint`로 문장 분리)

**Step 6: 테스트 통과 확인** + 백필 테스트

6a. 제약 테스트:
Run: `npx vitest run <제약테스트파일>`
Expected: PASS (CHECK 23514, 복합 FK 23503 × 2)

6b. 백필 동작 테스트(별도 it; 마이그레이션은 이미 적용됐으므로 **백필 SQL을 직접 재실행**해 로직 검증). `tests/db/helpers.ts`에 백필 SQL을 상수로 export하거나 테스트에 인라인:
```ts
it("백필: 기존 paid transfer가 'paid' 이벤트로 채워짐(멱등)", async () => {
  const { trip, m1, m2, settlement } = await transferBase(ctx);
  const tid = randomUUID();
  await ctx.sql`insert into settlement_transfers (id, settlement_id, trip_id, basis, currency, from_member_id, to_member_id, amount, payment_status, paid_at, marked_by_member_id)
    values (${tid}, ${settlement}, ${trip}, 'settlement','KRW',${m2},${m1},100,'paid', now(), ${m1})`;
  // 마이그레이션의 백필 INSERT...SELECT를 그대로 재실행(NOT EXISTS로 멱등)
  await ctx.sql.unsafe(BACKFILL_SQL); // helpers에서 export
  await ctx.sql.unsafe(BACKFILL_SQL); // 2회차 멱등 — 중복 없음
  const ev = await ctx.sql`select event_type, actor_member_id from settlement_transfer_events where transfer_id=${tid}`;
  expect(ev.length).toBe(1);
  expect(ev[0]!.event_type).toBe("paid");
  expect(ev[0]!.actor_member_id).toBe(m1);
});
```
`BACKFILL_SQL`은 Step 5b의 INSERT 문(마이그레이션과 동일)을 helpers.ts에서 export.

**Step 7: Commit**

```bash
git add src/db/schema/settlements.ts src/db/schema/index.ts src/db/migrations tests/db/helpers.ts <제약테스트파일>
git commit -m "feat(db): settlement_transfer_events 감사 테이블·마이그레이션(복합 FK·seq·멱등 백필)"
```

---

### Task 2: repo — 이벤트 insert·mark-unpaid CAS·이력 조회

**Files:**
- Modify: `src/modules/settlements/settlements.repo.ts`
- Test: `src/modules/settlements/settlements.repo.test.ts`

**Step 1: 실패 테스트 작성**(settlements.repo.test.ts에 describe 추가). 기존 setup/finalize 패턴 재사용. 핵심 동작:

```ts
describe("DrizzleSettlementRepo reversal/history", () => {
  it("getActiveSettlementTransfer가 settlement_id 반환", async () => {
    const { trip, admin } = await finalizedScene(); // 아래 헬퍼
    const t = await ctx.sql`select id from settlement_transfers where trip_id=${trip} and basis='settlement' limit 1`;
    const repo = new DrizzleSettlementRepo(ctx.db);
    const x = await repo.getActiveSettlementTransfer(ctx.db, trip, t[0]!.id as string);
    expect(x?.settlement_id).toBeTruthy();
  });
  it("setTransferUnpaid: paid→pending CAS(paid_at·marked_by null), 이미 pending이면 0행 영향", async () => {
    const { trip, admin } = await finalizedScene();
    const repo = new DrizzleSettlementRepo(ctx.db);
    const t = await ctx.sql`select id from settlement_transfers where trip_id=${trip} and basis='settlement' limit 1`;
    const tid = t[0]!.id as string;
    await repo.setTransferPaid(ctx.db, trip, tid, admin);
    await repo.setTransferUnpaid(ctx.db, trip, tid);
    const row = await ctx.sql`select payment_status, paid_at, marked_by_member_id from settlement_transfers where id=${tid}`;
    expect(row[0]!.payment_status).toBe("pending");
    expect(row[0]!.paid_at).toBeNull();
    expect(row[0]!.marked_by_member_id).toBeNull();
  });
  it("insertTransferEvent + listTransferEvents: 최신순", async () => {
    const { trip, admin } = await finalizedScene();
    const repo = new DrizzleSettlementRepo(ctx.db);
    const t = await ctx.sql`select id, settlement_id from settlement_transfers where trip_id=${trip} and basis='settlement' limit 1`;
    const tid = t[0]!.id as string, sid = t[0]!.settlement_id as string;
    await repo.insertTransferEvent(ctx.db, { transferId: tid, tripId: trip, settlementId: sid, eventType: "paid", actorMemberId: admin });
    await repo.insertTransferEvent(ctx.db, { transferId: tid, tripId: trip, settlementId: sid, eventType: "unpaid", actorMemberId: admin });
    const ev = await repo.listTransferEvents(ctx.db, trip, tid);
    expect(ev.map((e) => e.event_type)).toEqual(["unpaid", "paid"]); // seq desc(삽입 순서)
  });
  it("listTransferEvents: created_at 역전이어도 seq(삽입 순서)로 정렬(Codex pass2 #1)", async () => {
    const { trip, admin } = await finalizedScene();
    const repo = new DrizzleSettlementRepo(ctx.db);
    const t = await ctx.sql`select id, settlement_id from settlement_transfers where trip_id=${trip} and basis='settlement' limit 1`;
    const tid = t[0]!.id as string, sid = t[0]!.settlement_id as string;
    // 첫 삽입(paid)에 더 늦은 created_at, 둘째(unpaid)에 더 이른 created_at → created_at 정렬이면 paid가 먼저(오답)
    await ctx.sql`insert into settlement_transfer_events (transfer_id, trip_id, settlement_id, event_type, actor_member_id, created_at)
      values (${tid}, ${trip}, ${sid}, 'paid', ${admin}, '2030-01-01T00:00:00Z')`;
    await ctx.sql`insert into settlement_transfer_events (transfer_id, trip_id, settlement_id, event_type, actor_member_id, created_at)
      values (${tid}, ${trip}, ${sid}, 'unpaid', ${admin}, '2020-01-01T00:00:00Z')`;
    const ev = await repo.listTransferEvents(ctx.db, trip, tid);
    expect(ev.map((e) => e.event_type)).toEqual(["unpaid", "paid"]); // 둘째 삽입(unpaid)이 seq 큼 → 먼저
  });
  it("listSettlementVersions: 재확정 후 active+superseded 최신순", async () => {
    const { trip, admin } = await finalizedScene();
    await svc().unlock(trip, { memberId: admin, role: "admin" });
    await svc().finalize(trip, seenOf(await svc().getSettlement(trip)), { memberId: admin, role: "admin" });
    const repo = new DrizzleSettlementRepo(ctx.db);
    const vs = await repo.listSettlementVersions(ctx.db, trip);
    expect(vs.map((v) => v.version)).toEqual([2, 1]);
    expect(vs[0]!.status).toBe("active");
    expect(vs[1]!.status).toBe("superseded");
  });
  it("getTransferTripScope: 존재=true, 타 trip/부재=false", async () => {
    const { trip } = await finalizedScene();
    const repo = new DrizzleSettlementRepo(ctx.db);
    const t = await ctx.sql`select id from settlement_transfers where trip_id=${trip} limit 1`;
    expect(await repo.getTransferTripScope(ctx.db, trip, t[0]!.id as string)).toBe(true);
    expect(await repo.getTransferTripScope(ctx.db, trip, "11111111-1111-4111-8111-111111111111")).toBe(false);
  });
});
```
공유 헬퍼(파일 상단에 추가; 기존 `scene`/`svc`/`seenOf`가 service.test에 있으니 repo.test에도 동등하게 둠 — 또는 settlements.service.test의 scene 패턴 복제):

```ts
async function finalizedScene() {
  const u = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, u);
  const admin = await mkMember(ctx.sql, trip, { userId: u, role: "admin", status: "joined" });
  const u2 = await mkUser(ctx.sql);
  const m2 = await mkMember(ctx.sql, trip, { userId: u2, role: "member", status: "joined" });
  const eid = await mkExpense(ctx.sql, trip, admin);
  await ctx.sql`insert into expense_participants (trip_id, expense_id, member_id) values (${trip}, ${eid}, ${admin}), (${trip}, ${eid}, ${m2})`;
  await svc().finalize(trip, seenOf(await svc().getSettlement(trip)), { memberId: admin, role: "admin" });
  return { trip, admin, m2 };
}
```
(import: `mkMember, mkExpense` 추가; `svc`/`seenOf`는 service.test와 동일 정의 복제)

**Step 2: 실패 확인**

Run: `npx vitest run src/modules/settlements/settlements.repo.test.ts`
Expected: FAIL — `repo.setTransferUnpaid is not a function` 등

**Step 3: repo 구현** (`settlements.repo.ts`)

3a. `getActiveSettlementTransfer` select·반환에 `settlement_id` 추가:
```ts
.select({
  id: settlementTransfers.id,
  settlement_id: settlementTransfers.settlement_id,
  to: settlementTransfers.to_member_id,
  status: settlementTransfers.payment_status,
})
// ...
return r ? { settlement_id: r.settlement_id, to_member_id: r.to, payment_status: r.status } : null;
```
(반환 타입에 `settlement_id: string` 추가)

3b. 메서드 추가(클래스 내부). import에 `settlementTransferEvents` 추가, insert용 Exec 확장:
```ts
type ExecI = Pick<PostgresJsDatabase<Record<string, unknown>>, "insert">;

async setTransferUnpaid(exec: Exec, tripId: string, transferId: string): Promise<void> {
  await exec
    .update(settlementTransfers)
    .set({ payment_status: "pending", paid_at: null, marked_by_member_id: null })
    .where(
      and(
        eq(settlementTransfers.trip_id, tripId),
        eq(settlementTransfers.id, transferId),
        eq(settlementTransfers.payment_status, "paid"),
      ),
    );
}

async insertTransferEvent(
  exec: ExecI,
  e: { transferId: string; tripId: string; settlementId: string; eventType: "paid" | "unpaid"; actorMemberId: string },
): Promise<void> {
  await exec.insert(settlementTransferEvents).values({
    transfer_id: e.transferId,
    trip_id: e.tripId,
    settlement_id: e.settlementId,
    event_type: e.eventType,
    actor_member_id: e.actorMemberId,
  });
}

async listTransferEvents(
  exec: Exec,
  tripId: string,
  transferId: string,
): Promise<{ event_type: string; actor_member_id: string; created_at: Date }[]> {
  return exec
    .select({
      event_type: settlementTransferEvents.event_type,
      actor_member_id: settlementTransferEvents.actor_member_id,
      created_at: settlementTransferEvents.created_at,
    })
    .from(settlementTransferEvents)
    .where(and(eq(settlementTransferEvents.trip_id, tripId), eq(settlementTransferEvents.transfer_id, transferId)))
    .orderBy(desc(settlementTransferEvents.seq)); // 단조 seq로 삽입 순서 보장(created_at 역전 면역, Codex pass2 #1)
}

async getTransferTripScope(exec: Exec, tripId: string, transferId: string): Promise<boolean> {
  const rows = await exec
    .select({ id: settlementTransfers.id })
    .from(settlementTransfers)
    .where(and(eq(settlementTransfers.trip_id, tripId), eq(settlementTransfers.id, transferId)));
  return rows.length > 0;
}

async listSettlementVersions(
  exec: Exec,
  tripId: string,
): Promise<{ version: number; status: string; finalized_by_member_id: string; finalized_at: Date; total_settlement_amount: bigint }[]> {
  return exec
    .select({
      version: settlements.version,
      status: settlements.status,
      finalized_by_member_id: settlements.finalized_by_member_id,
      finalized_at: settlements.finalized_at,
      total_settlement_amount: settlements.total_settlement_amount,
    })
    .from(settlements)
    .where(eq(settlements.trip_id, tripId))
    .orderBy(desc(settlements.version));
}
```
주의: 정렬은 **반드시 `seq`**(identity)로 한다 — `created_at`=`now()`는 tx 시작시각이라 trip 락 대기 시 더 늦게 커밋된 이벤트가 더 이른 시각을 가질 수 있다(인과 역전). `seq`는 삽입 순서를 보장.

**Step 4: 통과 확인**

Run: `npx vitest run src/modules/settlements/settlements.repo.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/modules/settlements/settlements.repo.ts src/modules/settlements/settlements.repo.test.ts
git commit -m "feat(settlements): repo mark-unpaid CAS·이벤트 insert/조회·버전이력·transfer 스코프"
```

---

### Task 3: service — markUnpaid·markPaid 이벤트·history·transferEvents

**Files:**
- Modify: `src/modules/settlements/settlements.service.ts`
- Test: `src/modules/settlements/settlements.service.test.ts`

**Step 1: 실패 테스트 작성**(service.test에 it 추가):

```ts
it("markPaid가 'paid' 이벤트 기록(전이 시 1건, 멱등 재호출은 추가 안 함)", async () => {
  const { trip, admin } = await finalizedSceneSvc();
  const { tid, recipient } = await aTransfer(trip);
  await svc().markPaid(trip, tid, { memberId: recipient, role: "member" });
  await svc().markPaid(trip, tid, { memberId: recipient, role: "member" }); // 멱등
  const ev = await svc().transferEvents(trip, tid);
  expect(ev.filter((e) => e.event_type === "paid").length).toBe(1);
});
it("markUnpaid: paid→pending + 'unpaid' 이벤트", async () => {
  const { trip, admin } = await finalizedSceneSvc();
  const { tid, recipient } = await aTransfer(trip);
  await svc().markPaid(trip, tid, { memberId: recipient, role: "member" });
  const r = await svc().markUnpaid(trip, tid, { memberId: recipient, role: "member" });
  expect(r.payment_status).toBe("pending");
  const ev = await svc().transferEvents(trip, tid);
  expect(ev[0]!.event_type).toBe("unpaid");
});
it("markUnpaid: 비수취인·비admin → 403", async () => {
  const { trip, admin, m2 } = await finalizedSceneSvc();
  const { tid, recipient } = await aTransfer(trip);
  const other = recipient === admin ? m2 : admin;
  await expect(svc().markUnpaid(trip, tid, { memberId: other, role: "member" })).rejects.toMatchObject({ status: 403 });
});
it("markUnpaid: finalized 아님 → 409", async () => {
  const { trip, admin } = await finalizedSceneSvc();
  const { tid } = await aTransfer(trip);
  await svc().unlock(trip, { memberId: admin, role: "admin" }); // pending이라 unlock 가능
  await expect(svc().markUnpaid(trip, tid, { memberId: admin, role: "admin" })).rejects.toMatchObject({ status: 409 });
});
it("markUnpaid: 멱등(이미 pending) → pending 반환·이벤트 없음", async () => {
  const { trip, admin } = await finalizedSceneSvc();
  const { tid, recipient } = await aTransfer(trip);
  const r = await svc().markUnpaid(trip, tid, { memberId: recipient, role: "member" });
  expect(r.payment_status).toBe("pending");
  expect(await svc().transferEvents(trip, tid)).toEqual([]);
});
it("settlementHistory: 재확정 후 [v2 active, v1 superseded]", async () => {
  const { trip, admin } = await finalizedSceneSvc();
  await svc().unlock(trip, { memberId: admin, role: "admin" });
  await svc().finalize(trip, seenOf(await svc().getSettlement(trip)), { memberId: admin, role: "admin" });
  const h = await svc().settlementHistory(trip);
  expect(h.map((x) => [x.version, x.status])).toEqual([[2, "active"], [1, "superseded"]]);
});
it("transferEvents: 타 trip transfer → 404", async () => {
  const { trip } = await finalizedSceneSvc();
  await expect(svc().transferEvents(trip, "11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({ status: 404 });
});
```
헬퍼(service.test 상단에 추가): `finalizedSceneSvc`(= scene + finalize), `aTransfer(trip)`(= `select id, to_member_id ... basis='settlement' limit 1` → `{ tid, recipient }`).

**Step 2: 실패 확인**

Run: `npx vitest run src/modules/settlements/settlements.service.test.ts`
Expected: FAIL — `svc().markUnpaid is not a function` 등

**Step 3: service 구현** (`settlements.service.ts`)

3a. **로컬 반환 타입 정의**(Codex pass1 #3 — Task 4 DTO보다 먼저라 import 의존 없이 이 체크포인트가 컴파일됨; Task 4 z-schema와 구조 동일하며 컨트롤러에서 assignability 검증):
```ts
interface SettlementHistoryEntry {
  version: number;
  status: "active" | "superseded";
  finalized_by_member_id: string;
  finalized_at: string;
  settlement_total: string;
}
interface TransferEventEntry {
  event_type: "paid" | "unpaid";
  actor_member_id: string;
  created_at: string;
}
```
3b. markPaid 전이 블록에 이벤트:
```ts
if (xfer.payment_status !== "paid") {
  await this.repo.setTransferPaid(tx, tripId, transferId, actor.memberId);
  await this.repo.insertTransferEvent(tx, {
    transferId, tripId, settlementId: xfer.settlement_id, eventType: "paid", actorMemberId: actor.memberId,
  });
}
```
3c. 메서드 추가:
```ts
async markUnpaid(
  tripId: string,
  transferId: string,
  actor: SettleActor,
): Promise<{ transferId: string; payment_status: string }> {
  return this.db.transaction(async (tx) => {
    const lock = await this.repo.lockTrip(tx, tripId);
    if (!lock) throw new NotFoundError("trip not found");
    if (lock.status !== "finalized")
      throw new ConflictError("settlement not finalized; no reversible transfers", { tripId });
    const xfer = await this.repo.getActiveSettlementTransfer(tx, tripId, transferId);
    if (!xfer) throw new NotFoundError("transfer not found in active settlement");
    if (xfer.to_member_id !== actor.memberId && actor.role !== "admin")
      throw new ForbiddenError("only recipient or admin may mark unpaid", { transferId });
    if (xfer.payment_status === "paid") {
      await this.repo.setTransferUnpaid(tx, tripId, transferId);
      await this.repo.insertTransferEvent(tx, {
        transferId, tripId, settlementId: xfer.settlement_id, eventType: "unpaid", actorMemberId: actor.memberId,
      });
    }
    return { transferId, payment_status: "pending" };
  });
}

async settlementHistory(tripId: string): Promise<SettlementHistoryEntry[]> {
  const rows = await this.repo.listSettlementVersions(this.db, tripId);
  return rows.map((r) => ({
    version: r.version,
    status: r.status as "active" | "superseded",
    finalized_by_member_id: r.finalized_by_member_id,
    finalized_at: r.finalized_at.toISOString(),
    settlement_total: r.total_settlement_amount.toString(),
  }));
}

async transferEvents(tripId: string, transferId: string): Promise<TransferEventEntry[]> {
  if (!(await this.repo.getTransferTripScope(this.db, tripId, transferId)))
    throw new NotFoundError("transfer not found");
  const rows = await this.repo.listTransferEvents(this.db, tripId, transferId);
  return rows.map((r) => ({
    event_type: r.event_type as "paid" | "unpaid",
    actor_member_id: r.actor_member_id,
    created_at: r.created_at.toISOString(),
  }));
}
```

**Step 4: 통과 확인**

Run: `npx vitest run src/modules/settlements/settlements.service.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/modules/settlements/settlements.service.ts src/modules/settlements/settlements.service.test.ts
git commit -m "feat(settlements): markUnpaid(인가·멱등·이벤트)·markPaid 이벤트·settlementHistory·transferEvents"
```

---

### Task 4: DTO 스키마

**Files:**
- Modify: `src/modules/settlements/settlements.schema.ts`

**Step 1: 스키마 추가**(schema.ts 끝, type export 위):

```ts
export const settlementHistoryEntrySchema = z
  .object({
    version: z.number().int(),
    status: z.enum(["active", "superseded"]),
    finalized_by_member_id: z.string().uuid(),
    finalized_at: z.string(),
    settlement_total: z.string().regex(/^\d+$/),
  })
  .openapi("SettlementHistoryEntry");

export const transferEventSchema = z
  .object({
    event_type: z.enum(["paid", "unpaid"]),
    actor_member_id: z.string().uuid(),
    created_at: z.string(),
  })
  .openapi("TransferEvent");

export type SettlementHistoryEntry = z.infer<typeof settlementHistoryEntrySchema>;
export type TransferEventEntry = z.infer<typeof transferEventSchema>;
```
이 z.infer 타입은 Task 3 service의 로컬 인터페이스와 구조가 동일해야 한다(컨트롤러 Task 5가 service 반환을 이 응답 스키마로 검증 → 발산 시 tsc 에러로 포착).

**Step 2: 타입체크**

Run: `bun run check`
Expected: PASS

**Step 3: Commit**

```bash
git add src/modules/settlements/settlements.schema.ts
git commit -m "feat(settlements): 버전이력·결제이벤트 DTO 스키마"
```

---

### Task 5: controller — 라우트 3개

**Files:**
- Modify: `src/modules/settlements/settlements.controller.ts`
- Test: `src/modules/settlements/settlements.controller.test.ts`

**Step 1: 실패 테스트 작성**(controller.test에 it 추가, 기존 appFor/finalize 패턴 사용):
- `POST .../transfers/{tid}/mark-unpaid` (수취인) → 200 `{payment_status:"pending"}`, 선행 mark-paid 후
- 비수취인·비admin → 403
- 미존재 transfer → 404
- finalized 아님(unlock 후) → 409
- `GET .../settlement/history` → 200 배열, 재확정 후 length 2
- `GET .../settlement/transfers/{tid}/events` → 200, paid→unpaid 후 2건; 타 transfer → 404
- mark-unpaid 후 unlock 가능(paid 없음) — 회귀: reversal이 unlock 차단을 해제

**Step 2: 실패 확인**

Run: `npx vitest run src/modules/settlements/settlements.controller.test.ts`
Expected: FAIL (404 route not found)

**Step 3: 라우트 구현** (`settlements.controller.ts`). import에 `settlementHistoryEntrySchema, transferEventSchema` 추가. 응답 스키마(mark-unpaid는 mark-paid 패턴대로 inline):

```ts
const markUnpaidResponse = z
  .object({ transferId: z.string(), payment_status: z.string() })
  .openapi("MarkUnpaidResult");
```
라우트 3개 추가(registerSettlementRoutes 내부):
```ts
app.openapi(
  createRoute({
    method: "post",
    path: "/trips/{tripId}/settlement/transfers/{transferId}/mark-unpaid",
    security: [{ cookieAuth: [] }],
    middleware: [auth, member, ...idem],
    request: { params: z.object({ tripId: z.string().uuid(), transferId: z.string().uuid() }) },
    responses: { ...ok(markUnpaidResponse), ...errorResponses(403, 404, 409) },
  }),
  async (c) => {
    const { tripId, transferId } = c.req.valid("param");
    return c.json(await deps.settlementsService.markUnpaid(tripId, transferId, actorOf(c)), 200);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/trips/{tripId}/settlement/history",
    security: [{ cookieAuth: [] }],
    middleware: [auth, member],
    request: { params: z.object({ tripId: z.string().uuid() }) },
    responses: { ...ok(z.array(settlementHistoryEntrySchema)), ...errorResponses(403, 404) },
  }),
  async (c) => c.json(await deps.settlementsService.settlementHistory(c.req.valid("param").tripId), 200),
);

app.openapi(
  createRoute({
    method: "get",
    path: "/trips/{tripId}/settlement/transfers/{transferId}/events",
    security: [{ cookieAuth: [] }],
    middleware: [auth, member],
    request: { params: z.object({ tripId: z.string().uuid(), transferId: z.string().uuid() }) },
    responses: { ...ok(z.array(transferEventSchema)), ...errorResponses(403, 404) },
  }),
  async (c) => {
    const { tripId, transferId } = c.req.valid("param");
    return c.json(await deps.settlementsService.transferEvents(tripId, transferId), 200);
  },
);
```

**Step 4: 통과 확인**

Run: `npx vitest run src/modules/settlements/settlements.controller.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/modules/settlements/settlements.controller.ts src/modules/settlements/settlements.controller.test.ts
git commit -m "feat(settlements): mark-unpaid·settlement history·transfer events 라우트"
```

---

### Task 6: OpenAPI 계약 + openapi.json 재생성

**Files:**
- Modify: `src/settlement-doc.test.ts`
- Modify: `openapi.json`

**Step 1: 실패 doc 테스트 작성**(settlement-doc.test.ts에 it 추가):
```ts
it("reversal/history 경로·스키마 등록", () => {
  const d = doc();
  const paths = Object.keys(d.paths ?? {});
  expect(paths.some((p) => p.endsWith("/transfers/{transferId}/mark-unpaid"))).toBe(true);
  expect(paths.some((p) => p.endsWith("/settlement/history"))).toBe(true);
  expect(paths.some((p) => p.endsWith("/transfers/{transferId}/events"))).toBe(true);
  const schemas = d.components?.schemas ?? {};
  expect(schemas.SettlementHistoryEntry).toBeDefined();
  expect(schemas.TransferEvent).toBeDefined();
  expect(schemas.MarkUnpaidResult).toBeDefined();
});
```

**Step 2: 실패 확인 → openapi 재생성**

Run: `npx vitest run src/settlement-doc.test.ts` (FAIL: 경로/스키마 부재 — buildV1App는 이미 라우트 등록하므로 사실 PASS일 수 있음; doc은 라이브 생성이라 통과. 그렇다면 Step 2는 PASS 확인)
Run: `bun run gen:openapi` → openapi.json 갱신(신규 3 경로·스키마)

**Step 3: 전체 검증**

Run: `bun run fmt && bun run check && bun run test`
Expected: 전체 PASS(신규 테스트 포함), openapi.json 변경 반영

**Step 4: Commit**

```bash
git add src/settlement-doc.test.ts openapi.json
git commit -m "test(settlements): reversal/history OpenAPI 계약 + openapi.json 재생성"
```

---

## 감사 이력 범위 (계약, Codex pass1 #1 · pass2 #2 · pass3 #2)

결제 이벤트 이력은 마이그레이션 시점부터 **완전**하다(단일 계약 — pass3 #2 모순 해소):
- 마이그레이션 **이후**의 모든 paid/unpaid 전이는 mark-paid/mark-unpaid가 기록.
- 마이그레이션 **이전**에 이미 paid였던 transfer는 **백필**(Step 5b)로 합성 'paid' 이벤트 1건(actor=`marked_by_member_id`, created_at=`paid_at`)을 받는다. 이전 'unpaid' 이력은 없다(해당 transfer는 paid만 거쳤으므로).
- 따라서 events 엔드포인트는 "해당 transfer의 paid/unpaid 전이 전체(백필된 과거 paid 포함)"를 반환한다 — prospective-only 아님.

이 백엔드는 미배포라 실제 백필 대상은 0건이지만, 백필 INSERT가 "기존 paid 없음" 가정을 코드로 제거하므로 어떤 환경에서도 계약이 성립한다.

## 마이그레이션·릴리스 (Codex pass3 #1)

- **순서**: 마이그레이션을 **코드보다 먼저** 적용한다(신규 서비스 코드가 `settlement_transfer_events`에 INSERT하므로). 이 레포 CI는 `db:migrate`→배포 순.
- **구버전 호환**: 변경은 **추가 전용**(신규 테이블 + `settlement_transfers`에 추가 unique index). 기존 코드/쿼리는 영향 없음 → 마이그레이션 후 구버전 코드도 정상 동작(rolling 안전).
- **코드 롤백**: 코드만 롤백 시 테이블·이벤트는 **그대로 둔다**(추가 전용이라 구버전이 무시). 데이터 손실 없음.
- **마이그레이션 실패**: 백필 INSERT 전 DDL 단계에서 실패하면 안전 — 부분 생성 객체만 수동 drop(`settlement_transfer_events`, unique index) 후 재시도. 백필은 멱등(NOT EXISTS)이라 재실행 안전.

## 검증 체크리스트(완료 기준)

- [ ] `bun run check`(oxlint+oxfmt+tsc) 클린
- [ ] `bun run test` 전체 PASS(신규: 제약·repo·service·controller·doc)
- [ ] mark-unpaid 후 `unlock` 가능(reversal이 차단 해제) 회귀 통과
- [ ] 멱등: mark-paid/unpaid 재호출이 이벤트 중복 생성 안 함
- [ ] (무결성) 이벤트 `(trip_id, settlement_id, transfer_id)`가 실제 transfer와 복합 FK로 구속 — 불일치 insert 23503 제약테스트 통과
- [ ] (정렬) 이벤트는 `seq`(identity)로 정렬 — created_at 역전 면역 테스트 통과
- [ ] (계약) 이력 완전성 — 마이그레이션 이후 전이 + 기존 paid 백필; events가 전이 전체 반환(백필 테스트 통과)
- [ ] openapi.json에 3개 신규 경로 + 3개 스키마 반영

---

## Adversarial review dispositions

Codex(`adversarial-review.mjs`, working-tree) 3-pass. 최종(pass3) verdict=`needs-attention`(잔여 medium 2건), summary="release recovery and audit-history semantics not coherent enough" — 잔여 2건 **반영 후 사용자 결정으로 확정**(high/critical 미해결 0).

**Pass 1** (needs-attention, 3 findings):
- #1 기존 paid transfer 감사 공백 (high) — **Accepted**: "prospective" 대신 멱등 백필로 전환(pass2/3에서 구체화).
- #2 이벤트가 transfer의 trip/settlement에 미구속 (high) — **Accepted**: `(trip_id, settlement_id, transfer_id)` 복합 FK + settlement_transfers unique 타깃.
- #3 Task 순서로 service 빌드 불가 (medium) — **Accepted**: service에 로컬 반환 타입 정의(DTO import 의존 제거).

**Pass 2** (needs-attention, 3 findings):
- #1 이벤트 정렬 인과 불안정(`now()`=tx 시작시각) (high) — **Accepted**: `seq` identity 추가, `order by seq desc` + created_at 역전 면역 테스트.
- #2 prospective 무백필이 미검증 가정 의존 (high) — **Accepted**: 마이그레이션에 멱등 백필 INSERT + 백필 테스트.
- #3 append-only인데 cascade 삭제 (medium) — **Rejected**: transfer/settlement 하드삭제 경로 없음(supersede만)·스키마 전체가 trip에 cascade·감사는 trip-scoped → 의도된 동작(근거 노트 보강).

**Pass 3** (needs-attention, 2 findings, cap):
- #1 마이그레이션 배포/롤백 경로 미명시 (medium) — **Accepted**: "마이그레이션·릴리스" 섹션 추가.
- #2 이력 범위 자기모순(백필 vs prospective) (medium) — **Accepted**: 계약을 백필 쪽으로 일원화("이력 완전" 단일 계약).

## Execution directives
- **Skill:** implement via `executing-plans` in a **separate session, in this worktree**(`.worktrees/settlement-reversal`).
- **Run continuously:** 배치 사이에 멈추지 말 것. 진짜 블로커(의존성 부재·반복 실패하는 검증·모순 지시·치명적 플랜 공백)에서만 중단(executing-plans의 "When to Stop and Ask"). 그 외 전 배치 완료까지 진행.
- **검증:** 새 .ts마다 `bun run fmt`→`bun run check`(oxlint+oxfmt+tsc strict). 통합테스트는 testcontainers(Docker 필요). 마무리 `bun run test` 전체 green + `bun run gen:openapi` 후 openapi.json 커밋.
- **Commits — 직접 수행, `Skill(commit)` 호출 금지**(상호작용 확인이 연속 실행을 깸):
  - **언어:** 한국어. **AI 마커 금지**(`🤖 Generated with`·`Co-Authored-By` 등 절대 포함 안 함 — 레포 관례).
  - **형식:** `<type>(<scope>): 한국어 설명`(필요 시 `- 상세` 본문).
  - **type(이것만):** `feat`·`fix`·`refactor`·`docs`·`style`·`test`·`chore`. (`perf`/`build`/`ci` 금지)
  - **그룹화:** 플랜의 각 Task `Commit` 단계대로(db/스키마 → repo → schema DTO → service → controller → 계약). 같은 모듈+같은 목적은 한 커밋.
  - **위치:** 현재 `feat/settlement-reversal` 워크트리에 직접(이미 main 밖이라 새 브랜치 불요).
