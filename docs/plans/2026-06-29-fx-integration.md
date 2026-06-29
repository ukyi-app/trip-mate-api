# FX 통합 슬라이스 구현 계획 (expenses CRUD + resolveFx 스냅샷 + Idempotency-Key)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 지출(expense) CRUD 라우트를 `/v1`에 추가하고, 생성 시 `resolveFx`로 정산통화 환산 스냅샷을 영속화하며, Idempotency-Key 미들웨어로 중복 저장을 차단한다.

**Architecture:** functional core / imperative shell, port+adapter(DIP), 수동 DI. api-routes 슬라이스의 buildV1App·guards·OpenAPI·errors 스택을 그대로 재사용하고, fx-pipeline의 `resolveFx`와 db 슬라이스의 expenses 스키마(FX 컬럼·`fx_by_source` CHECK·`version`·`expense_audit_logs` 기존재)를 expenses 모듈로 통합한다.

**Tech Stack:** Bun · Hono + @hono/zod-openapi(1.4, Zod v4) · Drizzle ORM · ioredis(Valkey) · decimal.js · vitest + testcontainers(PG16 + redis:7)

**설계 근거:** `docs/plans/2026-06-29-fx-integration-design.md`

**전제 사실(검증됨):**
- `resolveFx(input: FxInput, deps): Promise<FxResult>` — `src/modules/fx/fx.service.ts:86`. `deps={providers: FxProvider[], cache: CachePort, tripDefaults: TripDefaultsPort, maxAgeDays?, now?, onWarn?}`. `FxResult = FxResolved | {needsManual:true}`, 가드 `isResolved(r)` — `fx.types.ts:54-55`.
- `FxInput{localMinor:Minor(bigint), localCurrency, settlementCurrency, date:'YYYY-MM-DD', localExp, settleExp, tripId, manualRate?}` — `fx.types.ts:33`.
- expenses 컬럼: `paid_by_member_id`·`created_by_member_id`는 **member_id**(trip_members.id). `exchange_rate_date` NOT NULL. `settlement_amount_source` NOT NULL('converted'|'card_billed'). `fx_by_source` CHECK: converted면 exchange_rate·source NOT NULL — `src/db/schema/expenses.ts:24-111`.
- `expense_participants(trip_id, expense_id, member_id)` PK(expense_id, member_id) — 부담액 미저장(엔진 재계산). `expense_audit_logs(change_type create|update|delete|restore, before/after jsonb)`.
- `currencies(code, iso_exponent, minor_unit, symbol)` — `minor_unit`이 exponent. `src/db/schema/currencies.ts`.
- 어댑터 생성자: `RedisCache(redis)`·`DrizzleTripDefaults(db)`·`OxrProvider(appId)`·`CurrencyApiProvider(apiKey)`. `core/config.ts`에 FX provider env **없음**(추가 필요).
- guards `Membership{role,status}` — member_id 미노출(`id` 추가 필요). `requireTripMember`가 `c.set("membership", m)`(m은 MemberRow, id 보유).
- api-routes 패턴: `createApp().basePath("/v1")`·제네릭 `jsonBody`/`ok` 헬퍼·`createRoute({middleware:[...]})`·`c.req.valid`·`errorResponses`·`registerErrorFilter`(problem+json)·`asValidation`(DrizzleQueryError.cause.code → 23503/23514 → 422).

**strict-TS 주의(메모리 [[trip-mate-api-strict-ts-gotchas]]·[[trip-mate-api-zod-openapi-gotchas]]):** `res.json()` 캐스트·exactOptional 조건부 spread·`valid()` 제네릭 헬퍼 추론·zod-openapi 응답 enum 검증(도메인 행 타입을 enum 유니온으로)·`noUncheckedIndexedAccess` `rows[0]!`·DrizzleQueryError는 `.cause.code`.

> **공통 커밋 규칙:** 새 .ts 작성 후 `bun run fmt && bun run check`. **`&&` 체인**(check 실패 시 commit 차단). 한국어 메시지·AI 마커 금지·`<type>(<scope>): 설명`.

---

## Task 0: Idempotency 미들웨어 · FxUnresolvedError · Membership.id

**Files:**
- Create: `src/core/idempotency.ts`
- Create: `src/core/idempotency.test.ts`
- Modify: `src/core/errors.ts`(FxUnresolvedError 추가)
- Modify: `src/core/guards.ts`(Membership에 `id` 추가)

**Step 1: FxUnresolvedError 추가** (`src/core/errors.ts`, ValidationError 옆)

```ts
/** resolveFx가 needsManual(모든 fallback 실패) → 클라가 manualRate 첨부 재요청. 422. */
export class FxUnresolvedError extends AppError {
  constructor(message?: string, meta?: unknown) {
    super("FxUnresolvedError", 422, message, meta);
  }
}
```

**Step 2: Membership에 member_id 노출** (`src/core/guards.ts`)

```ts
export interface Membership {
  id: string; // = trip_members.id (member_id) — expense paid_by/created_by에 필요
  role: string;
  status: string;
}
```
> `requireTripMember`는 이미 `c.set("membership", m)`(MemberRow, id 보유) → 타입만 확장. `findMembership` 반환(MemberRow)도 id 포함 → 런타임 변경 없음. `MembershipLookup` 반환이 Membership에 할당 가능한지 check로 확인(MemberRow는 id·role·status 포함 → OK).

**Step 3: 실패 테스트** (`src/core/idempotency.test.ts`) — redis 테스트컨테이너(redis:7) 사용

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import IoRedis, { type Redis } from "ioredis";
import { Hono } from "hono";
import { idempotency } from "./idempotency.ts";
import { registerErrorFilter, ValidationError } from "./errors.ts";

let container: StartedTestContainer;
let redis: Redis;
beforeAll(async () => {
  container = await new GenericContainer("redis:7").withExposedPorts(6379).start();
  redis = new IoRedis(container.getMappedPort(6379), container.getHost());
}, 60_000);
afterAll(async () => {
  redis.disconnect();
  await container.stop();
});

// user를 강제로 셋하는 테스트용 앱. /x·/y는 경로 격리(=교차-trip 프록시), /boom은 throw(lock 해제 검증)
function app(userId = "u1") {
  const a = new Hono();
  registerErrorFilter(a);
  a.use("*", async (c, next) => {
    c.set("user", { id: userId });
    await next();
  });
  a.use("/x", idempotency({ redis }));
  a.use("/y", idempotency({ redis }));
  a.use("/boom", idempotency({ redis }));
  let calls = 0;
  a.post("/x", (c) => {
    calls++;
    return c.json({ ok: true, calls }, 201);
  });
  a.post("/y", (c) => c.json({ from: "y" }, 201));
  a.post("/boom", () => {
    throw new ValidationError("nope");
  });
  return a;
}
const post = (a: ReturnType<typeof app>, path: string, key: string | null, body: unknown) =>
  a.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    body: JSON.stringify(body),
  });

describe("idempotency 미들웨어", () => {
  it("헤더 없으면 매번 통과", async () => {
    const a = app();
    expect((await post(a, "/x", null, { n: 1 })).status).toBe(201);
    expect((await post(a, "/x", null, { n: 1 })).status).toBe(201);
  });
  it("같은 키·같은 body → 저장된 동일 응답(핸들러 1회)", async () => {
    const a = app("u-replay");
    const r1 = (await (await post(a, "/x", "k1", { n: 1 })).json()) as { calls: number };
    const r2 = (await (await post(a, "/x", "k1", { n: 1 })).json()) as { calls: number };
    expect(r2.calls).toBe(r1.calls); // 핸들러 재실행 안 됨
  });
  it("같은 키·다른 body → 409", async () => {
    const a = app("u-conflict");
    expect((await post(a, "/x", "k2", { n: 1 })).status).toBe(201);
    expect((await post(a, "/x", "k2", { n: 2 })).status).toBe(409);
  });
  it("다른 user 같은 키 → 격리(각자 처리)", async () => {
    expect((await post(app("uA"), "/x", "shared", { n: 1 })).status).toBe(201);
    expect((await post(app("uB"), "/x", "shared", { n: 1 })).status).toBe(201);
  });
  it("다른 경로 같은 키 → 격리(교차-trip 프록시, finding #4 pass1)", async () => {
    const a = app("u-path");
    expect((await post(a, "/x", "samekey", { n: 1 })).status).toBe(201);
    expect((await post(a, "/y", "samekey", { n: 1 })).status).toBe(201); // 다른 경로 → 독립
  });
  it("핸들러 throw(422) → lock 해제, 같은 키 재시도 가능(finding #1 pass1)", async () => {
    const a = app("u-boom");
    expect((await post(a, "/boom", "bk", { n: 1 })).status).toBe(422);
    // lock이 안 풀렸다면 두 번째는 409 in-progress가 됨 → 풀렸으면 다시 422(핸들러 재실행)
    expect((await post(a, "/boom", "bk", { n: 1 })).status).toBe(422);
  });
});
```

**Step 4: 실패 확인** — `bun run test src/core/idempotency.test.ts` → FAIL(모듈 없음).

**Step 5: 구현** (`src/core/idempotency.ts`)

```ts
import { createHash } from "node:crypto";
import type { Context, Next } from "hono";
import type { Redis } from "ioredis";
import { ConflictError } from "./errors.ts";

