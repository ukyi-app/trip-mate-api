# trip-mate-api API 라우트 슬라이스(OpenAPI 기반 + trip/member/invite) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `@hono/zod-openapi`로 **계약 사슬(Zod→OpenAPI→FE 타입)**의 백엔드 절반을 구축한다. `/v1` 프리픽스·cookie security·RFC 9457 problem+json 에러 스키마·`gen:openapi`(무-IO 생성)의 **OpenAPI 파운데이션**을 세우고, **trips·members·invites 라우트**를 DTO와 함께 구현한다(auth-invite의 가드·CSRF·CORS·`__Host-`·MembersService를 `/v1`에 배선, 테스트전용 accept 라우트를 프로덕션화). expenses·settlement 라우트와 version/Idempotency-Key/커서 동시성 기계는 후속 슬라이스로 분리.

**Architecture:** contract-first. 라우트 정의(`createRoute` config + DTO Zod 스키마)는 순수이고, 핸들러는 service에 위임. **`buildV1App(deps)`** 가 모든 `/v1` 라우트·security를 OpenAPIHono에 등록하는 단일 진실원 — main.ts(실 deps)와 `gen:openapi`(lazy/stub deps, 핸들러 미실행이라 무-IO) 둘 다 호출. 모듈은 `createXModule(core)→{exports, controllers}`(architecture §4.2), controller는 `register(app)`. DTO는 route별 public/입력 3종 분리(과노출 차단).

**Tech Stack:** Bun · Hono · @hono/zod-openapi(^1.4.0, Zod v4) · drizzle-zod(^0.8.3) · Drizzle · vitest · testcontainers(PG16). 기반: auth-invite 슬라이스(`core/guards`·`core/csrf`·`core/host-cookie`·`modules/auth/mount`·`modules/members/{repo,service}`·`core/errors`(registerErrorFilter))·`core/openapi.ts`(createApp)·`core/composition.ts`(createCore)·`db/schema/{trips,members}`·`tests/db/helpers`.

**SSOT(충돌 시 우선):** `docs/plans/2026-06-29-api-contract-design.md`(계약·DTO·에러·동시성 — Codex 3-pass) · `docs/plans/2026-06-29-auth-invite-design.md`(인가·초대) · `docs/architecture.md`(§3 계약사슬·§4 모듈/DI/에러). zod-openapi 1.4.0의 정확한 API(security 등록·doc 생성·middleware 부착)는 구현 시 설치 타입으로 확인 — 본 계획은 패턴·DTO 경계·테스트를 고정.

---

## 진행 원칙 (executing-plans)
- **연속 실행** — 진짜 블로커에서만 정지. TDD(테스트 먼저→실패→구현→통과→커밋). 라우트는 `app.request()` 인메모리 통합 + testcontainers PG.
- **워크트리** — 이미 `feat/api-routes`(`.worktrees/api-routes`, `feat/auth-invite` 적층)로 격리. 새 워크트리 금지. 경로는 워크트리 기준 절대경로.
- **커밋** — 각 Task Commit에서 직접. 한국어·**AI 마커 금지**·`<type>(<scope>): 설명`, type은 `feat/fix/refactor/docs/style/test/chore`만. `Skill(commit)` 금지.
- **포맷** — 새 .ts 후 `bun run fmt`→`bun run check`. **`&&` 체인 또는 check 통과 확인 후 커밋**(`;` 분리 시 check 실패에도 commit됨 — auth-invite 교훈).
- **strict-TS 함정**(메모리 `trip-mate-api-strict-ts-gotchas`): `noUncheckedIndexedAccess`(테스트 `res.json()`은 `unknown`→캐스트), `exactOptionalPropertyTypes`(명시 `undefined` 금지→조건부 spread), OpenAPIHono↔Hono `.fetch` 변성(`ReturnType<typeof createApp>`/`Hono<any,any,any>`), `DrizzleQueryError.cause.code`로 SQLSTATE.
- **zod-openapi** — `import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi"`(이 `z`는 `.openapi()` 확장). bare `app.get/post` 금지 → `app.openapi(route, handler)`. 미들웨어 부착·security 형태는 설치 타입으로 확인.

