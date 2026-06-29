# trip-mate DB 설계 (PostgreSQL + Drizzle)

- 작성일: 2026-06-25
- 대상: trip-mate 백엔드(`trip-mate-api`) 데이터 모델
- 기반 문서: `docs/trip-mate-prd.md`(v1.4) · `docs/architecture.md`(v1.1) · `docs/tech-stack.md`(v1.1)
- DB: CloudNativePG **PostgreSQL 16** · ORM: **Drizzle** · 금전 연산: 서버측 BigInt 정수
- 본 문서는 구현 착수 전 **적대적 리뷰(Codex)로 hardening**할 설계안이다.

## 1. 범위·목표

PRD §11.2의 엔티티(users·trips·trip_members·expenses·expense_audit_logs·settlements·settlement_transfers·settlement_member_summaries)를 실제 PostgreSQL 스키마로 확정한다. 정산은 순수 함수 재계산(IO 없음, 결정적 BigInt)이며, DB는 **불변식을 제약으로 강제**하고 **확정 스냅샷을 동결**한다.

핵심 불변식(PRD §18):
- `Σ(참여자 부담액) == 지출 settlement_amount` (지출별, 정수)
- `Σ(전 멤버 순정산) == 0` (basis·통화별)
- 동일 입력 → 동일 송금 리스트(결정적 정렬) → 확정 스냅샷 재현

## 2. 횡단 규약 (확정됨)