export interface IdempotencyStore {
  redis: Redis;
  ttlSeconds?: number;
}
interface IdemRecord {
  lock?: true;
  request_hash: string;
  status?: number;
  body?: string;
}
const hashBody = (raw: string) => createHash("sha256").update(raw).digest("hex");

/** §5 멱등. scope=(principal + 실 요청 경로 + client key). requireAuth 뒤 적용. 헤더 없으면 no-op.
 *  SET NX lock → next() → 2xx면 결과 저장, throw/non-2xx면 lock 삭제(재시도 허용). */
export function idempotency(store: IdempotencyStore) {
  const ttl = store.ttlSeconds ?? 86_400;
  return async (c: Context, next: Next) => {
    const clientKey = c.req.header("idempotency-key");
    if (!clientKey) return next();
    const user = c.get("user");
    const raw = await c.req.raw.clone().text(); // clone → 핸들러의 valid("json") 보존
    const reqHash = hashBody(raw);
    // c.req.path = 실 tripId 포함(/v1/trips/<uuid>/expenses) → 교차-trip 격리(finding #4 pass1)
    const key = `idempotency:${user.id}:${c.req.path}:${clientKey}`;

    const existing = await store.redis.get(key);
    if (existing) {
      const rec = JSON.parse(existing) as IdemRecord;
      if (rec.lock) throw new ConflictError("idempotent request in progress", { key });
      if (rec.request_hash !== reqHash)
        throw new ConflictError("idempotency key reused with different body", { key });
      return c.json(JSON.parse(rec.body ?? "null"), (rec.status ?? 200) as 200); // replay
    }
    // SET NX EX — lock 선점(동시 같은 키 single-flight)
    const locked = await store.redis.set(key, JSON.stringify({ lock: true, request_hash: reqHash }), "EX", ttl, "NX");
    if (locked !== "OK") throw new ConflictError("idempotent request in progress", { key });

    // 에러 경로에서도 lock 반드시 해제(finding #1 pass1) — 미해제 시 24h 동안 재시도 차단.
    try {
      await next();
    } catch (e) {
      await store.redis.del(key); // throw(FxUnresolved·DB·검증) → lock 해제, 원에러 보존
      throw e;
    }
    if (c.res.status >= 200 && c.res.status < 300) {
      const body = await c.res.clone().text();
      await store.redis.set(key, JSON.stringify({ request_hash: reqHash, status: c.res.status, body }), "EX", ttl);
    } else {
      await store.redis.del(key); // non-2xx(onError 변환 등) → 재시도 허용
    }
  };
}
```
> ⚠️ ioredis `set(key, val, "EX", ttl, "NX")` 시그니처·반환("OK"|null)·`c.res.clone().text()`·`c.req.raw.clone()` 구현 시 확인.
> **durability(finding #1 pass2):** 핸들러 tx commit 후 Redis 결과쓰기 사이에 부분실패가 나도 **lock 레코드가 잔존**(성공경로는 lock을 결과로 *덮어쓰기*만 하고 삭제 안 함) → TTL 내 재시도는 `{lock:true}`를 만나 **409 in-progress(중복 생성 없음)**. 즉 중복방지는 TTL 윈도 내 보장. 잔여: ① 2xx commit + Redis 결과쓰기 실패 시 클라가 저장응답 대신 409를 받음(재시도하면 됨), ② TTL(24h) 경과 후 재시도는 새 처리(TTL-기반 멱등의 표준 — Stripe 동일). **완전 cross-failure durable**(idempotency_keys DB 테이블을 지출 tx에 동봉·저장응답 재생)은 후속 하드닝 forward-ref.

**Step 6: green** — `bun run test src/core/idempotency.test.ts` → PASS.

**Step 7: Commit**
```bash
bun run fmt && bun run check
git add src/core/idempotency.ts src/core/idempotency.test.ts src/core/errors.ts src/core/guards.ts
git commit -m "feat(core): Idempotency-Key 미들웨어(SET NX single-flight·replay·409)·FxUnresolvedError·Membership member_id"
```

---

## Task 1: expenses DTO 스키마

**Files:**
- Create: `src/modules/expenses/expenses.schema.ts`
- Create: `src/modules/expenses/expenses.schema.test.ts`

**Step 1: 실패 테스트**

```ts
import { describe, it, expect } from "vitest";
import { expenseResponseSchema, createExpenseSchema, updateExpenseSchema } from "./expenses.schema.ts";

const validCreate = () => ({
  title: "스시",
  local_amount: "37900",
  local_currency: "JPY",
  spent_at: "2026-08-02T12:30:00.000Z",
  paid_by_member_id: "11111111-1111-4111-8111-111111111111",
  participant_member_ids: ["11111111-1111-4111-8111-111111111111"],
  payment_method: "card",
  category: "food",
});

describe("expenses DTO", () => {
  it("응답에 version 포함·돈은 string", () => {
    expect("version" in expenseResponseSchema.shape).toBe(true);
    expect(expenseResponseSchema.shape.settlement_amount.safeParse("37900").success).toBe(true);
    expect(expenseResponseSchema.shape.settlement_amount.safeParse(37900).success).toBe(false); // number 거부
  });
  it("create 검증: 정상·빈 참여자·음수 금액·미지 payment_method", () => {
    expect(createExpenseSchema.safeParse(validCreate()).success).toBe(true);
    expect(createExpenseSchema.safeParse({ ...validCreate(), participant_member_ids: [] }).success).toBe(false);
    expect(createExpenseSchema.safeParse({ ...validCreate(), local_amount: "-1" }).success).toBe(false);
    expect(createExpenseSchema.safeParse({ ...validCreate(), payment_method: "crypto" }).success).toBe(false);
    const dup = "11111111-1111-4111-8111-111111111111";
    expect(createExpenseSchema.safeParse({ ...validCreate(), participant_member_ids: [dup, dup] }).success).toBe(false); // 중복 participant(finding #3 pass2)
    expect(createExpenseSchema.safeParse({ ...validCreate(), local_amount: "1".repeat(20) }).success).toBe(false); // 길이 초과(finding #2 pass3)
    expect(createExpenseSchema.safeParse({ ...validCreate(), local_amount: "9999999999999999999" }).success).toBe(false); // BIGINT 범위 초과
  });
  it("update는 version 필수·메타만(amount/currency 없음, FX 불변)", () => {
    expect(updateExpenseSchema.safeParse({ version: 0, title: "수정" }).success).toBe(true);
    expect(updateExpenseSchema.safeParse({ title: "수정" }).success).toBe(false); // version 누락
    expect("local_amount" in updateExpenseSchema.shape).toBe(false);
    expect("local_currency" in updateExpenseSchema.shape).toBe(false);
  });
});
```

**Step 2: 실패 확인** → FAIL.

**Step 3: 구현** (`src/modules/expenses/expenses.schema.ts`)

```ts
import { z } from "@hono/zod-openapi";

// 최소단위 string(D1). 음수 없음(환불=후속). max 19자 + BIGINT 범위 refine(finding #2 pass3 — 무한 길이/오버플로 차단).
const BIGINT_MAX = 9223372036854775807n;
const minorString = z
  .string()
  .regex(/^\d+$/)
  .max(19)
  .refine((s) => BigInt(s) <= BIGINT_MAX, { message: "amount out of BIGINT range" });
const STATE = ["included", "personal", "record_only"] as const;
const PAYMENT = ["cash", "card", "transit_card", "easy_pay", "other"] as const;
const CATEGORY = ["food", "cafe_snack", "transport", "lodging", "shopping", "sightseeing", "convenience", "other"] as const;

export const expenseResponseSchema = z
  .object({
    id: z.string().uuid(),
    trip_id: z.string().uuid(),
    title: z.string(),
    local_amount: minorString,
    local_currency: z.string(),
    settlement_amount: minorString,
    settlement_currency: z.string(),
    exchange_rate: z.string().nullable(),
    exchange_rate_source: z.enum(["identity", "manual", "auto", "last_known", "trip_default"]).nullable(),
    settlement_amount_source: z.enum(["converted", "card_billed"]),
    payment_method: z.string(),
    category: z.string(),
    paid_by_member_id: z.string().uuid(),
    participant_member_ids: z.array(z.string().uuid()),
    spent_at: z.string(),
    expense_settlement_state: z.enum(STATE),
    memo: z.string().nullable(),
    version: z.number().int(),
  })
  .openapi("Expense");