## Out of scope (후속 슬라이스)
- **expenses 라우트**(list+커서+필터·create+preview·patch/delete·resolveFx 저장경로 통합·card_billed·편집 재계산·trip_default 승격) — **FX 통합 슬라이스**.
- **settlement 라우트**(get/precheck·finalize reviewed-set·unlock·transfers:mark-paid) — **정산 슬라이스**.
- **동시성/멱등 기계**: 낙관적 `version`(expense/settlement용), `Idempotency-Key`(Valkey single-flight), 커서 페이지네이션 — **expense/Idempotency 인프라 슬라이스**에서 일괄 도입(api-contract §5). 멤버십엔 version 없음.
  - ⚠️ **known limitation(finding #1·#3 pass4/5):** 본 슬라이스 `/v1` mutation(**POST /trips·invite 생성·resend**)은 **Idempotency-Key 미적용** → 네트워크 재시도/lost-response 시 **중복 trip·stale 링크 가능**. trip DELETE도 본 슬라이스 미포함이라 중복 trip 정리 경로 없음. **수용 근거:** trip/invite 생성은 의도적 단일 사용자 행위(오프라인 자동큐 아님)라 expense 대비 위험 낮음. Idempotency-Key 미들웨어(principal+endpoint scope·request-hash replay·single-flight)는 **인프라 슬라이스가 모든 `/v1` mutation에 일괄 적용**하며 그때 POST /trips 멱등도 커버. 본 슬라이스는 **회전/생성 원자성만** 보장.
- **trips DELETE**(cascade 위험) — 후속. 본 슬라이스는 trips create/get/list/patch.
- **admin 양도(어드민 역할 이전)** — `uq_one_admin`(활성 admin≤1)+`assertNotLastAdmin` 때문에 단일 member PATCH로 승격/강등 둘 다 불가(데드락) → **전용 트랜잭션 액션**(행 잠금·demote+promote 원자)이 필요. 본 슬라이스 member PATCH는 **display_name+비활성만**(role 변경 제외, admin 비활성 시 last-admin 가드). admin 양도는 후속 멤버관리 슬라이스(finding #4 pass1).
- **R2 스펙 publish + web Hey API codegen** — 배포/CI + trip-mate-web 레포. 본 슬라이스는 `gen:openapi`로 `openapi.json` 산출까지(R2 업로드·drift CI는 후속).
- **rate limiting·audit 로깅·관측**.

## 빌드 순서 (의존성)
`Task 0 OpenAPI 파운데이션(에러스키마·security·gen:openapi 골격) → 1 trips DTO → 2 trips repo → 3 trips service(+ensureCreatorMembership) → 4 trips controller(zod-openapi) → 5 members/invites DTO → 6 members/invites controller(productionize) → 7 buildV1App·main.ts 배선·gen:openapi 완성 → 8 계약/통합 테스트(OpenAPI doc·authz·에러)`.

---

## Task 0: OpenAPI 파운데이션 — 에러 스키마·security·doc 생성 골격

**Files:** Create `src/core/http.ts`(problem+json DTO·errorResponses 헬퍼) · `src/modules/auth/session.ts`(SessionUser+email 리졸버) · Test `src/core/http.test.ts`

SSOT: api-contract §3(에러)·§1(security). 모든 라우트가 공유할 problem+json 응답 스키마 + 표준 에러 응답 셋.

**Step 1: 실패 테스트** `core/http.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { problemSchema, errorResponses } from "./http.ts";

describe("problem+json 계약", () => {
  it("problemSchema는 type·title·status·code 필수", () => {
    const ok = problemSchema.safeParse({ type: "about:blank", title: "ForbiddenError", status: 403, code: "ForbiddenError" });
    expect(ok.success).toBe(true);
    expect(problemSchema.safeParse({ title: "x" }).success).toBe(false);
  });
  it("errorResponses는 지정 status들의 problem 스키마 응답 생성", () => {
    const r = errorResponses(403, 404);
    expect(Object.keys(r)).toEqual(["403", "404"]);
    expect(r[403].content["application/problem+json"].schema).toBe(problemSchema);
  });
});
```

**Step 2: 실패 확인** — `bun run test src/core/http.test.ts` · FAIL.

**Step 3: 구현** `core/http.ts`

```ts
import { z } from "@hono/zod-openapi";

/** RFC 9457 problem+json (api-contract §3). meta는 선택. */
export const problemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    code: z.string(),
    detail: z.string().optional(),
    meta: z.unknown().optional(),
  })
  .openapi("Problem");

type Status = 400 | 403 | 404 | 409 | 422 | 500;
/** route responses에 펼칠 표준 에러 응답 셋. 예 `...errorResponses(403, 404, 409)`. */
export function errorResponses(...statuses: Status[]) {
  const out: Record<number, { description: string; content: { "application/problem+json": { schema: typeof problemSchema } } }> = {};
  for (const s of statuses) {
    out[s] = { description: `${s} problem+json`, content: { "application/problem+json": { schema: problemSchema } } };
  }
  return out;
}

/** zod 검증 실패를 422 problem+json으로(finding #3 pass1). createApp의 defaultHook이 사용. */
export function problemFromZod(error: { issues?: unknown }) {
  return {
    type: "about:blank",
    title: "ValidationError",
    status: 422,
    code: "ValidationError",
    detail: "input validation failed",
    meta: error.issues,
  };
}
```
> `z`는 `@hono/zod-openapi`의 확장 z(`.openapi()`). errorResponses의 key는 number(테스트는 `r[403]`). responses 객체에 spread하여 사용.

**Step 3b: `createApp`에 422 defaultHook 배선 (finding #3 pass1)** — Modify `src/core/openapi.ts`

`@hono/zod-openapi`는 검증 실패 시 기본 400을 반환하므로, **`OpenAPIHono`의 `defaultHook`으로 422 problem+json을 강제**한다. 모든 라우트 앱이 `createApp()`을 쓰도록 통일(테스트 앱 포함).

```ts
import { OpenAPIHono } from "@hono/zod-openapi";
import { problemFromZod } from "./http.ts";

export function createApp() {
  return new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        // 미디어타입 application/problem+json (RFC 9457, finding #3 pass2)
        return c.json(problemFromZod(result.error), 422, { "content-type": "application/problem+json" });
      }
    },
  });
}
```
> `defaultHook`의 정확한 시그니처(`result.success`·`result.error: ZodError`)는 설치 타입으로 확인. 라우트 테스트 앱은 **`new OpenAPIHono()` 대신 `createApp()`**을 써서 이 훅을 상속(Task 4·6·8 테스트 반영).
> **registerErrorFilter도 동일 미디어타입(finding #3 pass2):** auth-invite `core/errors.ts`의 `registerErrorFilter`가 `c.json(problem, status)` → `c.json(problem, status, { "content-type": "application/problem+json" })`로 수정(AppError·500 양쪽). auth-invite 통합테스트는 JSON 파싱이라 호환. → 본 Task 커밋에 `core/errors.ts` 포함.

추가 422 런타임 테스트(`core/http.test.ts`에 보강):
```ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createApp } from "./openapi.ts";
it("zod 검증 실패 → 422 problem+json(code=ValidationError, content-type)", async () => {
  const app = createApp();
  app.openapi(
    createRoute({ method: "post", path: "/x", request: { body: { content: { "application/json": { schema: z.object({ n: z.number() }) } }, required: true } }, responses: { 200: { description: "ok" } } }),
    (c) => c.json({}, 200),
  );
  const res = await app.request("/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ n: "bad" }) });
  expect(res.status).toBe(422);
  expect(res.headers.get("content-type")).toMatch(/application\/problem\+json/);
  expect(((await res.json()) as { code: string }).code).toBe("ValidationError");
});
```

`modules/auth/session.ts` — 운영 세션 리졸버(user.id + email):

```ts
import type { createAuth } from "../../auth.ts";
import type { SessionResolver } from "../../core/guards.ts";

type AuthInstance = ReturnType<typeof createAuth>;
export interface SessionPrincipal {
  id: string;
  email: string;
}

/** Better Auth 세션에서 principal(id+email) 해석. 핸들러가 actor로 사용. */
export function sessionPrincipal(auth: AuthInstance) {
  return async (headers: Headers): Promise<SessionPrincipal | null> => {
    const s = await auth.api.getSession({ headers });
    return s?.user ? { id: s.user.id, email: s.user.email } : null;
  };
}
/** guards.requireAuth용 리졸버(id만). 이메일은 sessionPrincipal로 별도 조회. */
export function authResolver(auth: AuthInstance): SessionResolver {
  return async (headers) => {
    const s = await auth.api.getSession({ headers });
    return s?.user ? { user: { id: s.user.id } } : null;
  };
}
```
> ⚠️ `auth.api.getSession` 반환의 `user.email` 존재를 설치 타입으로 확인(Better Auth user는 email 필수 — auth-schema).

**Step 4: 통과 확인** — PASS.

**Step 5: Commit**

```bash
bun run fmt && bun run check
git add src/core/http.ts src/core/http.test.ts src/core/openapi.ts src/core/errors.ts src/modules/auth/session.ts
git commit -m "feat(api): problem+json 에러 스키마·errorResponses·422 defaultHook·미디어타입·세션 principal"
```

---

## Task 1: trips DTO 스키마 (`modules/trips/trips.schema.ts`)

**Files:** Create `src/modules/trips/trips.schema.ts` · Test `src/modules/trips/trips.schema.test.ts`

SSOT: api-contract §4(DTO 경계), architecture §3. drizzle-zod로 테이블→Zod 후 pick/omit. **내부 컬럼(created_by_user_id 등) 응답 omit.** trips는 돈 필드 없음(통화는 code).

**Step 1: 실패 테스트**

```ts
import { describe, it, expect } from "vitest";
import { tripResponseSchema, createTripSchema } from "./trips.schema.ts";

describe("trips DTO", () => {
  it("응답은 공개 필드 포함·내부 omit", () => {
    const r = tripResponseSchema.safeParse({
      id: "11111111-1111-1111-1111-111111111111",
      title: "도쿄",
      start_date: "2026-08-01",
      end_date: "2026-08-05",
      destination_countries: ["JP"],
      timezone: "Asia/Tokyo",
      primary_local_currency: "JPY",
      settlement_currency: "KRW",
      settlement_status: "open",
    });
    expect(r.success).toBe(true);
    // 내부 컬럼은 스키마에 없음(있어도 strip)
    expect("created_by_user_id" in (tripResponseSchema.parse({ ...validTrip() }) as object)).toBe(false);
  });
  it("create 입력은 title·날짜·통화·국가·timezone, 내부/생성 필드 제외", () => {
    const ok = createTripSchema.safeParse({
      title: "도쿄",
      start_date: "2026-08-01",
      end_date: "2026-08-05",
      destination_countries: ["JP"],
      timezone: "Asia/Tokyo",
      primary_local_currency: "JPY",
      settlement_currency: "KRW",
    });
    expect(ok.success).toBe(true);
    expect(createTripSchema.safeParse({ title: "" }).success).toBe(false);
    expect(
      createTripSchema.safeParse({ title: "x", start_date: "2026-08-09", end_date: "2026-08-01", destination_countries: ["JP"], timezone: "Asia/Tokyo", primary_local_currency: "JPY", settlement_currency: "KRW" }).success,
    ).toBe(false); // 역순 날짜(finding #2 pass3)
  });
});
function validTrip() {
  return {
    id: "11111111-1111-1111-1111-111111111111", title: "t", start_date: "2026-08-01", end_date: "2026-08-05",
    destination_countries: ["JP"], timezone: "Asia/Tokyo", primary_local_currency: "JPY", settlement_currency: "KRW", settlement_status: "open",
  };
}
```

**Step 2: 실패 확인** — FAIL.

**Step 3: 구현** `trips.schema.ts`

```ts
import { z } from "@hono/zod-openapi";

/** 공개 응답 DTO(내부 컬럼 omit). drizzle-zod 대신 명시 zod로 OpenAPI 안정. */
export const tripResponseSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    start_date: z.string(), // date (YYYY-MM-DD)
    end_date: z.string(),
    destination_countries: z.array(z.string()),
    timezone: z.string(),
    primary_local_currency: z.string(),
    settlement_currency: z.string(),
    settlement_status: z.enum(["open", "finalized"]),
  })
  .openapi("Trip");

// 실 달력 날짜(2026-99-99 거부, finding #3 pass5). Zod v4 `z.iso.date()`. API 다르면 refine(Date 파싱)로 대체.
const isoDate = z.iso.date();
// IANA timezone 검증(bogus timezone 거부). Intl로 런타임 확인.
const ianaTimezone = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: "invalid IANA timezone" },
);

// 베이스 필드(omit/partial 가능한 ZodObject). refine은 파생 스키마에 적용(ZodEffects는 omit 불가).
const tripFields = z.object({
  title: z.string().min(1).max(100),
  start_date: isoDate,
  end_date: isoDate,
  destination_countries: z.array(z.string().length(2)).min(1),
  timezone: ianaTimezone,
  primary_local_currency: z.string().length(3),
  settlement_currency: z.string().length(3),
});

// start_date ≤ end_date(YYYY-MM-DD 사전식 비교) — DB trip_dates 제약을 422로 선차단(finding #2 pass3).
export const createTripSchema = tripFields
  .refine((d) => d.start_date <= d.end_date, { message: "start_date must be <= end_date", path: ["end_date"] })
  .openapi("CreateTrip");

// 통화는 생성 후 불변(expense 무결성, finding #2 pass2) → UpdateTrip 제외. 둘 다 있으면 날짜 순서 검증.
export const updateTripSchema = tripFields
  .omit({ primary_local_currency: true, settlement_currency: true })
  .partial()
  .refine((d) => !d.start_date || !d.end_date || d.start_date <= d.end_date, { message: "start_date must be <= end_date", path: ["end_date"] })
  .openapi("UpdateTrip");
export type TripResponse = z.infer<typeof tripResponseSchema>;
export type CreateTrip = z.infer<typeof createTripSchema>;
```
> 명시 zod 스키마(drizzle-zod 결과 직접노출 금지, architecture §3). 통화 코드 유효성(seed 9종)은 DB FK가 최종 강제 → 422는 형식만.

**Step 4: 통과 확인** — PASS.

**Step 5: Commit**

```bash
bun run fmt && bun run check
git add src/modules/trips/trips.schema.ts src/modules/trips/trips.schema.test.ts
git commit -m "feat(trips): trip DTO 스키마(응답·create·update, 내부 컬럼 omit)"
```

---

## Task 2: trips repo (`modules/trips/trips.repo.ts`, TDD testcontainers PG)

**Files:** Create `src/modules/trips/trips.repo.ts` · Test `src/modules/trips/trips.repo.test.ts`

SSOT: architecture §10.2(포트+어댑터). create·findById·listForUser(joined 멤버십)·update.

**Step 1: 실패 테스트** (startDb·mkUser 재사용)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, type Ctx } from "../../../tests/db/helpers.ts";
import { DrizzleTripRepo } from "./trips.repo.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

const input = (over = {}) => ({
  title: "도쿄", start_date: "2026-08-01", end_date: "2026-08-05",
  destination_countries: ["JP"], timezone: "Asia/Tokyo", primary_local_currency: "JPY", settlement_currency: "KRW", ...over,
});

describe("DrizzleTripRepo", () => {
  it("create→findById", async () => {
    const u = await mkUser(ctx.sql);
    const repo = new DrizzleTripRepo(ctx.db);
    const trip = await repo.create(input(), u);
    expect(trip.title).toBe("도쿄");
    expect((await repo.findById(trip.id))?.settlement_currency).toBe("KRW");
  });
  it("update title", async () => {
    const u = await mkUser(ctx.sql);
    const repo = new DrizzleTripRepo(ctx.db);
    const trip = await repo.create(input(), u);
    const updated = await repo.update(trip.id, { title: "오사카" });
    expect(updated?.title).toBe("오사카");
  });
});
```
> `listForUser`(joined 멤버십 조인)는 멤버십 생성이 필요 → Task 3 service 테스트에서 검증(여기선 create/find/update만).

**Step 2: 실패 확인** — FAIL.

**Step 3: 구현** `trips.repo.ts`

```ts
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { trips } from "../../db/schema/trips.ts";
import { tripMembers } from "../../db/schema/members.ts";
import type { CreateTrip, TripResponse } from "./trips.schema.ts";

const COLS = {
  id: trips.id, title: trips.title, start_date: trips.start_date, end_date: trips.end_date,
  destination_countries: trips.destination_countries, timezone: trips.timezone,
  primary_local_currency: trips.primary_local_currency, settlement_currency: trips.settlement_currency,
  settlement_status: trips.settlement_status,
};

type Tx<T extends Record<string, unknown>> = PostgresJsDatabase<T>; // db 또는 tx 핸들(같은 인터페이스)

export interface TripRepo {
  create(input: CreateTrip, userId: string, tx?: unknown): Promise<TripResponse>;
  findById(id: string): Promise<TripResponse | null>;
  listForUser(userId: string): Promise<TripResponse[]>;
  update(id: string, patch: Partial<CreateTrip>): Promise<TripResponse | null>;
}

export class DrizzleTripRepo<T extends Record<string, unknown>> implements TripRepo {
  constructor(private readonly db: PostgresJsDatabase<T>) {}
  // tx 핸들 주입 시 그 위에서 실행(trip 생성+멤버십 단일 tx, finding #2 pass1)
  async create(input: CreateTrip, userId: string, tx?: unknown): Promise<TripResponse> {
    const exec = (tx as Tx<T>) ?? this.db;
    const rows = await exec.insert(trips).values({ ...input, created_by_user_id: userId }).returning(COLS);
    return rows[0]! as TripResponse;
  }
  async findById(id: string): Promise<TripResponse | null> {
    const rows = await this.db.select(COLS).from(trips).where(eq(trips.id, id));
    return (rows[0] ?? null) as TripResponse | null;
  }
  async listForUser(userId: string): Promise<TripResponse[]> {
    const rows = await this.db
      .select(COLS)
      .from(trips)
      .innerJoin(tripMembers, eq(tripMembers.trip_id, trips.id))
      .where(and(eq(tripMembers.user_id, userId), eq(tripMembers.status, "joined")));
    return rows as TripResponse[];
  }
  async update(id: string, patch: Partial<CreateTrip>): Promise<TripResponse | null> {
    if (Object.keys(patch).length === 0) return this.findById(id);
    const rows = await this.db.update(trips).set(patch).where(eq(trips.id, id)).returning(COLS);
    return (rows[0] ?? null) as TripResponse | null;
  }
}
```
> `as TripResponse`: COLS select 결과(enum union 등)를 DTO로. innerJoin select 형태는 구현 시 drizzle 반환 타입 확인(중첩될 수 있음 — 필요시 `.select(COLS)` 명시 유지).

**Step 4: 통과 확인** — PASS.

**Step 5: Commit**

```bash
bun run fmt && bun run check
git add src/modules/trips/trips.repo.ts src/modules/trips/trips.repo.test.ts
git commit -m "feat(trips): TripRepo(create·findById·listForUser·update, 포트+drizzle)"
```

---

## Task 3: trips service (`modules/trips/trips.service.ts`, TDD)

**Files:** Create `src/modules/trips/trips.service.ts` · Test `src/modules/trips/trips.service.test.ts`

SSOT: architecture §4.2·§4.4. createTrip = **단일 tx로 trip insert + 생성자 어드민 멤버십**(auth-invite `MembersService.ensureCreatorMembership` 재사용). get/list/update 인가.

**Step 1: 실패 테스트** (testcontainers PG, MembersService 실 결합)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, type Ctx } from "../../../tests/db/helpers.ts";
import { DrizzleTripRepo } from "./trips.repo.ts";
import { DrizzleMemberRepo } from "../members/members.repo.ts";
import { MembersService } from "../members/members.service.ts";
import { TripsService } from "./trips.service.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

function svc() {
  const members = new MembersService(new DrizzleMemberRepo(ctx.db), { ttlHours: 168 });
  return new TripsService(ctx.db, new DrizzleTripRepo(ctx.db), members);
}
const input = () => ({
  title: "도쿄", start_date: "2026-08-01", end_date: "2026-08-05",
  destination_countries: ["JP"], timezone: "Asia/Tokyo", primary_local_currency: "JPY", settlement_currency: "KRW",
});
const actor = (id: string, email = "a@example.com") => ({ id, email });

describe("TripsService", () => {
  it("createTrip → trip + 생성자 어드민 멤버십(joined)", async () => {
    const u = await mkUser(ctx.sql);
    const s = svc();
    const trip = await s.createTrip(input(), actor(u));
    expect(trip.settlement_currency).toBe("KRW");
    // 생성자는 그 trip의 joined admin
    expect(await s.listTrips(u)).toHaveLength(1);
  });
  it("listTrips는 내가 joined인 trip만", async () => {
    const u1 = await mkUser(ctx.sql);
    const u2 = await mkUser(ctx.sql);
    const s = svc();
    await s.createTrip(input(), actor(u1));
    expect(await s.listTrips(u2)).toHaveLength(0);
  });
  it("멤버십 생성 실패 시 trip 롤백(고아 없음, finding #2 pass1)", async () => {
    const u = await mkUser(ctx.sql);
    const repo = new DrizzleTripRepo(ctx.db);
    const boom = { ensureCreatorMembership: async () => { throw new Error("boom"); } } as unknown as MembersService;
    const s = new TripsService(ctx.db, repo, boom);
    await expect(s.createTrip(input(), actor(u))).rejects.toThrow();
    const cnt = await ctx.sql<{ n: number }[]>`select count(*)::int as n from trips where created_by_user_id = ${u}`;
    expect(cnt[0]!.n).toBe(0); // 롤백 — trip 미생성
  });
});
```

**Step 2: 실패 확인** — FAIL.

**Step 3: 구현** `trips.service.ts`

```ts
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { NotFoundError, ValidationError } from "../../core/errors.ts";
import type { MembersService } from "../members/members.service.ts";
import type { TripRepo } from "./trips.repo.ts";
import type { CreateTrip, TripResponse } from "./trips.schema.ts";

export interface TripActor {
  id: string;
  email: string;
}

// drizzle은 postgres 에러를 감싸므로 SQLSTATE는 .code 또는 .cause.code. 23503(FK 미지 통화)·23514(check 역순날짜)는 입력 오류.
const dbCode = (e: unknown): string | undefined =>
  (e as { code?: string } | null)?.code ?? (e as { cause?: { code?: string } } | null)?.cause?.code;
const asValidation = (e: unknown): never => {
  const c = dbCode(e);
  if (c === "23503" || c === "23514") throw new ValidationError("invalid trip input (currency or dates)", { sqlstate: c });
  throw e;
};

export class TripsService<T extends Record<string, unknown>> {
  constructor(
    private readonly db: PostgresJsDatabase<T>,
    private readonly repo: TripRepo,
    private readonly members: MembersService,
  ) {}

  /** trip 생성 + 생성자 어드민 멤버십을 **단일 tx**로(멤버십 실패 시 trip 롤백, finding #2 pass1). DB 제약 위반→422(finding #2 pass3). */
  async createTrip(input: CreateTrip, actor: TripActor): Promise<TripResponse> {
    try {
      return await this.db.transaction(async (tx) => {
        const trip = await this.repo.create(input, actor.id, tx);
        await this.members.ensureCreatorMembership(trip.id, actor.id, "Me", actor.email, tx);
        return trip;
      });
    } catch (e) {
      return asValidation(e);
    }
  }
  async listTrips(userId: string): Promise<TripResponse[]> {
    return this.repo.listForUser(userId);
  }
  /** 멤버만 조회(인가는 미들웨어 requireTripMember가 1차, 여기선 존재 확인). */
  async getTrip(id: string): Promise<TripResponse> {
    const t = await this.repo.findById(id);
    if (!t) throw new NotFoundError("trip not found");
    return t;
  }
  /** 수정은 어드민(미들웨어 requireTripMember('admin')가 게이팅). DB 제약 위반→422. */
  async updateTrip(id: string, patch: Partial<CreateTrip>): Promise<TripResponse> {
    let t: TripResponse | null;
    try {
      t = await this.repo.update(id, patch);
    } catch (e) {
      return asValidation(e);
    }
    if (!t) throw new NotFoundError("trip not found");
    return t;
  }
}
```
> **tx 필수(finding #2 pass1):** trip insert + 멤버십을 `db.transaction`으로 감싸 멤버십 실패 시 trip 롤백. **auth-invite의 `MembersService.ensureCreatorMembership`·`MemberRepo.ensureCreatorMembership`에 `tx?: unknown` 인자 추가**(주입 시 `(tx ?? this.db)`로 실행, architecture §4.3 "repo 메서드는 tx 인자"). 멱등(onConflictDoNothing)은 유지. → Task 3에서 두 auth-invite 파일 수정 + 본 Task 테스트에 **실패주입 롤백** 케이스.

**Step 4: 통과 확인** — PASS.

**Step 5: Commit**

```bash
bun run fmt && bun run check
git add src/modules/trips/trips.service.ts src/modules/trips/trips.service.test.ts src/modules/members/members.service.ts src/modules/members/members.repo.ts
git commit -m "feat(trips): TripsService(생성 시 어드민 멤버십 단일 tx·목록·조회·수정) + ensureCreatorMembership tx"
```

---

## Task 4: trips controller — zod-openapi 라우트 (`modules/trips/trips.controller.ts`)

**Files:** Create `src/modules/trips/trips.controller.ts` · Test `src/modules/trips/trips.controller.test.ts`

SSOT: api-contract §2. `POST /trips`·`GET /trips`·`GET /trips/{id}`·`PATCH /trips/{id}`. 미들웨어 requireAuth(+requireTripMember). DTO·errorResponses.

**Step 1: 실패 테스트** (app.request 인메모리 + testcontainers PG + stub 리졸버)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, type Ctx } from "../../../tests/db/helpers.ts";
import { createApp } from "../../core/openapi.ts";
import { DrizzleTripRepo } from "./trips.repo.ts";
import { DrizzleMemberRepo } from "../members/members.repo.ts";
import { MembersService } from "../members/members.service.ts";
import { TripsService } from "./trips.service.ts";
import { registerTripRoutes } from "./trips.controller.ts";
import { registerErrorFilter } from "../../core/errors.ts";
import type { SessionResolver } from "../../core/guards.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

function appFor(userId: string, email = "a@example.com") {
  const app = createApp(); // 422 defaultHook 상속
  registerErrorFilter(app);
  const tripsService = new TripsService(ctx.db, new DrizzleTripRepo(ctx.db), new MembersService(new DrizzleMemberRepo(ctx.db), { ttlHours: 168 }));
  const resolver: SessionResolver = async () => ({ user: { id: userId } });
  const memberLookup = (tripId: string, uid: string) => new DrizzleMemberRepo(ctx.db).findMembership(tripId, uid);
  registerTripRoutes(app, { tripsService, resolver, emailOf: async () => email, memberLookup });
  return app;
}
const body = () => ({
  title: "도쿄", start_date: "2026-08-01", end_date: "2026-08-05",
  destination_countries: ["JP"], timezone: "Asia/Tokyo", primary_local_currency: "JPY", settlement_currency: "KRW",
});

describe("trips 라우트", () => {
  it("POST /trips → 201, GET /trips → 내 trip 1개", async () => {
    const u = await mkUser(ctx.sql);
    const app = appFor(u);
    const created = await app.request("/trips", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body()) });
    expect([200, 201]).toContain(created.status);
    const list = await app.request("/trips");
    expect(((await list.json()) as unknown[]).length).toBe(1);
  });
  it("GET /trips/{id} 비멤버 → 403", async () => {
    const u1 = await mkUser(ctx.sql);
    const u2 = await mkUser(ctx.sql);
    const app1 = appFor(u1);
    const created = await app1.request("/trips", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body()) });
    const id = ((await created.json()) as { id: string }).id;
    const app2 = appFor(u2);
    expect((await app2.request(`/trips/${id}`)).status).toBe(403);
  });
  it("입력 검증 실패(title 빈값) → 422", async () => {
    const u = await mkUser(ctx.sql);
    const res = await appFor(u).request("/trips", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body(), title: "" }) });
    expect(res.status).toBe(422);
  });
  it("멤버 GET·어드민 PATCH happy-path → 200 (finding #1 pass3)", async () => {
    const u = await mkUser(ctx.sql);
    const app = appFor(u);
    const created = await app.request("/trips", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body()) });
    const id = ((await created.json()) as { id: string }).id;
    expect((await app.request(`/trips/${id}`)).status).toBe(200); // 생성자=멤버
    const patched = await app.request(`/trips/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "오사카" }) });
    expect(patched.status).toBe(200); // 생성자=admin
    expect(((await patched.json()) as { title: string }).title).toBe("오사카");
  });
  it("역순 날짜 → 422 problem+json (finding #2 pass3)", async () => {
    const u = await mkUser(ctx.sql);
    const res = await appFor(u).request("/trips", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body(), start_date: "2026-08-09", end_date: "2026-08-01" }) });
    expect(res.status).toBe(422);
  });
  it("미지 통화 → 422(DB FK→ValidationError 매핑) (finding #2 pass3)", async () => {
    const u = await mkUser(ctx.sql);
    const res = await appFor(u).request("/trips", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body(), settlement_currency: "XYZ" }) });
    expect(res.status).toBe(422);
  });
  it("잘못된 달력 날짜(2026-99-99) → 422 (finding #3 pass5)", async () => {
    const u = await mkUser(ctx.sql);
    const res = await appFor(u).request("/trips", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body(), start_date: "2026-99-99" }) });
    expect(res.status).toBe(422);
  });
  it("잘못된 timezone → 422 (finding #3 pass5)", async () => {
    const u = await mkUser(ctx.sql);
    const res = await appFor(u).request("/trips", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body(), timezone: "Mars/Phobos" }) });
    expect(res.status).toBe(422);
  });
});
```

**Step 2: 실패 확인** — FAIL.

**Step 3: 구현** `trips.controller.ts`

```ts
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { requireAuth, requireTripMember, type SessionResolver, type MembershipLookup } from "../../core/guards.ts";
import { errorResponses } from "../../core/http.ts";
import { tripResponseSchema, createTripSchema, updateTripSchema } from "./trips.schema.ts";
import type { TripsService } from "./trips.service.ts";

interface Deps {
  tripsService: TripsService;
  resolver: SessionResolver;
  emailOf: (userId: string) => Promise<string>;
  memberLookup: MembershipLookup;
}

const jsonBody = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } }, required: true });
const ok = (schema: z.ZodTypeAny) => ({ 200: { description: "ok", content: { "application/json": { schema } } } });

export function registerTripRoutes(app: OpenAPIHono, deps: Deps): void {
  const auth = requireAuth(deps.resolver);

  app.openapi(
    createRoute({
      method: "post", path: "/trips", security: [{ cookieAuth: [] }],
      middleware: [auth] as const,
      request: { body: jsonBody(createTripSchema) },
      responses: { ...ok(tripResponseSchema), ...errorResponses(403, 422) },
    }),
    async (c) => {
      const user = c.get("user");
      const trip = await deps.tripsService.createTrip(c.req.valid("json"), { id: user.id, email: await deps.emailOf(user.id) });
      return c.json(trip, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/trips", security: [{ cookieAuth: [] }], middleware: [auth] as const,
      responses: { ...ok(z.array(tripResponseSchema)), ...errorResponses(403) },
    }),
    async (c) => c.json(await deps.tripsService.listTrips(c.get("user").id), 200),
  );

  // 파라미터명은 requireTripMember가 읽는 `tripId`로 통일(finding #1 pass3).
  app.openapi(
    createRoute({
      method: "get", path: "/trips/{tripId}", security: [{ cookieAuth: [] }],
      middleware: [auth, requireTripMember(deps.memberLookup)] as const,
      request: { params: z.object({ tripId: z.string().uuid() }) },
      responses: { ...ok(tripResponseSchema), ...errorResponses(403, 404) },
    }),
    async (c) => c.json(await deps.tripsService.getTrip(c.req.valid("param").tripId), 200),
  );

  app.openapi(
    createRoute({
      method: "patch", path: "/trips/{tripId}", security: [{ cookieAuth: [] }],
      middleware: [auth, requireTripMember(deps.memberLookup, "admin")] as const,
      request: { params: z.object({ tripId: z.string().uuid() }), body: jsonBody(updateTripSchema) },
      responses: { ...ok(tripResponseSchema), ...errorResponses(403, 404, 422) },
    }),
    async (c) => c.json(await deps.tripsService.updateTrip(c.req.valid("param").tripId, c.req.valid("json")), 200),
  );
}
```
> ⚠️ **zod-openapi 1.4.0 검증 포인트**(구현 시 설치 타입으로 확정): ① route `middleware` 필드로 미들웨어 부착이 되는지(아니면 `app.use(path, mw)` 별도). ② path 파라미터명은 **`{tripId}`로 통일**(guards `requireTripMember`가 `c.req.param("tripId")`를 읽음, finding #1 pass3 해소). ③ `c.req.valid("json"|"param")` 타입. ④ 201 대신 200 반환(테스트 `[200,201]` 수용).
> `requireTripMember`의 ContextVariableMap 증강(user·membership)은 guards.ts import로 활성.

**Step 4: 통과 확인** — PASS.

**Step 5: Commit**

```bash
bun run fmt && bun run check
git add src/modules/trips/trips.controller.ts src/modules/trips/trips.controller.test.ts
git commit -m "feat(trips): trips zod-openapi 라우트(POST·GET 목록·GET·PATCH, 인가·DTO)"
```

---

## Task 5: members/invites DTO 스키마 (`modules/members/members.schema.ts`)

**Files:** Create `src/modules/members/members.schema.ts` · Test `src/modules/members/members.schema.test.ts`

SSOT: api-contract §2·§4, auth-invite 설계. 멤버 응답(내부 token_hash 등 omit)·초대 입력·수락 응답.

**Step 1: 실패 테스트**

```ts
import { describe, it, expect } from "vitest";
import { memberResponseSchema, createInviteSchema, acceptResponseSchema, updateMemberSchema } from "./members.schema.ts";

describe("members/invites DTO", () => {
  it("멤버 응답은 공개 필드만(invite_token_hash 없음)", () => {
    const ok = memberResponseSchema.safeParse({ id: "m1", display_name: "철수", role: "member", status: "joined" });
    expect(ok.success).toBe(true);
    expect("invite_token_hash" in memberResponseSchema.shape).toBe(false);
  });
  it("초대 입력은 email·display_name", () => {
    expect(createInviteSchema.safeParse({ email: "g@example.com", display_name: "G" }).success).toBe(true);
    expect(createInviteSchema.safeParse({ email: "bad" }).success).toBe(false);
  });
  it("멤버 수정은 display_name·status(부분), role 없음(admin 양도 제외, finding #4 pass1)", () => {
    expect(updateMemberSchema.safeParse({ display_name: "새이름" }).success).toBe(true);
    expect(updateMemberSchema.safeParse({ status: "deactivated" }).success).toBe(true);
    expect("role" in updateMemberSchema.shape).toBe(false);
  });
});
```

**Step 2: 실패 확인** — FAIL.

**Step 3: 구현** `members.schema.ts`

```ts
import { z } from "@hono/zod-openapi";

export const memberResponseSchema = z
  .object({
    id: z.string(),
    display_name: z.string(),
    role: z.enum(["admin", "member"]),
    status: z.enum(["invited", "joined", "deactivated", "invite_expired"]),
  })
  .openapi("Member");

export const createInviteSchema = z
  .object({ email: z.string().email(), display_name: z.string().min(1).max(60) })
  .openapi("CreateInvite");

export const updateMemberSchema = z
  .object({
    display_name: z.string().min(1).max(60).optional(),
    status: z.enum(["deactivated", "joined"]).optional(), // 비활성/복구. role(=admin 양도)은 후속 트랜잭션 액션(finding #4 pass1)
  })
  .openapi("UpdateMember");

export const acceptResponseSchema = z
  .object({ trip_id: z.string(), role: z.enum(["admin", "member"]), status: z.string() })
  .openapi("AcceptInvite");
```

**Step 4: 통과 확인** — PASS.

**Step 5: Commit**

```bash
bun run fmt && bun run check
git add src/modules/members/members.schema.ts src/modules/members/members.schema.test.ts
git commit -m "feat(members): 멤버/초대 DTO 스키마(응답·초대입력·멤버수정·수락응답)"
```

---

## Task 6: members/invites controller — 프로덕션 라우트 (`modules/members/members.controller.ts`)

**Files:** Modify `src/modules/members/members.controller.ts`(test-only accept → 풀 라우트) · Test `src/modules/members/members.routes.test.ts`

SSOT: api-contract §2(`:verb` 액션). `GET /trips/{tripId}/members` · `PATCH /trips/{tripId}/members/{mid}` · `POST /trips/{tripId}/invites` · `POST /trips/{tripId}/invites/{iid}:resend` · `POST /invites/{token}:accept`. requireTripMember('admin')로 초대/멤버변경 게이팅, accept는 requireAuth만.

**Step 1: 실패 테스트** (app.request + PG; admin 초대 → 멤버 목록 → accept)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, mkTrip, type Ctx } from "../../../tests/db/helpers.ts";
import { createApp } from "../../core/openapi.ts";
import { DrizzleMemberRepo } from "./members.repo.ts";
import { MembersService } from "./members.service.ts";
import { registerMemberRoutes } from "./members.controller.ts";
import { registerErrorFilter } from "../../core/errors.ts";
import type { SessionResolver } from "../../core/guards.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

function appFor(userId: string, email: string) {
  const app = createApp(); // 422 defaultHook 상속
  registerErrorFilter(app);
  const service = new MembersService(new DrizzleMemberRepo(ctx.db), { ttlHours: 168 });
  const resolver: SessionResolver = async () => ({ user: { id: userId } });
  const lookup = (t: string, u: string) => new DrizzleMemberRepo(ctx.db).findMembership(t, u);
  registerMemberRoutes(app, { service, resolver, emailOf: async () => email, memberLookup: lookup });
  return app;
}

describe("members/invites 라우트", () => {
  it("admin이 초대 생성 → 멤버 목록에 invited 표시", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    // admin을 joined admin으로(직접 service)
    await new MembersService(new DrizzleMemberRepo(ctx.db), { ttlHours: 168 }).ensureCreatorMembership(trip, admin, "Admin", "admin@example.com");
    const app = appFor(admin, "admin@example.com");
    const inv = await app.request(`/trips/${trip}/invites`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "g@example.com", display_name: "G" }) });
    expect([200, 201]).toContain(inv.status);
    const members = await app.request(`/trips/${trip}/members`);
    expect(((await members.json()) as unknown[]).length).toBeGreaterThanOrEqual(2);
  });
  it("비-admin 초대 → 403", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const member = await mkUser(ctx.sql);
    const svc = new MembersService(new DrizzleMemberRepo(ctx.db), { ttlHours: 168 });
    await svc.ensureCreatorMembership(trip, admin, "Admin", "admin@example.com");
    // member를 일반 member로
    const { token } = await svc.createInvite(trip, "m@example.com", "M");
    await svc.acceptInvite(token, { id: member, email: "m@example.com" });
    const res = await appFor(member, "m@example.com").request(`/trips/${trip}/invites`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "x@example.com", display_name: "X" }) });
    expect(res.status).toBe(403);
  });
  it("POST /invites/{token}:accept → joined", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const me = await mkUser(ctx.sql);
    const svc = new MembersService(new DrizzleMemberRepo(ctx.db), { ttlHours: 168 });
    await svc.ensureCreatorMembership(trip, admin, "Admin", "admin@example.com");
    const { token } = await svc.createInvite(trip, "join@example.com", "J");
    const res = await appFor(me, "join@example.com").request(`/invites/${token}/accept`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("joined");
  });

  it("다른 trip admin이 교차-trip 초대 회전 시도 → 차단 (finding #1 pass1)", async () => {
    const adminA = await mkUser(ctx.sql);
    const tripA = await mkTrip(ctx.sql, adminA);
    const adminB = await mkUser(ctx.sql);
    const tripB = await mkTrip(ctx.sql, adminB);
    const svc = new MembersService(new DrizzleMemberRepo(ctx.db), { ttlHours: 168 });
    await svc.ensureCreatorMembership(tripA, adminA, "A", "a@example.com");
    await svc.ensureCreatorMembership(tripB, adminB, "B", "b@example.com");
    const cmd = await svc.createInvite(tripB, "guest@example.com", "G"); // tripB의 invite
    // adminA(tripA admin)가 tripA 경로로 tripB의 inviteId resend → trip_id 불일치로 회전 0행 → 차단
    const res = await appFor(adminA, "a@example.com").request(`/trips/${tripA}/invites/${cmd.inviteId}/resend`, { method: "POST" });
    expect([403, 404, 409]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });

  it("invited 멤버를 PATCH로 joined 위조 시도 → 거부 (finding #3 pass3)", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const svc = new MembersService(new DrizzleMemberRepo(ctx.db), { ttlHours: 168 });
    await svc.ensureCreatorMembership(trip, admin, "Admin", "admin@example.com");
    const cmd = await svc.createInvite(trip, "pending@example.com", "P"); // invited row(user_id null)
    const res = await appFor(admin, "admin@example.com").request(`/trips/${trip}/members/${cmd.inviteId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "joined" }),
    });
    expect(res.status).not.toBe(200); // invited→joined는 accept 플로우만(토큰/email CAS)
    expect([403, 404, 409, 422]).toContain(res.status);
  });
});
```

**Step 2: 실패 확인** — FAIL.

**Step 3: 구현** `members.controller.ts`(test-only `registerAcceptRoute` 제거, 풀 `registerMemberRoutes`)

```ts
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { requireAuth, requireTripMember, type SessionResolver, type MembershipLookup } from "../../core/guards.ts";
import { errorResponses } from "../../core/http.ts";
import { memberResponseSchema, createInviteSchema, updateMemberSchema, acceptResponseSchema } from "./members.schema.ts";
import type { MembersService } from "./members.service.ts";

interface Deps {
  service: MembersService;
  resolver: SessionResolver;
  emailOf: (userId: string) => Promise<string>;
  memberLookup: MembershipLookup;
}
const ok = (schema: z.ZodTypeAny) => ({ 200: { description: "ok", content: { "application/json": { schema } } } });
const jsonBody = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } }, required: true });

export function registerMemberRoutes(app: OpenAPIHono, deps: Deps): void {
  const auth = requireAuth(deps.resolver);
  const admin = requireTripMember(deps.memberLookup, "admin");
  const member = requireTripMember(deps.memberLookup);

  // 초대 생성(admin)
  app.openapi(
    createRoute({
      method: "post", path: "/trips/{tripId}/invites", security: [{ cookieAuth: [] }],
      middleware: [auth, admin] as const,
      request: { params: z.object({ tripId: z.string().uuid() }), body: jsonBody(createInviteSchema) },
      responses: { ...ok(z.object({ inviteId: z.string(), link: z.string() }).openapi("InviteCreated")), ...errorResponses(403, 409, 422) },
    }),
    async (c) => {
      const { email, display_name } = c.req.valid("json");
      const cmd = await deps.service.createInvite(c.req.valid("param").tripId, email, display_name);
      return c.json({ inviteId: cmd.inviteId, link: cmd.link }, 200);
    },
  );

  // 멤버 목록(member)
  app.openapi(
    createRoute({
      method: "get", path: "/trips/{tripId}/members", security: [{ cookieAuth: [] }],
      middleware: [auth, member] as const,
      request: { params: z.object({ tripId: z.string().uuid() }) },
      responses: { ...ok(z.array(memberResponseSchema)), ...errorResponses(403) },
    }),
    async (c) => c.json(await deps.service.listMembers(c.req.valid("param").tripId), 200),
  );

  // 멤버 수정(admin) — 비활성·역할 양도·표시이름. last-admin 가드는 service.
  app.openapi(
    createRoute({
      method: "patch", path: "/trips/{tripId}/members/{mid}", security: [{ cookieAuth: [] }],
      middleware: [auth, admin] as const,
      request: { params: z.object({ tripId: z.string().uuid(), mid: z.string().uuid() }), body: jsonBody(updateMemberSchema) },
      responses: { ...ok(memberResponseSchema), ...errorResponses(403, 404, 409, 422) },
    }),
    async (c) => {
      const { tripId, mid } = c.req.valid("param");
      return c.json(await deps.service.updateMember(tripId, mid, c.req.valid("json")), 200);
    },
  );

  // 재발송(admin)
  app.openapi(
    createRoute({
      method: "post", path: "/trips/{tripId}/invites/{iid}/resend", security: [{ cookieAuth: [] }], // 경로-세그먼트(`:resend` 계약표기→`/resend` 런타임, finding #1 pass4)
      middleware: [auth, admin] as const,
      request: { params: z.object({ tripId: z.string().uuid(), iid: z.string().uuid() }) },
      responses: { ...ok(z.object({ link: z.string() }).openapi("InviteResent")), ...errorResponses(403, 404, 409) },
    }),
    async (c) => {
      const { tripId, iid } = c.req.valid("param");
      return c.json({ link: (await deps.service.resendInvite(tripId, iid)).link }, 200); // tripId 스코핑(교차-trip 회전 차단, finding #1 pass1)
    },
  );

  // 수락(인증만 — 토큰=포인터, 권한=email 매칭. tripId 불필요)
  app.openapi(
    createRoute({
      method: "post", path: "/invites/{token}/accept", security: [{ cookieAuth: [] }], // 경로-세그먼트(auth-invite에서 실증, finding #1 pass4)
      middleware: [auth] as const,
      request: { params: z.object({ token: z.string() }) },
      responses: { ...ok(acceptResponseSchema), ...errorResponses(403, 409) },
    }),
    async (c) => {
      const user = c.get("user");
      const email = await deps.emailOf(user.id);
      const row = await deps.service.acceptInvite(c.req.valid("param").token, { id: user.id, email });
      return c.json({ trip_id: row.trip_id, role: row.role as "admin" | "member", status: row.status }, 200);
    },
  );
}
```
> **Task 6에서 auth-invite MembersService/MemberRepo 보강(같은 커밋):**
> - **`resendInvite(tripId, inviteId)`** + **`rotateInviteToken(tripId, inviteId, hash, expiresAt)`의 WHERE에 `trip_id=$tripId` 추가**(finding #1 pass1 — 교차-trip 회전 차단). 0행이면 ConflictError/404. → 교차-trip resend 테스트(다른 trip admin이 회전 시도 → 실패).
> - **`listMembers(tripId)`** = repo 신규 `listByTrip(tripId)`(공개 컬럼).
> - **`updateMember(tripId, mid, patch)`** = **display_name·status(비활성/복구)만**(role 변경=admin 양도 제외, finding #4 pass1). 멤버십 row가 그 trip 소속인지 확인(cross-trip 차단). **admin을 비활성화하면 `assertNotLastAdmin`**(auth-invite §9.5).
>   **전이 제약(finding #3 pass3):** status 변경은 **`user_id`가 바인딩된 행의 `joined↔deactivated`만** 허용. `invited`/`invite_expired`→`joined` **금지**(토큰/email CAS 없이 멤버십 위조 차단 — 그건 accept 플로우 전담). repo update WHERE에 `user_id IS NOT NULL AND status IN ('joined','deactivated')` 포함, 위반 시 ConflictError(409). 테스트: invited row를 PATCH joined 시도 → 거부.
> **액션 라우트 형태 확정(finding #1 pass4·#2 pass5):** Hono/zod-openapi에서 `{param}:verb`는 param을 안 채우므로, **런타임·OpenAPI 경로 모두 `/verb` 세그먼트**(`/invites/{token}/accept`·`.../invites/{iid}/resend`)로 **확정**한다 — auth-invite에서 `c.req.param("token")` 추출 실증. **이 슬라이스의 openapi.json이 FE codegen SSOT이므로 `/accept`·`/resend`가 곧 계약**(deferral 없음). api-contract-design의 `:verb` 표기는 본 슬라이스에서 `/verb`로 정렬됨(설계 doc은 다음 계약-배포 슬라이스에서 표기 갱신, 단 런타임/생성물은 이미 `/verb`로 일관). base64url 토큰은 `[A-Za-z0-9_-]`만이라 세그먼트 안전.

**Step 4: 통과 확인** — PASS.

**Step 5: Commit**

```bash
bun run fmt && bun run check
git add src/modules/members/members.controller.ts src/modules/members/members.routes.test.ts src/modules/members/members.repo.ts src/modules/members/members.service.ts
git commit -m "feat(members): 멤버/초대 프로덕션 라우트(목록·수정·초대·재발송·수락) + listMembers·updateMember"
```

---

## Task 7: buildV1App·main.ts 배선·gen:openapi (무-IO 생성)

**Files:** Create `src/app.ts`(buildV1App) · Modify `src/main.ts` · Create `src/openapi-gen.ts` · Modify `package.json`(`gen:openapi`) · Modify `core/openapi.ts`(security 등록 헬퍼)

SSOT: architecture §3·§4.2, api-contract §1. **`buildV1App(deps)`**: `/v1` basePath·cookieAuth security·모든 모듈 라우트 등록. main(실 deps)·gen:openapi(lazy deps) 공용.

**Step 1: `core/openapi.ts`에 security 등록 추가** (createApp의 defaultHook은 Task 0에서 이미 추가 — **재정의 금지**, registerSecurity만 추가, finding #1 pass2)

```ts
import type { OpenAPIHono } from "@hono/zod-openapi";
// createApp()은 Task 0에서 422 defaultHook 포함. 여기서 재정의하지 말 것(회귀 방지).

/** cookie session security scheme 등록(api-contract §1). 세션 쿠키는 __Host- prefix. */
export function registerSecurity(app: OpenAPIHono): void {
  app.openAPIRegistry.registerComponent("securitySchemes", "cookieAuth", {
    type: "apiKey",
    in: "cookie",
    name: "__Host-better-auth.session_token", // 운영 세션 쿠키명(__Host- 정규화, auth 슬라이스)
  });
}
```
> 정확한 `registerComponent` 시그니처·security scheme 형태는 zod-openapi/@asteasolutions 타입으로 확인.

**Step 2: `src/app.ts` — buildV1App**

```ts
import { type OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { createApp, registerSecurity } from "./core/openapi.ts";
import { csrf } from "./core/csrf.ts";
import { registerErrorFilter } from "./core/errors.ts";
import { registerTripRoutes } from "./modules/trips/trips.controller.ts";
import { registerMemberRoutes } from "./modules/members/members.controller.ts";
import type { TripsService } from "./modules/trips/trips.service.ts";
import type { MembersService } from "./modules/members/members.service.ts";
import type { SessionResolver, MembershipLookup } from "./core/guards.ts";

export interface V1Deps {
  tripsService: TripsService;
  membersService: MembersService;
  resolver: SessionResolver;
  emailOf: (userId: string) => Promise<string>;
  memberLookup: MembershipLookup;
  webOrigins: string[];
}

/** /v1 라우트·security·미들웨어를 등록한 OpenAPIHono 반환. main·gen:openapi 공용(핸들러 미실행 시 무-IO). */
export function buildV1App(deps: V1Deps): OpenAPIHono {
  const v1 = createApp().basePath("/v1") as unknown as OpenAPIHono;
  registerSecurity(v1);
  registerErrorFilter(v1);
  v1.use("*", cors({ origin: deps.webOrigins, credentials: true, allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"], allowHeaders: ["Content-Type"] }));
  v1.use("*", csrf(deps.webOrigins)); // 안전 메서드 bypass·정확 Origin
  registerTripRoutes(v1, { tripsService: deps.tripsService, resolver: deps.resolver, emailOf: deps.emailOf, memberLookup: deps.memberLookup });
  registerMemberRoutes(v1, { service: deps.membersService, resolver: deps.resolver, emailOf: deps.emailOf, memberLookup: deps.memberLookup });
  return v1;
}
```
> ⚠️ `basePath("/v1")` 반환 타입·캐스트는 구현 시 확정(OpenAPIHono.basePath). CSRF·CORS·__Host-는 main에서 마운트 순서 조정 가능. `registerErrorFilter`는 `Hono<any,any,any>` 수용(auth 슬라이스).

**Step 3: `main.ts` — 실 deps 배선** (Better Auth 마운트 + buildV1App를 루트에 마운트)

```ts
import IoRedis from "ioredis";
import { createApp, } from "./core/openapi.ts";
import { createCore } from "./core/composition.ts";
import { enforceHostCookie } from "./core/host-cookie.ts";
import { cors } from "hono/cors";
import { createAuth } from "./auth.ts";
import { mountAuth } from "./modules/auth/mount.ts";
import { authResolver, sessionPrincipal } from "./modules/auth/session.ts";
import { DrizzleTripRepo } from "./modules/trips/trips.repo.ts";
import { DrizzleMemberRepo } from "./modules/members/members.repo.ts";
import { TripsService } from "./modules/trips/trips.service.ts";
import { MembersService } from "./modules/members/members.service.ts";
import { buildV1App } from "./app.ts";

const core = createCore();
const app = createApp();
const auth = createAuth({ db: core.db, redis: new IoRedis(core.config.VALKEY_URL), secret: core.config.BETTER_AUTH_SECRET, baseURL: core.config.BETTER_AUTH_URL, trustedOrigins: core.config.WEB_ORIGINS, useSecureCookies: core.config.USE_SECURE_COOKIES, ...(core.config.GOOGLE_CLIENT_ID && core.config.GOOGLE_CLIENT_SECRET ? { google: { clientId: core.config.GOOGLE_CLIENT_ID, clientSecret: core.config.GOOGLE_CLIENT_SECRET } } : {}) });

// /api/auth (CORS + __Host- 정규화)
app.use("/api/auth/*", cors({ origin: core.config.WEB_ORIGINS, credentials: true }));
app.use("/api/auth/*", enforceHostCookie({ secure: core.config.USE_SECURE_COOKIES }));
mountAuth(app, auth);

// /v1 (계약 라우트)
const memberRepo = new DrizzleMemberRepo(core.db);
const membersService = new MembersService(memberRepo, { ttlHours: core.config.INVITE_TOKEN_TTL_HOURS });
const tripsService = new TripsService(core.db, new DrizzleTripRepo(core.db), membersService); // db 첫 인자(tx용, finding #4 pass2)
const principal = sessionPrincipal(auth);
const emailCache = async (userId: string) => (await core.db.query.user.findFirst({ where: (t, { eq }) => eq(t.id, userId) }))?.email ?? "";
const v1 = buildV1App({ tripsService, membersService, resolver: authResolver(auth), emailOf: emailCache, memberLookup: (t, u) => memberRepo.findMembership(t, u), webOrigins: core.config.WEB_ORIGINS });
app.route("/", v1);

app.get("/health", (c) => c.json({ status: "ok" }));
export default { port: 3000, fetch: app.fetch };
```
> `emailOf`는 세션 principal의 email을 써도 됨(`principal`); DB lookup은 대안. `app.route("/", v1)`로 /v1 마운트. 마운트/미들웨어 순서·`__Host-`는 구현 시 검증.

**Step 4: `src/openapi-gen.ts` — 무-IO 스펙 생성**

```ts
import { writeFileSync } from "node:fs";
import { buildV1App } from "./app.ts";

// **순수 생성(finding #4 pass3):** env/config·createDb·redis·auth 일절 import 안 함.
// 스펙은 라우트 config(스키마)만 읽으므로 service/resolver/lookup은 stub, 핸들러 미실행 → 무-IO. CI/FE codegen에서 env 없이 동작.
const v1 = buildV1App({
  tripsService: {} as never,
  membersService: {} as never,
  resolver: async () => null,
  emailOf: async () => "",
  memberLookup: async () => null,
  webOrigins: ["http://localhost:5173"], // 정적 — env 불요
});
const doc = v1.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "trip-mate API", version: "1.0.0" } });
writeFileSync("openapi.json", JSON.stringify(doc, null, 2));
console.log("openapi.json written:", Object.keys(doc.paths ?? {}).length, "paths");
```
> ⚠️ **config/db/redis import 금지** — `import { env } from "./core/config.ts"`는 import 시점에 production env를 검증해 CI에서 throw. stub deps로 순수 등록만. `getOpenAPI31Document` 시그니처 확인.

`package.json`에 `"gen:openapi": "bun src/openapi-gen.ts"` 추가. `.gitignore`에 `openapi.json`(생성물)? — R2 publish 슬라이스가 정책 결정, 본 슬라이스는 생성 동작만.

**Step 5: 통과 확인·Commit** — `bun run gen:openapi`로 openapi.json 생성(paths>0). **env 미설정 검증(finding #4 pass3):** `env -u DATABASE_URL -u VALKEY_URL -u BETTER_AUTH_SECRET -u WEB_ORIGINS bun run gen:openapi`가 성공·무연결(config 검증 throw 없음). + `bun run check`.

```bash
bun run fmt && bun run check
bun run gen:openapi
git add src/app.ts src/main.ts src/openapi-gen.ts src/core/openapi.ts package.json
git commit -m "feat(api): buildV1App·/v1 배선·gen:openapi(무-IO 스펙 생성)"
```

---

## Task 8: 계약/통합 테스트 (OpenAPI doc·authz·에러)

**Files:** Create `src/openapi-doc.test.ts`(스펙 생성·security·에러스키마) · Create `src/v1-security.test.ts`(buildV1App CSRF/CORS, finding #2 pass4)

**Step 1: 실패 테스트**

```ts
import { describe, it, expect } from "vitest";
import { buildV1App } from "./app.ts";

function docApp() {
  return buildV1App({
    tripsService: {} as never, membersService: {} as never,
    resolver: async () => null, emailOf: async () => "", memberLookup: async () => null,
    webOrigins: ["http://localhost:5173"],
  });
}

describe("OpenAPI 스펙 계약", () => {
  it("핵심 경로 등록(trips·members·invites, /v1 prefix) + 액션 경로 확정(finding #2 pass5)", () => {
    const doc = docApp().getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "1" } });
    const paths = Object.keys(doc.paths ?? {});
    expect(paths.some((p) => p.includes("/v1/trips"))).toBe(true);
    expect(paths.some((p) => p.includes("/members"))).toBe(true);
    // 액션 경로는 /accept·/resend(경로-세그먼트)로 확정 — openapi.json이 FE codegen SSOT
    expect(paths.some((p) => p.includes("/invites/{token}/accept"))).toBe(true);
    expect(paths.some((p) => p.includes("/invites/{iid}/resend"))).toBe(true);
  });
  it("cookieAuth security scheme + Problem 에러 스키마 포함", () => {
    const doc = docApp().getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "1" } });
    expect(doc.components?.securitySchemes?.cookieAuth).toBeDefined();
    expect(doc.components?.schemas?.Problem).toBeDefined();
  });
});
```
> 핸들러 미실행 → service stub(`{} as never`) 안전. 스펙은 라우트 config만 읽음.

**Step 1b: buildV1App 프로덕션 보안 통합테스트** `src/v1-security.test.ts` (finding #2 pass4 — 컨트롤러 직접 마운트가 아닌 **buildV1App 전체 미들웨어 체인** 검증, testcontainers PG)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, type Ctx } from "../tests/db/helpers.ts";
import { DrizzleTripRepo } from "./modules/trips/trips.repo.ts";
import { DrizzleMemberRepo } from "./modules/members/members.repo.ts";
import { TripsService } from "./modules/trips/trips.service.ts";
import { MembersService } from "./modules/members/members.service.ts";
import { buildV1App } from "./app.ts";
import type { SessionResolver } from "./core/guards.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

const ORIGIN = "https://app.ukyi.app";
function v1For(userId: string) {
  const members = new MembersService(new DrizzleMemberRepo(ctx.db), { ttlHours: 168 });
  const trips = new TripsService(ctx.db, new DrizzleTripRepo(ctx.db), members);
  const resolver: SessionResolver = async () => ({ user: { id: userId } });
  return buildV1App({ tripsService: trips, membersService: members, resolver, emailOf: async () => "a@example.com", memberLookup: (t, u) => new DrizzleMemberRepo(ctx.db).findMembership(t, u), webOrigins: [ORIGIN] });
}
const body = () => ({ title: "도쿄", start_date: "2026-08-01", end_date: "2026-08-05", destination_countries: ["JP"], timezone: "Asia/Tokyo", primary_local_currency: "JPY", settlement_currency: "KRW" });

describe("buildV1App 보안 체인(CSRF·CORS, finding #2 pass4)", () => {
  it("정확 Origin mutation → 200 + ACAO/ACAC", async () => {
    const u = await mkUser(ctx.sql);
    const res = await v1For(u).request("/v1/trips", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body()) });
    expect([200, 201]).toContain(res.status);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
  it("형제 Origin mutation → 403(CSRF)", async () => {
    const u = await mkUser(ctx.sql);
    const res = await v1For(u).request("/v1/trips", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.ukyi.app" }, body: JSON.stringify(body()) });
    expect(res.status).toBe(403);
  });
  it("Origin 누락 mutation → 403", async () => {
    const u = await mkUser(ctx.sql);
    const res = await v1For(u).request("/v1/trips", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body()) });
    expect(res.status).toBe(403);
  });
  it("OPTIONS preflight 정확 Origin → ACAO", async () => {
    const u = await mkUser(ctx.sql);
    const res = await v1For(u).request("/v1/trips", { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "POST" } });
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });
});
```
> ⚠️ buildV1App의 미들웨어 순서(CORS→CSRF→라우트)가 mutation 보호를 보장. 안전 메서드(OPTIONS preflight)는 CSRF bypass·CORS 응답. 마운트 순서는 구현 시 검증.

**Step 2: 실패 확인** — FAIL(아직 일부 경로/스키마 누락 시).

**Step 3: 구현** — Task 0~7가 충족. 누락 발견 시 보강.

**Step 4: 통과 확인** — PASS. 전체 `bun run test`.

**Step 5: Commit**

```bash
bun run fmt && bun run check
git add src/openapi-doc.test.ts src/v1-security.test.ts
git commit -m "test(api): OpenAPI 스펙 계약(경로·cookieAuth·Problem) + buildV1App CSRF·CORS 보안"
```

---

## 완료 기준 (DoD)
- [ ] `bun run check` PASS (oxlint+oxfmt+tsc)
- [ ] `bun run test` PASS (기반 159 + API: http·trips(schema·repo·service·controller)·members(schema·routes)·OpenAPI doc)
- [ ] `bun run gen:openapi` → `openapi.json` 생성, **무연결·env 미설정에서도 동작**(config/db/redis import 없음), paths>0·cookieAuth·Problem 스키마 포함
- [ ] **인가 회귀**: 멤버 GET·어드민 PATCH happy-path 200·역순날짜/미지통화 422·교차-trip resend 차단·invited→joined PATCH 위조 거부
- [ ] 신규 마이그레이션 없음(스키마 무변경) — `db:generate` "No schema changes"
- [ ] `git status` clean, 커밋 한국어·AI 마커 없음·허용 type만
- [ ] **인가 회귀 가드**: 비멤버 403·비-admin 초대/수정 403·입력검증 422·problem+json `code`·trip/member 인가, accept 프로덕션 라우트(CORS·CSRF·세션)
- [ ] auth-invite의 test-only accept 라우트 → `/v1` 프로덕션 라우트로 승격(test-only 제거)

## 후속 슬라이스 예고
**FX 통합 슬라이스**(expenses 라우트·resolveFx 저장경로·card_billed·preview·**Idempotency-Key 미들웨어(모든 /v1 mutation 적용·POST /trips 멱등 포함)**·편집 재계산·trip_default 승격) → **정산 슬라이스**(settlement get/precheck·finalize reviewed-set·version·커서·transfers) → **멤버관리 슬라이스**(admin 양도 트랜잭션 액션) → **계약 배포 슬라이스**(R2 openapi.json publish·web Hey API codegen·drift CI·api-contract-design `:verb`→`/verb` 표기 갱신) → 프론트엔드.

---

## Adversarial review dispositions

Codex 적대적 리뷰(working-tree 모드) **5 passes**. **총 18건 finding 전부 Accept**(15건 계획 반영, 3건 스코프-이관 forward-ref: admin 양도·resend 멱등·trip-create 멱등). high 추세 4→4→4(high3)→3(high2)→3, 매 pass 다른 영역(인가→정합성→라우팅/검증→보안테스트→계약/검증)으로 이동하며 수렴. cap은 3패스이나 **사용자 승인으로 pass4·5 연장**, 최종 pass5 verdict는 `needs-attention`(3건)이었고 그중 2건(계약 path 확정·날짜/timezone 검증)을 반영하고 1건(trip-create 멱등)을 known-limitation 문서화한 뒤 **사용자 결정으로 pass6 없이 확정**. 이 섹션은 확정 후 감사추적이며 재리뷰 대상이 아니다.

| pass | # | finding | sev | 결정 | 반영 |
|---|---|---|---|---|---|
| 1 | 1 | resend가 tripId 무시(교차-trip 회전) | high | Accept | `resendInvite(tripId,iid)`·rotate WHERE trip_id·교차-trip 테스트 |
| 1 | 2 | trip 생성 고아(tx 선택적) | high | Accept | 단일 `db.transaction` 필수·ensureCreatorMembership tx·롤백 테스트 |
| 1 | 3 | 422 problem+json 미배선 | high | Accept | createApp `defaultHook`→422 |
| 1 | 4 | admin 양도가 uq_one_admin로 PATCH 불가 | high | **Accept(이관)** | member PATCH=display_name+비활성, **admin 양도는 멤버관리 슬라이스 forward-ref** |
| 2 | 1 | Task7이 422 defaultHook 덮어씀 | high | Accept | Task7은 registerSecurity만, createApp 보존 |
| 2 | 2 | Trip PATCH가 통화 변경 허용 | high | Accept | UpdateTrip 통화 immutable 제외 |
| 2 | 3 | problem+json 미디어타입이 application/json | med | Accept | defaultHook·registerErrorFilter `application/problem+json`·테스트 |
| 2 | 4 | Task7 TripsService 생성자 불일치 | med | Accept | main·gen에 db 첫 인자 |
| 3 | 1 | 라우트 `{id}` vs guard `tripId` | high | Accept | `/trips/{tripId}` 통일·happy-path 테스트 |
| 3 | 2 | 잘못된 trip 입력→DB 500 | high | Accept | Zod refine(날짜)·23503/23514→422 매핑·테스트 |
| 3 | 3 | member PATCH가 invited→joined 위조 | high | Accept | 전이 제약(user_id 바인딩 joined↔deactivated)·테스트 |
| 3 | 4 | gen:openapi가 env+DB 구성 | med | Accept | stub deps·env/createDb 미import 순수·env-미설정 검증 |
| 4 | 1 | `:verb` 액션 라우트 param 미추출 | high | Accept | `/accept`·`/resend` 경로-세그먼트 확정·토큰추출 테스트 |
| 4 | 2 | CSRF/CORS가 프로덕션 app 미검증 | high | Accept | buildV1App 보안 통합테스트(Origin·preflight) |
| 4 | 3 | resend 재시도 멱등 부재 | med | **Accept(이관)** | resend 원자 회전 유지, **재시도 멱등은 Idempotency 슬라이스 forward-ref**(low 실질위험) |
| 5 | 1 | trip 생성 재시도 중복(멱등 없음+DELETE defer) | high | **Accept(이관)** | **known limitation 명시**, Idempotency 인프라 슬라이스가 모든 /v1 mutation 일괄 커버 |
| 5 | 2 | 계약 path drift가 OpenAPI에 baked | high | Accept | `/accept`·`/resend`를 계약으로 **확정**(doc 테스트 정확 경로·deferral 제거) |
| 5 | 3 | trip 검증이 malformed 허용 | high | Accept | `z.iso.date()`·IANA timezone refine·422 테스트 |

**최종 pass5 `summary`:** "retry-created trip duplicates, route contract drift into the generated client surface, malformed trip data." → 계약 path 확정·날짜/timezone 검증으로 2건 해소, trip-create 멱등은 known-limitation으로 Idempotency 인프라 슬라이스에 이관(forward-ref).

---

## Execution directives
- **Skill:** `executing-plans`로 **별도 세션, 이 워크트리**(`~/workspace/trip-mate-api/.worktrees/api-routes`, 브랜치 `feat/api-routes`)에서 task-by-task 구현.
- **연속 실행:** 일상 리뷰로 멈추지 말 것. 진짜 블로커(의존성 부재·반복 실패 검증·모순 지시·치명적 plan 공백)에서만 정지. Docker 데몬 필요(testcontainers PG16). **@hono/zod-openapi 1.4.0 옵션 형태(createRoute middleware·security·`getOpenAPI31Document`·`registerComponent`·defaultHook·`z.iso.date`)는 설치 타입으로 확인**하며, 의미(계약 DTO 경계·422 problem+json·cookie security·/v1·액션 `/verb` 경로)는 고정. strict-TS 함정은 메모리 `trip-mate-api-strict-ts-gotchas` 참조(`res.json()` 캐스트·exactOptional 조건부 spread·OpenAPIHono 변성·DrizzleQueryError.cause.code).
- **커밋 — 직접 적용, `Skill(commit)` 호출 금지:**
  - 한국어 메시지, **AI 마커 금지**(`🤖`·`Co-Authored-By: Claude` 등).
  - 형식 `<type>(<scope>): 한국어 설명`. **type은 `feat`/`fix`/`refactor`/`docs`/`style`/`test`/`chore`만**.
  - 그룹화: 같은 모듈 dir·같은 목적 together; config·테스트·문서·독립 변경은 각자 커밋. 각 Task Commit 스텝에서 현재 `feat/api-routes` 워크트리에 직접.
  - 포맷: 새 .ts 후 `bun run fmt`→`bun run check`. **`&&` 체인 또는 check 통과 확인 후 커밋**(`;` 분리 시 check 실패에도 commit됨).
- **시작점:** Task 0(파운데이션)→8 순서. SSOT 충돌 시 `docs/plans/2026-06-29-api-contract-design.md`(계약) > 본 plan > `auth-invite-design` > `architecture` > PRD. 단 **액션 라우트는 `/accept`·`/resend`로 확정**(이 슬라이스 openapi.json이 codegen SSOT).