| 항목 | 결정 | 근거 |
|---|---|---|
| PK | `uuid v4` (`uuid().defaultRandom()`), 모든 테이블 `id` | trips는 PRD §34.4 불투명 UUID 필수. 규모(지출 ≤300/trip)상 v4 지역성 손해 무시. |
| 금액 | `bigint` **최소단위 정수**(`mode:'bigint'`) | PRD §18.2.1 정수 결정 연산. 부동소수점 금지. |
| 환율 | `numeric(20,10)` authoritative 고정밀, card_billed면 null | 금액 아님; 저→고가 cross-rate 정밀(FX 설계 §4.3). |
| 시간 | `timestamptz`(이벤트) / `date`(일자) | TZ 안전. |
| enum(안정) | `pgEnum`: role·member_status·settlement_status·snapshot_status·payment_status·basis·settlement_amount_source·exchange_rate_source·expense_settlement_state | 값 고정. |
| enum(진화) | **text + CHECK**: input_source·category·payment_method | Phase마다 값 증가 → ALTER TYPE 회피. |
| 통화 | **`currencies` 룩업 테이블**(§48 SSOT), 모든 `*_currency`에 FK | "없는 통화 코드" DB 차단, minor_unit 데이터화. |
| 여행 시간대 | `trips.timezone`(IANA) 신설 | 환율 일자를 **현지 TZ 기준**으로 산출. |
| converted 반올림 | **round-half-away-from-zero** (절댓값 기준 0.5 올림, 음수 대칭) | 사용자 직관, 음수(환불) 대칭. |
| 명명 | snake_case 강제 | PG 식별자 gotcha. |
| FK 인덱스 | **모든 FK 컬럼에 수동 인덱스** | PG는 FK 자동 인덱스 안 함. |
| soft delete | `expenses.deleted_at` (soft), 여행방 삭제는 hard cascade | 감사·정산 무결성. |
| 테넌트 격리 | 멤버/지출 참조는 **same-trip composite FK**(§2.2) | cross-trip 참조 DB 차단(리뷰 #1). |

### 2.1 converted 정수 산식 (결정적)
환율(major↔major, 예 `1 THB = 37.9 KRW`)을 정산통화 최소단위 정수로:
```
settlement_minor = round_half_away_from_zero( local_minor × rate × 10^(settle_exp − local_exp) )
```
- 검증: 1,000 THB(THB exp=2 → local_minor=100000), rate=37.9, KRW exp=0
  → round(100000 × 37.9 × 10^(−2)) = 37,900 KRW (PRD §13.3 일치)
- rate는 `rate×10^6`(정수)로 스케일 → 전부 정수 연산, 마지막에 반올림(부동소수점 0).
- card_billed면 이 산식 미적용(카드사 청구액 그대로), exchange_rate=null 허용.

### 2.2 Same-trip composite FK (리뷰 #1)
멤버/지출을 참조하는 자식 행이 **다른 trip의 멤버/지출**을 가리키지 못하게, inline 단일 FK 대신 **composite FK**로 same-trip을 DB가 강제한다.
- 타깃 유니크: `trip_members UNIQUE(trip_id, id)`, `expenses UNIQUE(trip_id, id)`
- `expenses`: `(trip_id, paid_by_member_id)`·`(trip_id, created_by_member_id)`·`(trip_id, last_modified_by_member_id)` → `trip_members(trip_id, id)`
- `expense_participants`: `trip_id` 추가 → `(trip_id, expense_id)→expenses(trip_id,id)`, `(trip_id, member_id)→trip_members(trip_id,id)`
- `settlements`: `(trip_id, finalized_by_member_id)→trip_members(trip_id,id)`; 타깃 유니크 `settlements UNIQUE(trip_id, id)`
- `settlement_transfers`/`settlement_member_summaries`: `trip_id` 추가 → `(trip_id, *_member_id)→trip_members(trip_id,id)` **및 `(trip_id, settlement_id)→settlements(trip_id,id)`**(자식 trip = settlement의 trip 강제, 리뷰 pass2 #1)
- `expense_audit_logs`: `(trip_id, expense_id)→expenses(trip_id,id)`, `(trip_id, changed_by_member_id)→trip_members(trip_id,id)` (리뷰 pass2 #2)
- `expenses.settlement_currency`: `(trip_id, settlement_currency)→trips(id, settlement_currency)` — **trip 단일 정산통화 강제**(§17.1, pass2 #3). 타깃 유니크 `trips UNIQUE(id, settlement_currency)`. **정책(pass3 #3): expense가 1건이라도 있으면 `trips.settlement_currency` 변경 금지**(서비스 가드, 권장). 지원하려면 이 FK를 `DEFERRABLE INITIALLY DEFERRED`로 두고 같은 tx에서 trips→전체 expense 원자 재계산.
- `expenses.refund_of_expense_id`: nullable `(trip_id, refund_of_expense_id)→expenses(trip_id,id)` composite FK + self 가드(`IS NULL OR <> id`) (pass3 #2).
- 해당 테이블의 인라인 단일 `.references`는 위 composite FK로 대체한다.

## 3. 공통 헬퍼

```ts
// db/schema/_shared.ts
export const pk = () => uuid('id').defaultRandom().primaryKey()
export const timestamps = {
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}
```

## 4. currencies (룩업, §48 SSOT)

```ts
export const currencies = pgTable('currencies', {
  code:        text('code').primaryKey(),          // CHECK (length=3)
  iso_exponent: integer('iso_exponent').notNull(),  // 참고용 ISO 4217
  minor_unit:   integer('minor_unit').notNull(),    // 서비스 최소단위 지수(엔진 사용)
  symbol:       text('symbol').notNull(),
})
```
seed: KRW/JPY/VND minor_unit=0; **TWD iso=2 but minor_unit=0(정수)**; USD/EUR/THB/GBP/CHF minor_unit=2.

## 5. 도메인 1 — 식별 & 여행방

```ts
// ── 인증 테이블 = Better Auth 관리: user · account · session · verification (`cli generate`, auth 설계 D1)
//    · 앱 식별자 = user.id. Better Auth `database.generateId='uuid'`로 uuid 발급(FK 호환).
//    · Google sub = account.accountId(providerId='google'). **account: unique(provider_id, account_id)** — Google sub 1:1·이메일 링킹 금지(병합불가 principal, auth pass2).
//    · user(email·name·image·email_verified)가 PRD §7.3 users 필드 충족. **커스텀 users 테이블 폐기.**
//    · 세션은 Valkey(secondaryStorage) → session 테이블 미사용 가능.
//    아래 trips·trip_members의 user 참조는 Better Auth `user.id` (상세 docs/plans/2026-06-29-auth-invite-design.md).

export const trips = pgTable('trips', {
  id: pk(),
  title: text().notNull(),
  start_date: date().notNull(),
  end_date: date().notNull(),
  destination_countries: text().array().notNull(),                 // ISO 3166, ≥1
  timezone: text().notNull(),                                      // IANA, 예 'Asia/Taipei'
  primary_local_currency: text().notNull().references(() => currencies.code),
  settlement_currency:    text().notNull().references(() => currencies.code),
  created_by_user_id: uuid().notNull().references(() => user.id),       // Better Auth user.id
  settlement_status: settlementStatusEnum().notNull().default('open'),  // open | finalized
  finalized_at: timestamp({ withTimezone: true }),
  ...timestamps,
}, (t) => [
  check('trip_dates', sql`${t.start_date} <= ${t.end_date}`),
  uniqueIndex('uq_trip_settlement_ccy').on(t.id, t.settlement_currency),  // expense.settlement_currency composite FK 타깃(§2.2)
  index('ix_trip_creator').on(t.created_by_user_id),
])

export const tripMembers = pgTable('trip_members', {
  id: pk(),
  trip_id: uuid().notNull().references(() => trips.id, { onDelete: 'cascade' }),
  user_id: uuid().references(() => user.id),                        // Better Auth user.id, null = 초대만 됨(대리입력)
  invited_email: text().notNull(),
  normalized_invited_email: text().notNull(),                       // §8.5
  invite_token_hash: text(),                                        // 해시만 저장
  invite_token_expires_at: timestamp({ withTimezone: true }),
  display_name: text().notNull(),
  role: roleEnum().notNull().default('member'),                     // admin | member
  status: memberStatusEnum().notNull().default('invited'),          // invited|joined|deactivated|invite_expired
  joined_at: timestamp({ withTimezone: true }),
  ...timestamps,
}, (t) => [
  uniqueIndex('uq_member_email').on(t.trip_id, t.normalized_invited_email),   // 중복 초대 방지
  uniqueIndex('uq_member_user').on(t.trip_id, t.user_id),                     // 같은 user 1회(null 다중 허용)
  uniqueIndex('uq_one_admin').on(t.trip_id).where(sql`role='admin' AND status='joined'`),  // active 어드민 ≤1
  uniqueIndex('uq_member_trip_id').on(t.trip_id, t.id),             // composite FK 타깃(§2.2)
  uniqueIndex('uq_invite_token').on(t.invite_token_hash).where(sql`invite_token_hash IS NOT NULL`),  // 한 해시=정확히 1 pending(auth pass4)
  index('ix_member_user').on(t.user_id),
])
```
- `uq_member_user`: UNIQUE는 NULL 다중 허용 → 초대 대기(user_id null) 여러 명 공존, join 시 유일성 발동.
- `uq_one_admin` 부분 유니크 = 어드민 최대 1명(최소 1명은 앱 가드 §9.5).

## 6. 도메인 2 — 지출

```ts
export const expenses = pgTable('expenses', {
  id: pk(),
  trip_id: uuid().notNull().references(() => trips.id, { onDelete: 'cascade' }),
  title: text().notNull(),
  local_amount:        bigint({ mode: 'bigint' }).notNull(),
  local_currency:      text().notNull().references(() => currencies.code),    // §17.2 지출별 통화 수용
  settlement_amount:   bigint({ mode: 'bigint' }).notNull(),
  settlement_currency: text().notNull(),   // = trip.settlement_currency (composite FK §2.2)
  exchange_rate: numeric({ precision: 20, scale: 10 }),             // authoritative 고정밀, card_billed면 null (FX §4.3)
  exchange_rate_date: date().notNull(),                             // 현지 TZ 일자(파생)
  exchange_rate_source: rateSourceEnum(),                           // identity|manual|auto|last_known|trip_default, card_billed면 null
  exchange_rate_provider: text(),                                   // FX provenance: oxr|currencyapi (auto/last_known)
  exchange_rate_table_date: date(),                                 // rate가 나온 테이블 일자
  exchange_rate_fetched_at: timestamp({ withTimezone: true }),
  settlement_amount_source: amountSourceEnum().notNull(),           // card_billed|converted
  payment_method: text().notNull(),                                 // CHECK
  category: text().notNull(),                                       // CHECK
  input_source: text().notNull().default('manual'),                 // CHECK
  expense_settlement_state: expenseStateEnum().notNull().default('included'),  // included|personal|record_only
  paid_by_member_id:          uuid().notNull(),   // composite FK (trip_id, …) → trip_members (§2.2)
  created_by_member_id:       uuid().notNull(),
  last_modified_by_member_id: uuid(),
  memo: text(),
  spent_at: timestamp({ withTimezone: true }).notNull(),
  refund_of_expense_id: uuid(),  // §47.1 — composite FK (trip_id, …) → expenses (§2.2)
  version: integer().notNull().default(0),                          // 낙관적 잠금 §31.6
  deleted_at: timestamp({ withTimezone: true }),                    // soft delete
  ...timestamps,
}, (t) => [
  // FX는 settlement_amount_source에 묶임 (FX 설계 pass3 #2)
  check('fx_by_source', sql`(${t.settlement_amount_source}='converted' AND ${t.exchange_rate} IS NOT NULL AND ${t.exchange_rate_source} IS NOT NULL) OR (${t.settlement_amount_source}='card_billed' AND ${t.exchange_rate_source} IS NULL)`),
  index('ix_exp_trip_spent').on(t.trip_id, t.spent_at.desc()),      // 목록 정렬(§32.7)
  index('ix_exp_paid_by').on(t.paid_by_member_id),
  index('ix_exp_created_by').on(t.created_by_member_id),
  index('ix_exp_settle').on(t.trip_id).where(sql`expense_settlement_state='included' AND deleted_at IS NULL`),
  uniqueIndex('uq_expense_trip_id').on(t.trip_id, t.id),            // composite FK 타깃(§2.2)
  foreignKey({ columns: [t.trip_id, t.paid_by_member_id],          foreignColumns: [tripMembers.trip_id, tripMembers.id] }),
  foreignKey({ columns: [t.trip_id, t.created_by_member_id],       foreignColumns: [tripMembers.trip_id, tripMembers.id] }),
  foreignKey({ columns: [t.trip_id, t.last_modified_by_member_id], foreignColumns: [tripMembers.trip_id, tripMembers.id] }),
  foreignKey({ columns: [t.trip_id, t.settlement_currency],        foreignColumns: [trips.id, trips.settlement_currency] }),  // trip 단일 정산통화(§2.2)
  foreignKey({ columns: [t.trip_id, t.refund_of_expense_id],       foreignColumns: [expenses.trip_id, expenses.id] }),  // 환불 same-trip(§2.2)
  check('refund_self', sql`${t.refund_of_expense_id} IS NULL OR ${t.refund_of_expense_id} <> ${t.id}`),  // 자기참조 금지
  index('ix_exp_refund').on(t.refund_of_expense_id),
])

// 참여자 = 조인 테이블(관계만, 부담액 미저장 — 엔진이 재계산)
export const expenseParticipants = pgTable('expense_participants', {
  trip_id:    uuid().notNull(),                                     // same-trip composite FK(§2.2)
  expense_id: uuid().notNull(),
  member_id:  uuid().notNull(),
  // weight: integer().notNull().default(1),   // §47.2 가중분담 확장 슬롯(미사용)
}, (t) => [
  primaryKey({ columns: [t.expense_id, t.member_id] }),             // 중복 참여자 방지 + 자연 PK
  foreignKey({ columns: [t.trip_id, t.expense_id], foreignColumns: [expenses.trip_id, expenses.id] }).onDelete('cascade'),
  foreignKey({ columns: [t.trip_id, t.member_id],  foreignColumns: [tripMembers.trip_id, tripMembers.id] }),
  index('ix_part_member').on(t.member_id),                          // "내가 참여한 지출"(§32.7)
])
```
- `fx_by_source` 교차 CHECK: converted면 `exchange_rate`·`exchange_rate_source` 필수, card_billed면 source null(FX 미적용). exchange_rate는 numeric(20,10) authoritative(편집 재계산 정확, FX §4.3).
- **참여자≥1**은 테이블만으로 강제 불가 → 서비스 트랜잭션에서 ≥1 insert 보장(+선택: deferred constraint trigger).
- **참여자 동시성(리뷰 #2):** `expense_participants` 변경은 항상 **부모 `expenses.version`을 bump하는 경로**로만 수행(서비스 강제 + 트리거). finalize가 `expenses`를 `FOR UPDATE`한 뒤 같은 tx에서 참여자를 읽으므로, version 재검증이 참여자 집합 변경까지 포착한다.
- 멤버 필터: `paid_by_member_id=$m OR EXISTS(SELECT 1 FROM expense_participants WHERE expense_id=e.id AND member_id=$m)`.

## 7. 도메인 3 — 정산 스냅샷

```ts
export const settlements = pgTable('settlements', {
  id: pk(),
  trip_id: uuid().notNull().references(() => trips.id, { onDelete: 'cascade' }),
  version: integer().notNull(),                                     // 1,2,3… 재확정마다 +1
  status: snapshotStatusEnum().notNull().default('active'),         // active | superseded
  finalized_by_member_id: uuid().notNull().references(() => tripMembers.id),
  finalized_at: timestamp({ withTimezone: true }).notNull(),
  total_settlement_amount: bigint({ mode: 'bigint' }).notNull(),   // 현지통화별 합계는 settlement_currency_totals
  ...timestamps,
}, (t) => [
  uniqueIndex('uq_settlement_active').on(t.trip_id).where(sql`status='active'`),  // trip당 active ≤1
  uniqueIndex('uq_settlement_version').on(t.trip_id, t.version),
  uniqueIndex('uq_settlement_trip_id').on(t.trip_id, t.id),         // 자식 composite FK 타깃(§2.2)
  foreignKey({ columns: [t.trip_id, t.finalized_by_member_id], foreignColumns: [tripMembers.trip_id, tripMembers.id] }),  // §2.2
  index('ix_settlement_finalizer').on(t.finalized_by_member_id),
])

// 현지통화별 총지출(정규화 — 리뷰 #4: JSONB 대체. FK 통화 + bigint 정수)
export const settlementCurrencyTotals = pgTable('settlement_currency_totals', {
  settlement_id: uuid().notNull().references(() => settlements.id, { onDelete: 'cascade' }),
  currency: text().notNull().references(() => currencies.code),
  total_amount: bigint({ mode: 'bigint' }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.settlement_id, t.currency] }),          // 스냅샷×통화 1행
])

export const settlementTransfers = pgTable('settlement_transfers', {
  id: pk(),
  settlement_id: uuid().notNull(),                                // composite FK (trip_id, settlement_id) → settlements (§2.2)
  trip_id: uuid().notNull(),                                       // same-trip composite FK(§2.2)
  basis: basisEnum().notNull(),                                    // settlement | local
  currency: text().notNull().references(() => currencies.code),
  from_member_id: uuid().notNull(),
  to_member_id:   uuid().notNull(),
  amount: bigint({ mode: 'bigint' }).notNull(),
  payment_status: paymentStatusEnum().notNull().default('pending'),
  paid_at: timestamp({ withTimezone: true }),
  marked_by_member_id: uuid(),
  ...timestamps,
}, (t) => [
  check('transfer_amount_pos', sql`${t.amount} > 0`),
  check('transfer_distinct',   sql`${t.from_member_id} <> ${t.to_member_id}`),
  // paid=둘 다 NOT NULL / pending=둘 다 NULL (half-state 차단, pass2 #4)
  check('paid_consistency', sql`(payment_status='paid' AND paid_at IS NOT NULL AND marked_by_member_id IS NOT NULL) OR (payment_status='pending' AND paid_at IS NULL AND marked_by_member_id IS NULL)`),
  check('local_not_tracked', sql`${t.basis}='settlement' OR payment_status='pending'`),   // local basis는 추적 안 함(§18.6)
  uniqueIndex('uq_transfer_pair').on(t.settlement_id, t.basis, t.currency, t.from_member_id, t.to_member_id),
  foreignKey({ columns: [t.trip_id, t.settlement_id], foreignColumns: [settlements.trip_id, settlements.id] }).onDelete('cascade'),  // 자식 trip=settlement trip
  foreignKey({ columns: [t.trip_id, t.from_member_id],   foreignColumns: [tripMembers.trip_id, tripMembers.id] }),  // §2.2
  foreignKey({ columns: [t.trip_id, t.to_member_id],     foreignColumns: [tripMembers.trip_id, tripMembers.id] }),
  foreignKey({ columns: [t.trip_id, t.marked_by_member_id], foreignColumns: [tripMembers.trip_id, tripMembers.id] }),
  index('ix_transfer_settlement').on(t.settlement_id),
  index('ix_transfer_from').on(t.from_member_id),
  index('ix_transfer_to').on(t.to_member_id),
])

export const settlementMemberSummaries = pgTable('settlement_member_summaries', {
  id: pk(),
  settlement_id: uuid().notNull(),                                // composite FK (trip_id, settlement_id) → settlements (§2.2)
  trip_id: uuid().notNull(),                                       // same-trip composite FK(§2.2)
  member_id: uuid().notNull(),
  basis: basisEnum().notNull(),
  currency: text().notNull().references(() => currencies.code),
  total_paid:  bigint({ mode: 'bigint' }).notNull(),
  total_share: bigint({ mode: 'bigint' }).notNull(),
  net_amount:  bigint({ mode: 'bigint' }).notNull(),               // total_paid − total_share
  ...timestamps,
}, (t) => [
  uniqueIndex('uq_summary').on(t.settlement_id, t.member_id, t.basis, t.currency),
  foreignKey({ columns: [t.trip_id, t.settlement_id], foreignColumns: [settlements.trip_id, settlements.id] }).onDelete('cascade'),  // 자식 trip=settlement trip
  foreignKey({ columns: [t.trip_id, t.member_id], foreignColumns: [tripMembers.trip_id, tripMembers.id] }),  // §2.2
  index('ix_summary_settlement').on(t.settlement_id),
  index('ix_summary_member').on(t.member_id),
])
```
- 완료 추적(`payment_status`)은 `basis='settlement'` 행에만 적용(실제 송금 기준, §18.6). `basis='local'`은 참고용 저장.
- `Σ net_amount == 0`(basis·통화별)은 cross-row라 DB CHECK 불가 → 엔진이 보장(`SettlementInvariantError`).

### 7.1 lifecycle 트랜잭션 (architecture §4.6)
**재확정(open→finalized)** 단일 tx:
1. **trip row 원자 CAS-lock(리뷰 #3):** `UPDATE trips SET settlement_status='finalized', finalized_at=now() WHERE id=$t AND settlement_status='open' RETURNING` → 0행이면 즉시 중단(이미 finalized/경합). 이 UPDATE의 row write-lock이 commit까지 유지되어 **trip 단위 직렬화**. (finalizer는 settlement 스냅샷의 `finalized_by_member_id`에만 저장 — pass2 #5)
2. 포함 expenses `FOR UPDATE` + **참여자 행 read**(같은 tx, 리뷰 #2) + 확정 화면이 읽은 version 재검증 → 불일치 시 `ConflictError` 중단
3. computeSettlement (settlement + local basis 각각)
4. 직전 active settlement UPDATE → superseded **(성공 시에만)**
5. 새 settlement INSERT(`version` = 같은 lock 하에서 계산한 prev+1, active) + transfers + summaries + currency_totals

**잠금 해제(finalized→open):** `trip.settlement_status='open'`만. settlements는 **건드리지 않음**(active 유지 = 재확정 diff 기준).
- 1의 row lock으로 동시 finalize는 직렬화 → 정상 경로에서 4→5의 active 충돌 없음. 잔여 `uq_settlement_active`/`uq_settlement_version` 위반은 backstop으로 `ConflictError` 매핑.
- 재확정 시 새 transfers는 pending 시작(§31.7), 직전 paid는 superseded에 동결.

### 7.2 지출/참여자 write 동시성 (리뷰 pass3 #1)
expense·expense_participants의 insert/update/delete는 finalize와 **같은 trip row lock을 같은 tx에서 먼저 획득**한 뒤 `open`을 확인·변경한다:
```sql
SELECT settlement_status FROM trips WHERE id=$t FOR UPDATE;   -- finalize와 공유하는 직렬화 지점
-- != 'open' 이면 ConflictError (이미 확정됨)
```
- finalize의 CAS-`UPDATE`와 write path의 `SELECT … FOR UPDATE`가 **동일 trip row**를 두고 경합 → READ COMMITTED MVCC가 미커밋 finalize를 못 보고 snapshot 밖 insert하는 race를 차단(고정 lock 순서: trip row 먼저).
- 대안: per-trip advisory lock 또는 SERIALIZABLE + 직렬화 실패→`ConflictError`.

### 7.3 송금 완료 표시 동시성 (리뷰 pass4 #1)
`settlement_transfers.payment_status` 갱신은 **`settlements.status='active' AND trips.settlement_status='finalized'`를 검증한 tx**에서만 수행하고, 재확정과 **같은 trip row lock**으로 직렬화한다. 스냅샷이 superseded이거나 trip이 open이면 `ConflictError`. (§31.7: 송금 추적은 현재 active 확정 스냅샷에 대해서만 동작 — obsolete 스냅샷에 결제 기록되는 모순 차단.)
- **actor 경계(pass5 #1, 앱-레이어 authz):** `marked_by_member_id`는 인증된 멤버십에서 도출하고, 같은 잠긴 tx에서 **`actor.member_id = to_member_id` 또는 `actor.role='admin'`(active·joined)** 일 때만 갱신을 허용한다. 아니면 `ForbiddenError`. DB는 요청 actor를 모르므로 이 규칙은 **service guard**가 강제한다(architecture §4.4 · PRD §31.7).

## 8. 도메인 4 — 감사 로그

```ts
export const expenseAuditLogs = pgTable('expense_audit_logs', {
  id: pk(),
  trip_id:    uuid().notNull().references(() => trips.id, { onDelete: 'cascade' }),
  expense_id: uuid().notNull(),     // composite FK (trip_id, expense_id) → expenses (§2.2)
  changed_by_member_id: uuid().notNull(),
  change_type: text().notNull(),    // CHECK IN ('create','update','delete','restore')
  before_value: jsonb(),            // create면 null
  after_value:  jsonb(),            // delete면 null
  created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),  // append-only(updated_at 없음)
}, (t) => [
  foreignKey({ columns: [t.trip_id, t.expense_id],           foreignColumns: [expenses.trip_id, expenses.id] }).onDelete('cascade'),  // §2.2
  foreignKey({ columns: [t.trip_id, t.changed_by_member_id], foreignColumns: [tripMembers.trip_id, tripMembers.id] }),
  index('ix_audit_expense').on(t.expense_id, t.created_at.desc()),
  index('ix_audit_trip').on(t.trip_id),
])
```
- append-only(insert만). before/after는 JSONB 행 스냅샷. MVP는 last_modified만 노출(§30.2), 상세 이력은 확장.

## 9. 결정 완료 (적대적 리뷰 반영)
- 현지통화별 총지출: **정규화 `settlement_currency_totals` 채택**(JSONB 기각 — 리뷰 #4). FK 통화·bigint 정수 일관성 확보(2^53 정밀도 위험은 이 규모선 무실이나 스키마 일관성이 우위).

## 10. 불변식 강제 위치 요약
| 불변식 | 강제 |
|---|---|
| 어드민 ≤1 active | `uq_one_admin` 부분 유니크 |
| active 스냅샷 ≤1 | `uq_settlement_active` 부분 유니크 |
| 중복 참여자 방지 | `expense_participants` 복합 PK |
| 중복 초대 방지 | `uq_member_email` |
| 초대 토큰 1:1 | `uq_invite_token` 부분 unique — 한 해시=1 pending (auth) |
| Google 계정 1:1 | Better Auth `account` `unique(provider_id, account_id)` — 이메일 링킹 금지 (auth) |
| converted 환율·source 필수 / card_billed source null | `fx_by_source` CHECK |
| 송금액>0·자기송금 금지·paid 일관성 | transfer CHECK 3종 |
| 참여자≥1 | 서비스 tx(+선택 trigger) |
| same-trip 멤버/지출 참조 | composite FK `(trip_id, *)→trip_members/expenses(trip_id, id)` (§2.2) |
| 참여자 변경 동시성 | parent `expenses.version` bump(트리거) + finalize 시 같은 tx read (리뷰 #2) |
| Σ부담액==지출액 / Σ순정산==0 | 정산 엔진(순수함수) + `SettlementInvariantError` |
| 동시 확정 충돌 | trip row 원자 CAS-lock + expenses version + FOR UPDATE (리뷰 #3) |
| 지출 write vs 확정 race | write path도 trip row `FOR UPDATE` 후 open 확인(공유 직렬화 §7.2, pass3 #1) |
| 송금 표시 vs 잠금해제/재확정 | payment 갱신은 `active`+`finalized` 검증 + trip lock 직렬화(§7.3, pass4 #1) |
| 환불 same-trip | `(trip_id, refund_of_expense_id)→expenses(trip_id,id)` + self 가드(pass3 #2) |

## 11. doc 반영 예정 (확정 후)
- PRD: `trips.timezone` 추가(§6.1·§11.2), §14.2 "현지 TZ 기준 일자" 명문화, expenses에 `deleted_at`·참여자 조인 반영
- architecture `enums.ts`: `input_source` enum→text+CHECK 이동, `snapshot_status`(active/superseded) 추가, `currencies`·`expense_participants`·`settlement_currency_totals` 테이블 추가
- architecture §4.3/§4.6: same-trip composite FK 규약(§2.2), 참여자 변경 시 `expenses.version` bump 트리거, finalize의 trip row CAS-lock 명세

## 12. 적대적 리뷰 디스포지션 (Codex, 5 passes)

`hardened-planning` 스킬로 실제 Codex 적대적 리뷰를 5회 실행. **총 14건 finding 전부 Accept·반영.** high 추세 4→5→3→1→1로 **DB-스키마 무결성 수렴**, 마지막 1건은 앱-레이어 인가(architecture §4.4 owner)로 cross-ref 처리. 최종 verdict는 `needs-attention`(잔여=app-authz)이며, 사용자가 open item을 본 뒤 확정 결정.

| pass | # | finding | sev | 결정 | 반영 |
|---|---|---|---|---|---|
| 1 | 1 | 멤버 참조가 지출 trip에 안 묶임 | high | Accept | §2.2 same-trip composite FK |
| 1 | 2 | finalize가 참여자 집합 미직렬화 | high | Accept | 참여자 변경 시 version bump + 잠금 read |
| 1 | 3 | active 스냅샷 CAS 미명세 | high | Accept | trip row 원자 CAS-lock(§7.1) |
| 1 | 4 | JSONB 통화 합계가 불변식 우회 | med | Accept | 정규화 `settlement_currency_totals` |
| 2 | 5 | settlement child가 settlement trip에 안 묶임 | high | Accept | `(trip_id,settlement_id)→settlements` + UNIQUE |
| 2 | 6 | audit log same-trip 우회 | high | Accept | audit composite FK |
| 2 | 7 | expense.settlement_currency drift | high | Accept | `(trip_id,settlement_currency)→trips` |
| 2 | 8 | paid_consistency half-state 허용 | med | Accept | 명시 상태 CHECK + local_not_tracked |
| 2 | 9 | CAS가 trips에 없는 finalized_by 기록 | med | Accept | CAS에서 finalized_by 제거 |
| 3 | 10 | CAS-lock이 expense writer 미직렬화 | high | Accept | writer-side trip `FOR UPDATE`(§7.2) |
| 3 | 11 | refund self-FK cross-trip | high | Accept | refund composite FK + self 가드 |
| 3 | 12 | settlement_currency 변경 vs 즉시검사 FK | high | Accept | expense 존재 시 변경 금지 정책 |
| 4 | 13 | 송금표시가 잠금해제/재확정과 미직렬화 | high | Accept | active+finalized 검증 + trip lock(§7.3) |
| 5 | 14 | 송금표시 actor 미제한 | high | Accept | actor 경계 cross-ref(§7.3, app-authz) |

최종 pass5 `summary`: "lifecycle race covered, but payment completion lacks the PRD actor boundary" → §7.3 actor 경계로 해소.

## 13. 다음 단계 (handoff)

- 이 문서는 **적대적 리뷰로 hardening된 DB 설계**다. 구현 전 다음을 수행:
  1. **doc 반영(§11):** PRD/architecture에 timezone·deleted_at·참여자 조인·정산통화 정책·composite FK 규약·lock 명세·payment actor guard 반영.
  2. **구현:** 이 스키마를 Drizzle로 작성 + drizzle-kit 마이그레이션(composite FK 타깃 UNIQUE 먼저). 정산 동시성(§7.1~7.3)·불변식(§10)은 통합 테스트로 검증.
- 본 hardening은 기존 대화형 설계를 **Codex 적대적 리뷰로 검증**하는 데 집중했으며, 전체 hardened-planning 의례(brainstorming/worktree/executing-plans)는 이 맥락에 맞게 생략했다.