export const createExpenseSchema = z
  .object({
    title: z.string().min(1).max(200),
    local_amount: minorString,
    local_currency: z.string().length(3),
    spent_at: z.string().datetime(), // ISO timestamp
    paid_by_member_id: z.string().uuid(),
    participant_member_ids: z.array(z.string().uuid()).min(1).refine((a) => new Set(a).size === a.length, { message: "duplicate participant" }), // PK(expense_id,member_id) 23505 선차단(finding #3 pass2)
    payment_method: z.enum(PAYMENT),
    category: z.enum(CATEGORY),
    memo: z.string().max(1000).optional(),
    manualRate: z.string().regex(/^\d+(\.\d+)?$/).max(24).optional(), // major→major, 길이 경계(finding #2 pass3)
    expense_settlement_state: z.enum(STATE).optional(),
  })
  .openapi("CreateExpense");

// 메타+참여자만(FX 불변, 편집재계산=후속). version 필수 CAS echo.
export const updateExpenseSchema = z
  .object({
    version: z.number().int(),
    title: z.string().min(1).max(200).optional(),
    payment_method: z.enum(PAYMENT).optional(),
    category: z.enum(CATEGORY).optional(),
    memo: z.string().max(1000).nullable().optional(),
    participant_member_ids: z.array(z.string().uuid()).min(1).refine((a) => new Set(a).size === a.length, { message: "duplicate participant" }).optional(), // finding #3 pass2
    expense_settlement_state: z.enum(STATE).optional(),
  })
  .openapi("UpdateExpense");

export type ExpenseResponse = z.infer<typeof expenseResponseSchema>;
export type CreateExpense = z.infer<typeof createExpenseSchema>;
export type UpdateExpense = z.infer<typeof updateExpenseSchema>;
```

**Step 4: green** → PASS.

**Step 5: Commit**
```bash
bun run fmt && bun run check
git add src/modules/expenses/expenses.schema.ts src/modules/expenses/expenses.schema.test.ts
git commit -m "feat(expenses): 지출 DTO 스키마(응답 version·돈 string·create·update 메타만)"
```

---

## Task 2: expenses repo (tx·CAS·참여자·audit)

**Files:**
- Create: `src/modules/expenses/expenses.repo.ts`
- Create: `src/modules/expenses/expenses.repo.test.ts`

**참여자 조립:** 응답 DTO의 `participant_member_ids`는 별도 쿼리(`WHERE expense_id IN (...)`)로 묶어 JS에서 그룹핑. `findById`는 expense 1행 + 참여자 배열, `listForTrip`은 N개 + 참여자 일괄.

**Step 1: 실패 테스트** (PG, 기존 `tests/db/helpers.ts`의 startDb·mkUser·mkTrip + member 생성)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, mkTrip, type Ctx } from "../../../tests/db/helpers.ts";
import { DrizzleMemberRepo } from "../members/members.repo.ts";
import { DrizzleExpenseRepo } from "./expenses.repo.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

// trip + 어드민 멤버십(member_id 확보) helper
async function setup() {
  const u = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, u); // mkTrip의 통화/timezone 확인 — 정산통화 KRW 가정
  await ctx.sql`update trips set timezone='Asia/Seoul' where id=${trip}`; // snapshot.timezone과 정합(finding #3 pass3)
  const m = await new DrizzleMemberRepo(ctx.db).ensureCreatorMembership({ tripId: trip, userId: u, displayName: "A", email: "a@example.com" });
  return { u, trip, memberId: m.id };
}
const snapshot = (over = {}) => ({
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

describe("DrizzleExpenseRepo", () => {
  it("create(snapshot+참여자+audit) → findById 조립", async () => {
    const { trip, memberId } = await setup();
    const repo = new DrizzleExpenseRepo(ctx.db);
    const exp = await repo.create(
      { ...snapshot(), trip_id: trip, paid_by_member_id: memberId, created_by_member_id: memberId, participant_member_ids: [memberId] },
    );
    expect(exp.version).toBe(0);
    const found = await repo.findById(trip, exp.id);
    expect(found?.settlement_amount).toBe(350000n);
    expect(found?.participant_member_ids).toEqual([memberId]);
  });
  it("updateMeta CAS: version 일치 시 +1, 불일치 0행", async () => {
    const { trip, memberId } = await setup();
    const repo = new DrizzleExpenseRepo(ctx.db);
    const exp = await repo.create({ ...snapshot(), trip_id: trip, paid_by_member_id: memberId, created_by_member_id: memberId, participant_member_ids: [memberId] });
    const ok = await repo.updateMeta(trip, exp.id, 0, { title: "수정" }, memberId);
    expect(ok?.version).toBe(1);
    expect(await repo.updateMeta(trip, exp.id, 0, { title: "stale" }, memberId)).toBeNull(); // 이미 v1
  });
  it("softDelete CAS: deleted_at 셋·이후 findById null", async () => {
    const { trip, memberId } = await setup();
    const repo = new DrizzleExpenseRepo(ctx.db);
    const exp = await repo.create({ ...snapshot(), trip_id: trip, paid_by_member_id: memberId, created_by_member_id: memberId, participant_member_ids: [memberId] });
    expect(await repo.softDelete(trip, exp.id, 0, memberId)).toBe(true);
    expect(await repo.findById(trip, exp.id)).toBeNull();
  });
  it("stale timezone(snapshot.timezone ≠ 현재 trip tz) → create 409(finding #3 pass3)", async () => {
    const { trip, memberId } = await setup();
    const repo = new DrizzleExpenseRepo(ctx.db);
    await expect(
      repo.create({ ...snapshot({ timezone: "Europe/London" }), trip_id: trip, paid_by_member_id: memberId, created_by_member_id: memberId, participant_member_ids: [memberId] }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("audit: update는 before/after 전체 스냅샷 기록(finding #3 pass1)", async () => {
    const { trip, memberId } = await setup();
    const repo = new DrizzleExpenseRepo(ctx.db);
    const exp = await repo.create({ ...snapshot(), trip_id: trip, paid_by_member_id: memberId, created_by_member_id: memberId, participant_member_ids: [memberId] });
    await repo.updateMeta(trip, exp.id, 0, { title: "수정됨" }, memberId);
    const logs = await ctx.sql<{ change_type: string; before_value: { title: string } | null; after_value: { title: string } | null }[]>`
      select change_type, before_value, after_value from expense_audit_logs where expense_id=${exp.id} order by created_at`;
    const upd = logs.find((l) => l.change_type === "update")!;
    expect(upd.before_value?.title).toBe("스시"); // 변경 전 보존
    expect(upd.after_value?.title).toBe("수정됨"); // 변경 후 보존
  });
});
```
> ⚠️ `mkTrip` 헬퍼의 정산통화·timezone 확인(없으면 helper 확장). currencies에 JPY·KRW 시드 존재 확인(`tests/db/helpers` 또는 마이그레이션 시드).

**Step 2: 실패 확인** → FAIL.

**Step 3: 구현** (`src/modules/expenses/expenses.repo.ts`)

```ts
import { and, eq, inArray, isNull, desc, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { expenses, expenseParticipants, expenseAuditLogs } from "../../db/schema/expenses.ts";
import { trips } from "../../db/schema/trips.ts";
import { ConflictError } from "../../core/errors.ts";

export interface ExpenseSnapshot {
  trip_id: string;
  timezone: string; // FX date 파생에 쓴 trip TZ — repo가 lock 하에 재검증(finding #3 pass3, stale tz 차단)
  title: string;
  local_amount: bigint;
  local_currency: string;
  settlement_amount: bigint;
  settlement_currency: string;
  exchange_rate: string;
  exchange_rate_date: string;
  exchange_rate_source: "identity" | "manual" | "auto" | "last_known" | "trip_default";
  exchange_rate_provider: string | null;
  exchange_rate_table_date: string | null;
  exchange_rate_fetched_at: Date | null;
  settlement_amount_source: "converted";
  payment_method: string;
  category: string;
  spent_at: Date;
  expense_settlement_state: "included" | "personal" | "record_only";
  memo: string | null;
  paid_by_member_id: string;
  created_by_member_id: string;
  participant_member_ids: string[];
}
export interface ExpenseRow {
  id: string;
  trip_id: string;
  title: string;
  local_amount: bigint;
  local_currency: string;
  settlement_amount: bigint;
  settlement_currency: string;
  exchange_rate: string | null;
  exchange_rate_source: "identity" | "manual" | "auto" | "last_known" | "trip_default" | null;
  settlement_amount_source: "converted" | "card_billed";
  payment_method: string;
  category: string;
  paid_by_member_id: string;
  spent_at: Date;
  expense_settlement_state: "included" | "personal" | "record_only";
  memo: string | null;
  version: number;
  participant_member_ids: string[];
}
export interface MetaPatch {
  title?: string | undefined;
  payment_method?: string | undefined;
  category?: string | undefined;
  memo?: string | null | undefined;
  expense_settlement_state?: "included" | "personal" | "record_only" | undefined;
  participant_member_ids?: string[] | undefined;
}

const COLS = {
  id: expenses.id,
  trip_id: expenses.trip_id,
  title: expenses.title,
  local_amount: expenses.local_amount,
  local_currency: expenses.local_currency,
  settlement_amount: expenses.settlement_amount,
  settlement_currency: expenses.settlement_currency,
  exchange_rate: expenses.exchange_rate,
  exchange_rate_source: expenses.exchange_rate_source,
  settlement_amount_source: expenses.settlement_amount_source,
  payment_method: expenses.payment_method,
  category: expenses.category,
  paid_by_member_id: expenses.paid_by_member_id,
  spent_at: expenses.spent_at,
  expense_settlement_state: expenses.expense_settlement_state,
  memo: expenses.memo,
  version: expenses.version,
};

// audit jsonb-safe 변환(bigint→string, Date→ISO) — JSON.stringify(bigint) 예외 회피(finding #3 pass1)
type FullRow = { local_amount: bigint; settlement_amount: bigint; spent_at: Date } & Record<string, unknown>;
const jsonSafe = (r: FullRow, parts: string[]): Record<string, unknown> => ({
  ...r,
  local_amount: r.local_amount.toString(),
  settlement_amount: r.settlement_amount.toString(),
  spent_at: r.spent_at.toISOString(),
  participant_member_ids: parts,
});

export class DrizzleExpenseRepo<T extends Record<string, unknown>> {
  constructor(private readonly db: PostgresJsDatabase<T>) {}

  /** 단일 tx: trip-lock(open 검사) + expense insert + participants + audit(create).
   *  trip-row FOR UPDATE로 finalize 경로와 직렬화(finding #2 pass2, TOCTOU 제거).
   *  ⚠️ settlement finalize 슬라이스도 동일 trip-row를 FOR UPDATE로 잠가야 상호 직렬화(forward-ref). */
  async create(s: ExpenseSnapshot): Promise<{ id: string; version: number }> {
    return this.db.transaction(async (tx) => {
      // trip-row FOR UPDATE: finalize 직렬화 + FX 계산에 쓴 timezone이 그새 바뀌지 않았는지 재검증(finding #2·#3 pass2/3)
      const tlock = await tx.select({ status: trips.settlement_status, tz: trips.timezone }).from(trips).where(eq(trips.id, s.trip_id)).for("update");
      if (tlock[0]?.status !== "open") throw new ConflictError("trip settlement finalized; expenses locked", { tripId: s.trip_id });
      if (tlock[0].tz !== s.timezone) throw new ConflictError("trip timezone changed during create; retry", { tripId: s.trip_id }); // stale tz → 409, 클라 재계산
      const rows = await tx
        .insert(expenses)
        .values({
          trip_id: s.trip_id,
          title: s.title,
          local_amount: s.local_amount,
          local_currency: s.local_currency,
          settlement_amount: s.settlement_amount,
          settlement_currency: s.settlement_currency,
          exchange_rate: s.exchange_rate,
          exchange_rate_date: s.exchange_rate_date,
          exchange_rate_source: s.exchange_rate_source,
          exchange_rate_provider: s.exchange_rate_provider,
          exchange_rate_table_date: s.exchange_rate_table_date,
          exchange_rate_fetched_at: s.exchange_rate_fetched_at,
          settlement_amount_source: s.settlement_amount_source,
          payment_method: s.payment_method,
          category: s.category,
          paid_by_member_id: s.paid_by_member_id,
          created_by_member_id: s.created_by_member_id,
          spent_at: s.spent_at,
          expense_settlement_state: s.expense_settlement_state,
          memo: s.memo,
        })
        .returning({ id: expenses.id, version: expenses.version });
      const exp = rows[0]!;
      await tx.insert(expenseParticipants).values(
        s.participant_member_ids.map((member_id) => ({ trip_id: s.trip_id, expense_id: exp.id, member_id })),
      );
      await tx.insert(expenseAuditLogs).values({
        trip_id: s.trip_id,
        expense_id: exp.id,
        changed_by_member_id: s.created_by_member_id,
        change_type: "create",
        before_value: null,
        after_value: {
          title: s.title,
          local_amount: s.local_amount.toString(),
          local_currency: s.local_currency,
          settlement_amount: s.settlement_amount.toString(),
          settlement_currency: s.settlement_currency,
          exchange_rate: s.exchange_rate,
          exchange_rate_source: s.exchange_rate_source,
          payment_method: s.payment_method,
          category: s.category,
          paid_by_member_id: s.paid_by_member_id,
          participant_member_ids: s.participant_member_ids,
          expense_settlement_state: s.expense_settlement_state,
        },
      });
      return exp;
    });
  }

  private async participantsOf(expenseIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (expenseIds.length === 0) return map;
    const rows = await this.db
      .select({ expense_id: expenseParticipants.expense_id, member_id: expenseParticipants.member_id })
      .from(expenseParticipants)
      .where(inArray(expenseParticipants.expense_id, expenseIds));
    for (const r of rows) map.set(r.expense_id, [...(map.get(r.expense_id) ?? []), r.member_id]);
    return map;
  }

  async findById(tripId: string, id: string): Promise<ExpenseRow | null> {
    const rows = await this.db
      .select(COLS)
      .from(expenses)
      .where(and(eq(expenses.trip_id, tripId), eq(expenses.id, id), isNull(expenses.deleted_at)));
    const row = rows[0];
    if (!row) return null;
    const parts = await this.participantsOf([id]);
    return { ...row, participant_member_ids: parts.get(id) ?? [] } as ExpenseRow;
  }

  async listForTrip(tripId: string, limit: number): Promise<ExpenseRow[]> {
    const rows = await this.db
      .select(COLS)
      .from(expenses)
      .where(and(eq(expenses.trip_id, tripId), isNull(expenses.deleted_at)))
      .orderBy(desc(expenses.spent_at), desc(expenses.id))
      .limit(limit);
    const parts = await this.participantsOf(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, participant_member_ids: parts.get(r.id) ?? [] })) as ExpenseRow[];
  }

  /** version CAS UPDATE(메타만) + 참여자 재설정 + audit(update, before/after 전체 스냅샷). 0행이면 null. */
  async updateMeta(tripId: string, id: string, version: number, patch: MetaPatch, actorMemberId: string): Promise<{ version: number } | null> {
    return this.db.transaction(async (tx) => {
      const tlock = await tx.select({ status: trips.settlement_status }).from(trips).where(eq(trips.id, tripId)).for("update"); // finalize 직렬화(finding #2 pass2)
      if (tlock[0]?.status !== "open") throw new ConflictError("trip settlement finalized; expenses locked", { tripId });
      // 변경 전 전체 상태(finding #3 pass1) — tx 내 인라인 로드(tx는 select/insert/update 보유)
      const bRows = await tx.select(COLS).from(expenses).where(and(eq(expenses.trip_id, tripId), eq(expenses.id, id)));
      const bParts = await tx.select({ m: expenseParticipants.member_id }).from(expenseParticipants).where(and(eq(expenseParticipants.trip_id, tripId), eq(expenseParticipants.expense_id, id)));
      const before = bRows[0] ? jsonSafe(bRows[0] as FullRow, bParts.map((p) => p.m)) : null;

      const set: Record<string, unknown> = { version: sql`${expenses.version} + 1`, last_modified_by_member_id: actorMemberId };
      if (patch.title !== undefined) set.title = patch.title;
      if (patch.payment_method !== undefined) set.payment_method = patch.payment_method;
      if (patch.category !== undefined) set.category = patch.category;
      if (patch.memo !== undefined) set.memo = patch.memo;
      if (patch.expense_settlement_state !== undefined) set.expense_settlement_state = patch.expense_settlement_state;
      const updated = await tx
        .update(expenses)
        .set(set)
        .where(and(eq(expenses.trip_id, tripId), eq(expenses.id, id), eq(expenses.version, version), isNull(expenses.deleted_at)))
        .returning({ version: expenses.version });
      const row = updated[0];
      if (!row) return null; // stale/부재 → 롤백
      if (patch.participant_member_ids !== undefined) {
        await tx.delete(expenseParticipants).where(and(eq(expenseParticipants.trip_id, tripId), eq(expenseParticipants.expense_id, id)));
        await tx.insert(expenseParticipants).values(patch.participant_member_ids.map((m) => ({ trip_id: tripId, expense_id: id, member_id: m })));
      }
      // 변경 후 전체 상태
      const aRows = await tx.select(COLS).from(expenses).where(and(eq(expenses.trip_id, tripId), eq(expenses.id, id)));
      const aParts = await tx.select({ m: expenseParticipants.member_id }).from(expenseParticipants).where(and(eq(expenseParticipants.trip_id, tripId), eq(expenseParticipants.expense_id, id)));
      const after = aRows[0] ? jsonSafe(aRows[0] as FullRow, aParts.map((p) => p.m)) : null;
      await tx.insert(expenseAuditLogs).values({ trip_id: tripId, expense_id: id, changed_by_member_id: actorMemberId, change_type: "update", before_value: before, after_value: after });
      return row;
    });
  }

  async softDelete(tripId: string, id: string, version: number, actorMemberId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const tlock = await tx.select({ status: trips.settlement_status }).from(trips).where(eq(trips.id, tripId)).for("update"); // finalize 직렬화(finding #2 pass2)
      if (tlock[0]?.status !== "open") throw new ConflictError("trip settlement finalized; expenses locked", { tripId });
      const bRows = await tx.select(COLS).from(expenses).where(and(eq(expenses.trip_id, tripId), eq(expenses.id, id)));
      const bParts = await tx.select({ m: expenseParticipants.member_id }).from(expenseParticipants).where(and(eq(expenseParticipants.trip_id, tripId), eq(expenseParticipants.expense_id, id)));
      const before = bRows[0] ? jsonSafe(bRows[0] as FullRow, bParts.map((p) => p.m)) : null; // 삭제 전 전체(finding #3 pass1)
      const updated = await tx
        .update(expenses)
        .set({ deleted_at: sql`now()`, version: sql`${expenses.version} + 1`, last_modified_by_member_id: actorMemberId })
        .where(and(eq(expenses.trip_id, tripId), eq(expenses.id, id), eq(expenses.version, version), isNull(expenses.deleted_at)))
        .returning({ id: expenses.id });
      if (!updated[0]) return false;
      await tx.insert(expenseAuditLogs).values({ trip_id: tripId, expense_id: id, changed_by_member_id: actorMemberId, change_type: "delete", before_value: before, after_value: null });
      return true;
    });
  }
}
```
> ⚠️ drizzle insert에서 `bigint mode:"bigint"` 컬럼은 bigint 값, `numeric`은 string, `date`는 'YYYY-MM-DD' string, `timestamp`는 Date. enum 컬럼 값은 유니온. `noUncheckedIndexedAccess` → `rows[0]!`/`?? []`.

**Step 4: green** → PASS.

**Step 5: Commit**
```bash
bun run fmt && bun run check
git add src/modules/expenses/expenses.repo.ts src/modules/expenses/expenses.repo.test.ts
git commit -m "feat(expenses): ExpenseRepo(create tx·findById/list 참여자조립·updateMeta/softDelete CAS·audit)"
```

---

## Task 3: expenses service (resolveFx 통합·tz date·exponent·단일 tx)

**Files:**
- Create: `src/modules/expenses/expenses.service.ts`
- Create: `src/modules/expenses/expenses.service.test.ts`

**핵심 흐름(createExpense):** trip(timezone·settlement_currency) 조회 → spent_at을 trip TZ의 YYYY-MM-DD로 파생 → currencies(local·settlement minor_unit) 조회 → FxInput 구성 → resolveFx → `isResolved`면 repo.create(snapshot), `needsManual`이면 `FxUnresolvedError`(422). DB 제약 위반은 `asValidation`(api-routes 패턴)으로 422.

**Step 1: 실패 테스트** (PG; FX deps는 stub — identity·manual 경로만으로 결정적 테스트)

```ts
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
  const fxDeps = { providers: [], cache: new MemoryCache(), tripDefaults: new DrizzleTripDefaults(ctx.db) };
  return new ExpensesService(ctx.db, repo, fxDeps);
}
async function setup(settlement = "KRW") {
  const u = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, u, { settlement_currency: settlement }); // helper 확장 필요 시
  const m = await new DrizzleMemberRepo(ctx.db).ensureCreatorMembership({ tripId: trip, userId: u, displayName: "A", email: "a@example.com" });
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
    expect(exp.settlement_amount).toBe("37900");
    expect(exp.exchange_rate_source).toBe("identity");
  });
  it("manualRate 제공(현지≠정산) → manual 환산 저장", async () => {
    const { trip, memberId } = await setup("KRW");
    const exp = await svc().createExpense(trip, input(memberId, { local_currency: "JPY", manualRate: "9" }), { memberId });
    expect(exp.exchange_rate_source).toBe("manual");
  });
  it("해결 불가(JPY, manual 없음, provider 없음) → FxUnresolvedError(422)", async () => {
    const { trip, memberId } = await setup("KRW");
    await expect(svc().createExpense(trip, input(memberId, { local_currency: "JPY" }), { memberId })).rejects.toMatchObject({ status: 422, code: "FxUnresolvedError" });
  });
  it("미지 통화 → 422(currencies 부재)", async () => {
    const { trip, memberId } = await setup("KRW");
    await expect(svc().createExpense(trip, input(memberId, { local_currency: "XYZ" }), { memberId })).rejects.toMatchObject({ status: 422 });
  });
  it("finalized trip → 생성 409(잠금, finding #2 pass1)", async () => {
    const { trip, memberId } = await setup("KRW");
    await ctx.sql`update trips set settlement_status='finalized' where id=${trip}`;
    await expect(svc().createExpense(trip, input(memberId), { memberId })).rejects.toMatchObject({ status: 409 });
  });
});
```
> ⚠️ JPY·KRW가 currencies에 시드되어 있어야 manual/identity 테스트 통과. 시드 위치 확인(마이그레이션 시드 또는 helper). 없으면 테스트 setup에서 insert.

**Step 2: 실패 확인** → FAIL.

**Step 3: 구현** (`src/modules/expenses/expenses.service.ts`)

```ts
import { eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { trips } from "../../db/schema/trips.ts";
import { currencies } from "../../db/schema/currencies.ts";
import { ConflictError, FxUnresolvedError, NotFoundError, ValidationError } from "../../core/errors.ts";
import { resolveFx, type FxDeps } from "../fx/fx.service.ts"; // FxDeps export 필요(아래 주)
import { isResolved, type FxInput } from "../fx/fx.types.ts";
import { minor, type Minor, type CurrencyCode } from "../../core/money.ts";
import type { DrizzleExpenseRepo, ExpenseRow } from "./expenses.repo.ts";
import type { CreateExpense, UpdateExpense } from "./expenses.schema.ts";

export interface ExpenseActor {
  memberId: string;
}
const dbCode = (e: unknown): string | undefined =>
  (e as { code?: string } | null)?.code ?? (e as { cause?: { code?: string } } | null)?.cause?.code;
const asValidation = (e: unknown): never => {
  const c = dbCode(e);
  // 23503 FK(미지 통화/멤버)·23514 check(fx_by_source)·23505 unique(중복 participant)·22003 numeric overflow(BIGINT 초과, finding #2 pass3)
  if (c === "23503" || c === "23514" || c === "23505" || c === "22003") throw new ValidationError("invalid expense input", { sqlstate: c });
  throw e;
};
// spent_at(Date) → trip TZ의 YYYY-MM-DD
function localDate(spentAtIso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(spentAtIso));
}

export class ExpensesService<T extends Record<string, unknown>> {
  constructor(
    private readonly db: PostgresJsDatabase<T>,
    private readonly repo: DrizzleExpenseRepo<T>,
    private readonly fxDeps: FxDeps,
  ) {}

  // 정산 확정(finalized) trip은 지출 변경 잠금(finding #2 pass1). open만 허용.
  private async assertTripOpen(tripId: string): Promise<{ tz: string; settle: string }> {
    const rows = await this.db
      .select({ tz: trips.timezone, settle: trips.settlement_currency, status: trips.settlement_status })
      .from(trips)
      .where(eq(trips.id, tripId));
    const trip = rows[0];
    if (!trip) throw new NotFoundError("trip not found");
    if (trip.status !== "open") throw new ConflictError("trip settlement finalized; expenses locked", { tripId });
    return { tz: trip.tz, settle: trip.settle };
  }

  async createExpense(tripId: string, input: CreateExpense, actor: ExpenseActor): Promise<ExpenseRow> {
    // 1) trip(정산통화·timezone) + finalized 가드
    const trip = await this.assertTripOpen(tripId);
    // 2) currencies exponent(local·settlement)
    const cur = await this.db.select({ code: currencies.code, exp: currencies.minor_unit }).from(currencies).where(inArray(currencies.code, [input.local_currency, trip.settle]));
    const expOf = new Map(cur.map((c) => [c.code, c.exp]));
    const localExp = expOf.get(input.local_currency);
    const settleExp = expOf.get(trip.settle);
    if (localExp === undefined || settleExp === undefined) throw new ValidationError("unknown currency", { local: input.local_currency, settlement: trip.settle });
    // 3) resolveFx
    const fxInput: FxInput = {
      localMinor: minor(BigInt(input.local_amount)),
      localCurrency: input.local_currency as CurrencyCode,
      settlementCurrency: trip.settle as CurrencyCode,
      date: localDate(input.spent_at, trip.tz),
      localExp,
      settleExp,
      tripId,
      ...(input.manualRate !== undefined ? { manualRate: input.manualRate } : {}),
    };
    const fx = await resolveFx(fxInput, this.fxDeps);
    if (!isResolved(fx)) throw new FxUnresolvedError("exchange rate unresolved; provide manualRate", { tripId });
    // 4) 저장(단일 tx in repo.create)
    try {
      const { id } = await this.repo.create({
        trip_id: tripId,
        timezone: trip.tz, // FX date 파생에 쓴 tz — repo가 lock 하에 재검증(finding #3 pass3)
        title: input.title,
        local_amount: BigInt(input.local_amount),
        local_currency: input.local_currency,
        settlement_amount: fx.settlement_amount,
        settlement_currency: trip.settle,
        exchange_rate: fx.exchange_rate,
        exchange_rate_date: fx.exchange_rate_date,
        exchange_rate_source: fx.exchange_rate_source,
        exchange_rate_provider: fx.exchange_rate_provider,
        exchange_rate_table_date: fx.exchange_rate_table_date,
        exchange_rate_fetched_at: fx.exchange_rate_fetched_at ? new Date(fx.exchange_rate_fetched_at) : null,
        settlement_amount_source: "converted",
        payment_method: input.payment_method,
        category: input.category,
        spent_at: new Date(input.spent_at),
        expense_settlement_state: input.expense_settlement_state ?? "included",
        memo: input.memo ?? null,
        paid_by_member_id: input.paid_by_member_id,
        created_by_member_id: actor.memberId,
        participant_member_ids: input.participant_member_ids,
      });
      const row = await this.repo.findById(tripId, id);
      if (!row) throw new NotFoundError("expense not found after create");
      return row;
    } catch (e) {
      return asValidation(e);
    }
  }

  async listExpenses(tripId: string, limit: number): Promise<ExpenseRow[]> {
    return this.repo.listForTrip(tripId, Math.min(Math.max(limit, 1), 100));
  }
  async getExpense(tripId: string, id: string): Promise<ExpenseRow> {
    const row = await this.repo.findById(tripId, id);
    if (!row) throw new NotFoundError("expense not found");
    return row;
  }
  async updateExpense(tripId: string, id: string, input: UpdateExpense, actor: ExpenseActor): Promise<ExpenseRow> {
    // finalized 가드는 repo.updateMeta tx 내 FOR UPDATE가 race-safe하게 수행(finding #2 pass2)
    const { version, ...patch } = input;
    let res;
    try {
      res = await this.repo.updateMeta(tripId, id, version, patch, actor.memberId);
    } catch (e) {
      return asValidation(e);
    }
    if (!res) {
      // 부재 vs stale 구분
      const exists = await this.repo.findById(tripId, id);
      if (!exists) throw new NotFoundError("expense not found");
      throw new ConflictError("version conflict (stale)", { tripId, id });
    }
    const row = await this.repo.findById(tripId, id);
    if (!row) throw new NotFoundError("expense not found");
    return row;
  }
  async deleteExpense(tripId: string, id: string, version: number, actor: ExpenseActor): Promise<void> {
    // finalized 가드는 repo.softDelete tx 내 FOR UPDATE가 race-safe하게 수행(finding #2 pass2)
    const ok = await this.repo.softDelete(tripId, id, version, actor.memberId);
    if (!ok) {
      const exists = await this.repo.findById(tripId, id);
      if (!exists) throw new NotFoundError("expense not found");
      throw new ConflictError("version conflict (stale)", { tripId, id });
    }
  }
}
```
> **`FxDeps` export 주:** `fx.service.ts`의 `interface Deps`를 `export interface FxDeps`로 노출(또는 별도 타입 export). 구현 시 `resolveFx`가 받는 deps 타입을 import할 수 있게 조정.
> **trips.settlement_status:** enum('open'|'finalized'). assertTripOpen이 create/update/delete 전에 검사 → finalized면 409(read는 가드 없음).

**Step 4: green** → PASS.

**Step 5: Commit**
```bash
bun run fmt && bun run check
git add src/modules/expenses/expenses.service.ts src/modules/expenses/expenses.service.test.ts
# (FxDeps export를 위해 fx.service.ts 수정 시 함께)
git add src/modules/fx/fx.service.ts
git commit -m "feat(expenses): ExpensesService(resolveFx 통합·TZ date·exponent·needsManual→422·CAS 수정/삭제)"
```

---

## Task 4: expenses controller (zod-openapi 5 라우트)

**Files:**
- Create: `src/modules/expenses/expenses.controller.ts`
- Create: `src/modules/expenses/expenses.controller.test.ts`

**라우트(전부 `/trips/{tripId}/expenses` 하위):** POST(auth·member·idempotency)·GET목록·GET상세·PATCH(member)·DELETE(member, `?version=`).

**응답 매핑:** ExpenseRow(bigint·Date) → expenseResponse(string·ISO). `toResponse(row)` 헬퍼로 `local_amount: row.local_amount.toString()`·`spent_at: row.spent_at.toISOString()` 등 변환. (zod-openapi 응답 enum 검증 → row 타입 유니온 유지.)

**Step 1: 실패 테스트** (PG; idempotency는 redis 필요 → POST 경로는 헤더 없이 테스트해 미들웨어 no-op, idempotency 자체는 Task 0에서 검증)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, mkTrip, type Ctx } from "../../../tests/db/helpers.ts";
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
  const trip = await mkTrip(ctx.sql, u, { settlement_currency: "KRW" });
  const m = await new DrizzleMemberRepo(ctx.db).ensureCreatorMembership({ tripId: trip, userId: u, displayName: "A", email: "a@example.com" });
  return { u, trip, memberId: m.id };
}
function appFor(userId: string) {
  const app = createApp();
  registerErrorFilter(app);
  const repo = new DrizzleExpenseRepo(ctx.db);
  const service = new ExpensesService(ctx.db, repo, { providers: [], cache: new MemoryCache(), tripDefaults: new DrizzleTripDefaults(ctx.db) });
  const resolver: SessionResolver = async () => ({ user: { id: userId } });
  const memberLookup = (t: string, uid: string) => new DrizzleMemberRepo(ctx.db).findMembership(t, uid);
  registerExpenseRoutes(app, { expensesService: service, resolver, memberLookup, idempotencyStore: null });
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

describe("expenses 라우트", () => {
  it("POST → 201, GET 목록 1개, GET 상세, 돈 string 왕복", async () => {
    const { u, trip, memberId } = await setup();
    const app = appFor(u);
    const created = await app.request(`/trips/${trip}/expenses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(memberId)) });
    expect([200, 201]).toContain(created.status);
    const exp = (await created.json()) as { id: string; settlement_amount: string; version: number };
    expect(exp.settlement_amount).toBe("37900");
    const list = await app.request(`/trips/${trip}/expenses`);
    expect(((await list.json()) as unknown[]).length).toBe(1);
    expect((await app.request(`/trips/${trip}/expenses/${exp.id}`)).status).toBe(200);
  });
  it("비멤버 → 403", async () => {
    const { trip, memberId } = await setup();
    const outsider = await mkUser(ctx.sql);
    const res = await appFor(outsider).request(`/trips/${trip}/expenses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(memberId)) });
    expect(res.status).toBe(403);
  });
  it("PATCH 메타(version CAS) → 200·version+1; stale version → 409", async () => {
    const { u, trip, memberId } = await setup();
    const app = appFor(u);
    const id = ((await (await app.request(`/trips/${trip}/expenses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(memberId)) })).json()) as { id: string }).id;
    const ok = await app.request(`/trips/${trip}/expenses/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 0, title: "수정" }) });
    expect(ok.status).toBe(200);
    const stale = await app.request(`/trips/${trip}/expenses/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 0, title: "재수정" }) });
    expect(stale.status).toBe(409);
  });
  it("DELETE(?version=) → soft delete, 이후 GET 404", async () => {
    const { u, trip, memberId } = await setup();
    const app = appFor(u);
    const id = ((await (await app.request(`/trips/${trip}/expenses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(memberId)) })).json()) as { id: string }).id;
    expect((await app.request(`/trips/${trip}/expenses/${id}?version=0`, { method: "DELETE" })).status).toBe(200);
    expect((await app.request(`/trips/${trip}/expenses/${id}`)).status).toBe(404);
  });
  it("해결불가 통화(JPY, manual 없음) → 422 FxUnresolved", async () => {
    const { u, trip, memberId } = await setup();
    const res = await appFor(u).request(`/trips/${trip}/expenses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(memberId, { local_currency: "JPY" })) });
    expect(res.status).toBe(422);
  });
  it("finalized trip → 생성 mutation 409(finding #2 pass1)", async () => {
    const { u, trip, memberId } = await setup();
    await ctx.sql`update trips set settlement_status='finalized' where id=${trip}`;
    const res = await appFor(u).request(`/trips/${trip}/expenses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(memberId)) });
    expect(res.status).toBe(409);
  });
});
```

**Step 2: 실패 확인** → FAIL.

**Step 3: 구현** (`src/modules/expenses/expenses.controller.ts`)

```ts
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { requireAuth, requireTripMember, type SessionResolver, type MembershipLookup } from "../../core/guards.ts";
import { errorResponses } from "../../core/http.ts";
import { idempotency, type IdempotencyStore } from "../../core/idempotency.ts";
import { expenseResponseSchema, createExpenseSchema, updateExpenseSchema } from "./expenses.schema.ts";
import type { ExpensesService } from "./expenses.service.ts";
import type { ExpenseRow } from "./expenses.repo.ts";

interface Deps {
  expensesService: ExpensesService<Record<string, unknown>>;
  resolver: SessionResolver;
  memberLookup: MembershipLookup;
  idempotencyStore: IdempotencyStore | null; // null이면 멱등 미들웨어 생략(테스트)
}
const ok = <S extends z.ZodTypeAny>(schema: S) => ({ 200: { description: "ok", content: { "application/json": { schema } } } });
const jsonBody = <S extends z.ZodTypeAny>(schema: S) => ({ content: { "application/json": { schema } }, required: true });

function toResponse(row: ExpenseRow): z.infer<typeof expenseResponseSchema> {
  return {
    id: row.id,
    trip_id: row.trip_id,
    title: row.title,
    local_amount: row.local_amount.toString(),
    local_currency: row.local_currency,
    settlement_amount: row.settlement_amount.toString(),
    settlement_currency: row.settlement_currency,
    exchange_rate: row.exchange_rate,
    exchange_rate_source: row.exchange_rate_source,
    settlement_amount_source: row.settlement_amount_source,
    payment_method: row.payment_method,
    category: row.category,
    paid_by_member_id: row.paid_by_member_id,
    participant_member_ids: row.participant_member_ids,
    spent_at: row.spent_at.toISOString(),
    expense_settlement_state: row.expense_settlement_state,
    memo: row.memo,
    version: row.version,
  };
}

export function registerExpenseRoutes(app: OpenAPIHono, deps: Deps): void {
  const auth = requireAuth(deps.resolver);
  const member = requireTripMember(deps.memberLookup);
  const idem = deps.idempotencyStore ? [idempotency(deps.idempotencyStore)] : []; // scope=c.req.path(실 tripId)

  app.openapi(
    createRoute({
      method: "post",
      path: "/trips/{tripId}/expenses",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member, ...idem],
      request: { params: z.object({ tripId: z.string().uuid() }), body: jsonBody(createExpenseSchema) },
      responses: { ...ok(expenseResponseSchema), ...errorResponses(403, 404, 409, 422) },
    }),
    async (c) => {
      const row = await deps.expensesService.createExpense(c.req.valid("param").tripId, c.req.valid("json"), { memberId: c.get("membership").id });
      return c.json(toResponse(row), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/trips/{tripId}/expenses",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member],
      request: { params: z.object({ tripId: z.string().uuid() }), query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }) },
      responses: { ...ok(z.array(expenseResponseSchema)), ...errorResponses(403) },
    }),
    async (c) => c.json((await deps.expensesService.listExpenses(c.req.valid("param").tripId, c.req.valid("query").limit)).map(toResponse), 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/trips/{tripId}/expenses/{expenseId}",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member],
      request: { params: z.object({ tripId: z.string().uuid(), expenseId: z.string().uuid() }) },
      responses: { ...ok(expenseResponseSchema), ...errorResponses(403, 404) },
    }),
    async (c) => c.json(toResponse(await deps.expensesService.getExpense(c.req.valid("param").tripId, c.req.valid("param").expenseId)), 200),
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/trips/{tripId}/expenses/{expenseId}",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member],
      request: { params: z.object({ tripId: z.string().uuid(), expenseId: z.string().uuid() }), body: jsonBody(updateExpenseSchema) },
      responses: { ...ok(expenseResponseSchema), ...errorResponses(403, 404, 409, 422) },
    }),
    async (c) => {
      const { tripId, expenseId } = c.req.valid("param");
      const row = await deps.expensesService.updateExpense(tripId, expenseId, c.req.valid("json"), { memberId: c.get("membership").id });
      return c.json(toResponse(row), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/trips/{tripId}/expenses/{expenseId}",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member],
      request: { params: z.object({ tripId: z.string().uuid(), expenseId: z.string().uuid() }), query: z.object({ version: z.coerce.number().int() }) },
      responses: { ...ok(z.object({ id: z.string(), deleted: z.boolean() }).openapi("ExpenseDeleted")), ...errorResponses(403, 404, 409) },
    }),
    async (c) => {
      const { tripId, expenseId } = c.req.valid("param");
      await deps.expensesService.deleteExpense(tripId, expenseId, c.req.valid("query").version, { memberId: c.get("membership").id });
      return c.json({ id: expenseId, deleted: true }, 200);
    },
  );
}
```
> ⚠️ idempotency 미들웨어는 `c.get("user")` 필요 → auth 뒤. `idempotencyStore: null`이면 생략(테스트). `c.get("membership").id`는 Task 0의 Membership.id 확장에 의존.

**Step 4: green** → PASS(5 라우트).

**Step 5: Commit**
```bash
bun run fmt && bun run check
git add src/modules/expenses/expenses.controller.ts src/modules/expenses/expenses.controller.test.ts
git commit -m "feat(expenses): 지출 zod-openapi 라우트(POST idempotency·GET목록/상세·PATCH/DELETE version CAS)"
```

---

## Task 5: buildV1App·main 배선 (FX deps·config env·ioredis·registerExpenseRoutes)

**Files:**
- Modify: `src/app.ts`(V1Deps에 expensesService·idempotencyStore 추가·registerExpenseRoutes)
- Modify: `src/main.ts`(FX deps·ioredis·ExpensesService 구성)
- Modify: `src/core/config.ts`(OXR_APP_ID·CURRENCYAPI_KEY env 추가)
- Modify: `src/openapi-gen.ts`·`src/openapi-doc.test.ts`(stub deps에 expensesService·idempotencyStore:null 추가)

**Step 1: config FX env 추가** (`src/core/config.ts`)

```ts
OXR_APP_ID: z.string().optional(),
CURRENCYAPI_KEY: z.string().optional(),
```
> provider는 키 있을 때만 구성(키 없으면 빈 배열 → identity/manual만 — 개발 환경 허용).

**Step 2: app.ts V1Deps 확장**

```ts
import { registerExpenseRoutes } from "./modules/expenses/expenses.controller.ts";
import type { ExpensesService } from "./modules/expenses/expenses.service.ts";
import type { IdempotencyStore } from "./core/idempotency.ts";

export interface V1Deps {
  // ...기존(tripsService·membersService·resolver·emailOf·memberLookup·webOrigins)
  expensesService: ExpensesService<Record<string, unknown>>;
  idempotencyStore: IdempotencyStore | null;
}
// buildV1App 본문 끝(registerMemberRoutes 뒤):
registerExpenseRoutes(v1, { expensesService: deps.expensesService, resolver: deps.resolver, memberLookup: deps.memberLookup, idempotencyStore: deps.idempotencyStore });
```

**Step 2b: CORS allowHeaders에 Idempotency-Key 추가(finding #5 pass1)** — `src/app.ts`의 `v1.use("*", cors({...}))`:

```ts
v1.use("*", cors({ origin: deps.webOrigins, credentials: true, allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"], allowHeaders: ["Content-Type", "Idempotency-Key"] }));
```
> 없으면 브라우저 preflight가 Idempotency-Key 거부 → 멱등 기능 무용. v1-security 테스트에 preflight 단언 추가:
> ```ts
> it("OPTIONS preflight가 Idempotency-Key 허용(finding #5 pass1)", async () => {
>   const res = await v1For(await mkUser(ctx.sql)).request("/v1/trips/x/expenses", { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "idempotency-key" } });
>   expect((res.headers.get("access-control-allow-headers") ?? "").toLowerCase()).toContain("idempotency-key");
> });
> ```
> (기존 `src/v1-security.test.ts`에 추가 — v1For deps에 `expensesService: {} as never, idempotencyStore: null` 보강.)

**Step 3: main.ts FX·ioredis 배선**

```ts
import { RedisCache } from "./modules/fx/cache/cache.redis.ts";
import { DrizzleTripDefaults } from "./modules/fx/trip-defaults.repo.ts";
import { OxrProvider } from "./modules/fx/provider/oxr.ts";
import { CurrencyApiProvider } from "./modules/fx/provider/currencyapi.ts";
import { DrizzleExpenseRepo } from "./modules/expenses/expenses.repo.ts";
import { ExpensesService } from "./modules/expenses/expenses.service.ts";

const redis = new IoRedis(core.config.VALKEY_URL); // auth와 공유 또는 별도 인스턴스
const providers = [
  ...(core.config.OXR_APP_ID ? [new OxrProvider(core.config.OXR_APP_ID)] : []),
  ...(core.config.CURRENCYAPI_KEY ? [new CurrencyApiProvider(core.config.CURRENCYAPI_KEY)] : []),
];
const expensesService = new ExpensesService(core.db, new DrizzleExpenseRepo(core.db), {
  providers,
  cache: new RedisCache(redis),
  tripDefaults: new DrizzleTripDefaults(core.db),
  onWarn: (event, detail) => core.logger.warn({ event, detail }, "fx"),
});
// buildV1App 호출에 추가:
//   expensesService, idempotencyStore: { redis, ttlSeconds: 86_400 }
```

**Step 4: openapi-gen.ts·openapi-doc.test.ts stub 확장** — `expensesService: {} as never, idempotencyStore: null` 추가(핸들러 미실행 → 무-IO 유지).

**Step 5: 검증**
```bash
bun run fmt && bun run check
env -u DATABASE_URL -u VALKEY_URL -u BETTER_AUTH_SECRET bun run gen:openapi   # 무-IO 동작·expenses 경로 포함 확인
```
Expected: `openapi.json written: N paths`(12 paths — 기존 7 + expenses 5).

**Step 6: Commit**
```bash
git add src/app.ts src/main.ts src/core/config.ts src/openapi-gen.ts src/openapi-doc.test.ts
git commit -m "feat(api): expenses 라우트 buildV1App·main 배선(FX deps·ioredis·config FX env)"
```

---

## Task 6: 계약·통합 테스트

**Files:**
- Create: `src/expenses-doc.test.ts`(또는 openapi-doc.test.ts 확장)

**Step 1: 테스트** — buildV1App stub로 스펙 생성, expenses 경로·DTO·version 노출 확인

```ts
import { describe, it, expect } from "vitest";
import { buildV1App } from "./app.ts";

function docApp() {
  return buildV1App({
    tripsService: {} as never, membersService: {} as never, expensesService: {} as never,
    resolver: async () => null, emailOf: async () => "", memberLookup: async () => null,
    idempotencyStore: null, webOrigins: ["http://localhost:5173"],
  });
}
const doc = () => docApp().getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "1" } });

describe("expenses OpenAPI 계약", () => {
  it("expenses 경로 등록(목록·상세·생성·수정·삭제)", () => {
    const paths = Object.keys(doc().paths ?? {});
    expect(paths.some((p) => p.includes("/v1/trips/{tripId}/expenses"))).toBe(true);
    expect(paths.some((p) => p.includes("/expenses/{expenseId}"))).toBe(true);
  });
  it("Expense 스키마에 version·string 금액", () => {
    const schemas = doc().components?.schemas ?? {};
    expect(schemas.Expense).toBeDefined();
  });
});
```

**Step 2: green** → PASS.

**Step 3: 전체 스위트** — `bun run test`(기존 187 + 신규, 0 실패) + `bun run check`.

**Step 4: Commit**
```bash
bun run fmt && bun run check
git add src/expenses-doc.test.ts
git commit -m "test(api): expenses OpenAPI 계약(경로·Expense 스키마·version)"
```

---

## Definition of Done
- [ ] expenses CRUD 5 라우트 동작(인가·version CAS·돈 string)
- [ ] 생성 시 resolveFx 스냅샷 저장(identity/manual/auto)·needsManual→422 FxUnresolved
- [ ] Idempotency-Key 미들웨어(replay·다른body 409·in-progress 409·헤더없음 통과)
- [ ] audit 로그(create/update/delete) 동일 tx 기록
- [ ] gen:openapi 무-IO·expenses 경로 포함(12 paths)
- [ ] 전체 스위트 0 실패·check 통과

## Out of scope (후속 슬라이스, forward-ref)
- card_billed(settlement_amount_source='card_billed') · `:preview` · 편집재계산(amount/currency/date) · trip_default 승격 · 커서 페이지네이션 · 정산 분할 계산
- **완전 cross-failure durable 멱등**(idempotency_keys DB 테이블을 지출 tx에 동봉, Redis 부분실패 시에도 저장응답 재생) — 본 슬라이스는 Redis lock으로 TTL 윈도 내 중복방지 보장(finding #1 pass2)
- **settlement finalize의 trip-row FOR UPDATE 잠금** — 본 슬라이스의 expense mutation이 거는 trip-row lock과 상호 직렬화하려면 finalize 경로도 동일 잠금 필요(finding #2 pass2, settlement 슬라이스에서)

> **인프라 전제:** 스코프 멱등은 Redis lock 영속에 의존 → **Valkey AOF 영속화**(appendonly yes) 권장(failover 시 lock 키 유실로 인한 중복 생성 위험 완화, finding #1 pass3).

---

## Adversarial review dispositions

Codex 적대적 리뷰(working-tree 모드) **3 passes(cap)**. **총 11건 finding 전부 Accept**(9건 계획 반영, 2건은 멱등 durability를 사용자 승인 하에 스코프 완화+forward-ref). high 추세 2→2→3, 매 pass 다른 영역(멱등/finalized/audit→멱등durable/race/validation→멱등durable/money/stale-tz)으로 이동하며 수렴. cap 3패스 후 **사용자 결정으로 finding #1(멱등 durability)을 스코프 멱등(Redis lock TTL-윈도 중복차단 + Valkey AOF + DB-durable forward-ref)으로 확정**. 이 섹션은 확정 후 감사추적이며 재리뷰 대상이 아니다.

| pass | # | finding | sev | 결정 | 반영 |
|---|---|---|---|---|---|
| 1 | 1 | Idempotency lock이 에러 경로 미해제 | high | Accept | try/catch del+rethrow·non-2xx del·throw 422 재시도 테스트 |
| 1 | 2 | finalized trip 변경 가능(가드 없음) | high | Accept | assertTripOpen + (pass2)repo tx FOR UPDATE |
| 1 | 3 | audit가 {version}만 — 롤백 불가 | med | Accept | before/after 전체 jsonb 스냅샷·repo 테스트 |
| 1 | 4 | Idempotency scope에 tripId 누락 | med | Accept | scope=`c.req.path`(실 tripId)·경로격리 테스트 |
| 1 | 5 | 브라우저가 Idempotency-Key 전송 불가 | med | Accept | /v1 CORS allowHeaders + preflight 테스트 |
| 2 | 1 | 멱등 replay가 commit 후 기록(비원자) | high | **Accept(스코프)** | lock-safety(TTL 내 중복차단)·DB-durable forward-ref(사용자 승인) |
| 2 | 2 | finalized 가드가 tx 밖(TOCTOU) | high | Accept | repo create/update/delete tx 내 trip-row FOR UPDATE 재검사 |
| 2 | 3 | 중복 participant → 500 | med | Accept | DTO unique refine(create+update)·23505→422 |
| 3 | 1 | Redis-only 멱등 중복 가능(failover/TTL) | high | **Accept(스코프)** | pass2#1과 동일 사용자 결정 — Valkey AOF 전제·DB-durable forward-ref |
| 3 | 2 | money 입력 무한/오버플로 → 500 | high | Accept | minorString max19+BIGINT refine·manualRate max·22003→422·테스트 |
| 3 | 3 | stale trip timezone으로 FX 계산(TOCTOU) | high | Accept | snapshot.timezone을 repo가 FOR UPDATE 하에 재검증→불일치 409·테스트 |

**최종 pass3 `summary`:** "duplicate expense creation under partial failure, unsafe money-input and FX snapshot edge cases." → money 경계·stale-tz 반영, 멱등 durability는 사용자 결정으로 스코프 멱등 확정(Valkey AOF 전제).

---

## Execution directives
- **Skill:** `executing-plans`로 **이 워크트리**(`~/workspace/trip-mate-api/.worktrees/fx-integration`, 브랜치 `feat/fx-integration`)에서 task-by-task 구현(Task 0→6).
- **연속 실행:** 일상 리뷰로 멈추지 말 것. 진짜 블로커(의존성 부재·반복 실패 검증·모순 지시·치명적 plan 공백)에서만 정지. Docker 데몬 필요(testcontainers PG16 + redis:7). **@hono/zod-openapi 1.4·ioredis(`set NX EX` 반환·`c.req.raw.clone`·`c.res.clone`)·drizzle(`.for("update")`·bigint/numeric/date 매핑)는 설치 타입·런타임으로 확인**하되 의미(멱등·FX 스냅샷·version CAS·finalized 가드·audit before/after)는 고정. strict-TS 함정은 메모리 [[trip-mate-api-strict-ts-gotchas]]·[[trip-mate-api-zod-openapi-gotchas]] 참조.
- **커밋 — 직접 적용, `Skill(commit)` 호출 금지:**
  - 한국어 메시지, **AI 마커 금지**(`🤖`·`Co-Authored-By: Claude` 등).
  - 형식 `<type>(<scope>): 한국어 설명`. **type은 `feat`/`fix`/`refactor`/`docs`/`style`/`test`/`chore`만**.
  - 그룹화: 같은 모듈 dir·같은 목적 together; config·테스트·문서·독립 변경은 각자. 각 Task Commit 스텝에서 현재 `feat/fx-integration` 워크트리에 직접.
  - 포맷: 새 .ts 후 `bun run fmt` → `bun run check`. **`&&` 체인**(check 실패 시 commit 차단).
- **시작점:** Task 0(Idempotency·FxUnresolvedError·Membership.id)→6 순서. SSOT 충돌 시 `api-contract-design` > 본 plan > `fx-integration-design` > `architecture` > PRD.
