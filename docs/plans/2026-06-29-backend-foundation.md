# trip-mate-api 백엔드 기반 슬라이스 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `trip-mate-api` 레포에 scaffold·툴체인·전체 Drizzle DB 스키마(마이그레이션 포함)·순수 BigInt 정산엔진을 TDD로 구축해 `bun install && bun run check && bun run test`가 green이고 마이그레이션이 깨끗한 PostgreSQL 16에 적용되는 검증된 백엔드 기반을 만든다.

**Architecture:** Bun + Hono 도메인 수직 슬라이스, 수동 컴포지션 루트(DI 라이브러리·데코레이터 없음). 정산 도메인은 IO 없는 순수 함수(BigInt 정수, 결정적). 계약 사슬(Drizzle→drizzle-zod→zod-openapi→Hey API)의 토대만 깔고 라우트/OpenAPI 생성은 후속 슬라이스로 미룬다. 금액은 통화 최소단위 `bigint`, 환율은 `numeric(20,10)`.

**Tech Stack:** Bun · Hono · @hono/zod-openapi · Drizzle ORM + drizzle-kit · postgres(postgres.js) · Better Auth(스키마만) · Zod v4 · vitest + fast-check + testcontainers · oxlint + oxfmt · lefthook.

**SSOT 문서(이 워크트리 `docs/` 안):** `docs/plans/2026-06-29-backend-foundation-design.md`(범위·DoD) · `docs/plans/2026-06-25-trip-mate-db-design.md`(DB 스키마) · `docs/plans/2026-06-25-settlement-engine-design.md`(엔진) · `docs/architecture.md`(컨벤션 §10) · `docs/tech-stack.md` · `docs/plans/2026-06-29-auth-invite-design.md`(Better Auth 스키마). **충돌 시 SSOT 문서가 본 plan보다 우선** — 의심나면 해당 문서 정독.

---

## 진행 원칙 (executing-plans)

- **연속 실행:** 일상 리뷰로 멈추지 말 것. 진짜 블로커(의존성 부재·반복 실패하는 검증·모순된 지시·치명적 plan 공백)에서만 정지.
- **커밋 규약(직접 적용, `Skill(commit)` 호출 금지):** 한국어 메시지, **AI 마커 절대 금지**(`🤖`·`Co-Authored-By: Claude` 등 없음). 형식 `<type>(<scope>): 한국어 설명` (+ 필요 시 `- 상세` 본문). **type은 `feat`/`fix`/`refactor`/`docs`/`style`/`test`/`chore`만.** 커밋은 각 Task의 Commit 스텝에서 현재 `feat/backend-foundation` 워크트리 브랜치에 직접.
- **TDD:** 테스트 먼저 → 실패 확인 → 최소 구현 → 통과 확인 → 커밋.
- **워크트리:** 이미 `feat/backend-foundation`로 격리됨(hardened-planning A.7). **새 워크트리 만들지 말 것.** 모든 경로는 이 워크트리 기준 상대경로.
- **명령 실행 런타임:** 스크립트는 Bun으로 실행(`bun run <script>`). vitest는 `bun run test`(= `vitest run`).
  - ⚠️ **Bun+vitest 호환 헤드업:** Bun에서 vitest 구동이 불안정하면 `bunx vitest run`을 시도하고, 그래도 실패하면 Node로 vitest 실행(`node_modules/.bin/vitest run`)으로 폴백한다. testcontainers 테스트는 Docker 데몬이 필요(없으면 그 테스트만 스킵 처리하지 말고 블로커로 보고).

---

## Out of scope (후속 plan — 이 slice에서 구현하지 않음)

FX 파이프라인 런타임 · Better Auth **런타임/라우트/초대 로직**(스키마만) · HTTP 도메인 라우트 + DTO · OpenAPI 스펙 생성 + R2 publish · Hey API codegen · 프론트엔드 전체(`trip-mate` web) · 홈랩 배포 온보딩(`.app-config.yml`·`Dockerfile`은 파일만 스캐폴드, 실제 배포 안 함) · `expenses.version` bump / audit 트리거(서비스 레이어) · 환불 **기능** 노출(엔진 **의미론·테스트만** 구현). `core/composition.ts`·`core/openapi.ts`는 **스텁**(라우트 등록은 후속).

---

## 빌드 순서 (의존성)

`Task 0 scaffold → 1 도메인 타입/Money → 2~3 정산엔진(순수, infra 불필요) → 4~10 DB 스키마+마이그레이션 → 11 DB 제약 통합테스트`.
(설계 §3 approach A. 정산엔진은 DB에 의존하지 않으므로 testcontainers/Docker 없이 먼저 green을 내고, 인프라 의존 스키마·DB테스트는 뒤에 둔다.)

---

## Task 0: 레포 scaffold + 툴체인

**Files (Create):**
- `package.json` · `tsconfig.json` · `.oxlintrc.json` · `vitest.config.ts` · `lefthook.yml` · `drizzle.config.ts` · `.env.example` · `.app-config.yml` · `Dockerfile` · `.dockerignore`
- `src/core/config.ts` · `src/core/errors.ts` · `src/core/composition.ts` · `src/core/openapi.ts` · `src/main.ts` · `src/db/client.ts`

**Step 1: `package.json`**

```json
{
  "name": "trip-mate-api",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/main.ts",
    "start": "bun src/main.ts",
    "typecheck": "tsc --noEmit",
    "lint": "oxlint",
    "fmt": "oxfmt",
    "fmt:check": "oxfmt --check",
    "check": "oxlint && oxfmt --check && tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:seed": "bun src/db/seed/currencies.ts",
    "auth:generate": "better-auth generate --output src/db/schema/auth-schema.ts --y"
  },
  "dependencies": {
    "hono": "^4.6.0",
    "@hono/zod-openapi": "^1.0.0",
    "zod": "^4.0.0",
    "drizzle-orm": "^0.36.0",
    "postgres": "^3.4.5",
    "better-auth": "^1.2.0",
    "@t3-oss/env-core": "^0.11.0",
    "pino": "^9.5.0"
  },
  "devDependencies": {
    "drizzle-kit": "^0.28.0",
    "drizzle-zod": "^0.5.1",
    "@better-auth/cli": "^1.2.0",
    "vitest": "^2.1.0",
    "fast-check": "^3.23.0",
    "testcontainers": "^10.13.0",
    "@testcontainers/postgresql": "^10.13.0",
    "oxlint": "^0.15.0",
    "oxfmt": "^0.1.0",
    "lefthook": "^1.8.0",
    "typescript": "^5.7.0",
    "@types/node": "^22.0.0"
  }
}
```

> ⚠️ 버전은 핀 기준 예시다. `bun install` 후 실제 해석 버전을 확인하고, 다음 제약을 만족해야 한다: **`@hono/zod-openapi` v1.x ↔ Zod v4 ↔ drizzle-zod(Zod v4 경로)** 정합(architecture §3). **oxfmt는 신생** — 설치 실패/미동작 시 Prettier로 폴백하고 `package.json` 스크립트의 `oxfmt`를 `prettier --check .`/`prettier --write .`로 교체(architecture §10.6). 정합이 안 맞으면 블로커로 보고.

**Step 2: `tsconfig.json`** (architecture §10.6 — 데코레이터 OFF)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "experimentalDecorators": false,
    "emitDecoratorMetadata": false,
    "types": ["node"],
    "lib": ["ES2023"]
  },
  "include": ["src", "tests", "*.ts"]
}
```

**Step 3: `.oxlintrc.json`** (kebab 파일명 + dot-suffix 허용)

```json
{
  "$schema": "https://raw.githubusercontent.com/oxc-project/oxc/main/npm/oxlint/configuration_schema.json",
  "rules": {
    "unicorn/filename-case": ["error", { "case": "kebabCase", "ignore": ["\\.[a-z]+\\.ts$"] }]
  },
  "ignorePatterns": ["src/db/schema/auth-schema.ts", "src/db/migrations/**", "node_modules/**"]
}
```

**Step 4: `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 60_000, // testcontainers 기동 여유
    hookTimeout: 120_000,
  },
})
```

**Step 5: `drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  casing: 'snake_case',
})
```

**Step 6: `lefthook.yml`**

```yaml
pre-commit:
  parallel: true
  commands:
    lint:
      run: bun run lint
    fmt:
      run: bun run fmt:check
pre-push:
  commands:
    typecheck:
      run: bun run typecheck
    test:
      run: bun run test
```

**Step 7: `.env.example`**

```dotenv
DATABASE_URL=postgres://trip:trip@localhost:5432/trip_mate
BETTER_AUTH_SECRET=dev-only-change-me
BETTER_AUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

**Step 8: `src/core/errors.ts`** (AppError 계층 — architecture §4.5)

```ts
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message?: string,
    readonly meta?: unknown,
  ) {
    super(message ?? code)
    this.name = new.target.name
  }
}
export class NotFoundError extends AppError {
  constructor(message?: string, meta?: unknown) { super('NotFoundError', 404, message, meta) }
}
export class ForbiddenError extends AppError {
  constructor(message?: string, meta?: unknown) { super('ForbiddenError', 403, message, meta) }
}
export class ConflictError extends AppError {
  constructor(message?: string, meta?: unknown) { super('ConflictError', 409, message, meta) }
}
export class ValidationError extends AppError {
  constructor(message?: string, meta?: unknown) { super('ValidationError', 422, message, meta) }
}
export class SettlementInvariantError extends AppError {
  constructor(message?: string, meta?: unknown) { super('SettlementInvariantError', 422, message, meta) }
}
```

**Step 9: `src/core/config.ts`** (Zod 검증 env — @t3-oss/env-core)

```ts
import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
    BETTER_AUTH_SECRET: z.string().min(1),
    BETTER_AUTH_URL: z.string().url(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
})
```

**Step 10: `src/db/client.ts`**

```ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema/index.ts'

export function createDb(url: string) {
  const sql = postgres(url)
  return drizzle(sql, { schema, casing: 'snake_case' })
}
export type DB = ReturnType<typeof createDb>
```

**Step 11: `src/core/composition.ts`** (스텁 — 라우트 후속)

```ts
import pino from 'pino'
import { createDb, type DB } from '../db/client.ts'
import { env } from './config.ts'

export interface Core { db: DB; logger: pino.Logger; config: typeof env }

export function createCore(): Core {
  return { db: createDb(env.DATABASE_URL), logger: pino(), config: env }
}
```

**Step 12: `src/core/openapi.ts`** (스텁)

```ts
import { OpenAPIHono } from '@hono/zod-openapi'

export function createApp() {
  return new OpenAPIHono()
}
```

**Step 13: `src/main.ts`** (Bun serve — /health만)

```ts
import { createApp } from './core/openapi.ts'

const app = createApp()
app.get('/health', (c) => c.json({ status: 'ok' }))

export default { port: 3000, fetch: app.fetch }
```

**Step 14: `.app-config.yml`·`Dockerfile`·`.dockerignore`** (스캐폴드만 — 온보딩 안 함)

`.app-config.yml`:
```yaml
kind: service
```
`Dockerfile`:
```dockerfile
FROM oven/bun:1-alpine AS base
WORKDIR /app
COPY package.json bun.lock bun.lockb* ./
RUN bun install --frozen-lockfile --production
COPY . .
EXPOSE 3000
CMD ["bun", "src/main.ts"]
```
`.dockerignore`:
```
node_modules
.worktrees
docs
*.test.ts
.env
.env.*
!.env.example
```
> ⚠️ **finding #2(pass2):** `.env`/`.env.*`를 반드시 `.dockerignore`에 둔다 — Task 0이 로컬 `.env`를 만들고 Dockerfile이 `COPY . .`이므로, 없으면 향후 `docker build`가 dev 시크릿·DB URL을 이미지에 굽는다(gitignore돼도 빌드 컨텍스트엔 포함됨).

**Step 15: 검증**

Run: `cp .env.example .env`
Expected: `.env` 생성. **Bun이 `.env`를 자동 로드**하므로 이후 `auth:generate`·`db:migrate`·`db:seed`·`dev`가 결정적 env로 동작한다(finding #2 — 재현 가능 env 경로 확보). `.env`는 gitignore됨(`.gitignore`의 `.env`/`!.env.example`).

Run: `bun install`
Expected: lockfile 생성, 0 errors. (정합 경고는 Step 1 ⚠️ 따라 처리)

Run: `bun run typecheck`
Expected: PASS (0 errors). ⚠️ `src/db/schema/index.ts` 부재로 `client.ts`가 깨지면, **임시로** `src/db/schema/index.ts`에 `export {}` 빈 파일을 만들어 통과시키고 Task 4에서 채운다.

Run: `bun run check`
Expected: oxlint PASS · oxfmt --check PASS · tsc PASS.

Run: `bun src/main.ts &` 후 `curl -s localhost:3000/health`
Expected: `{"status":"ok"}` → 서버 종료(`kill %1`).

**Step 16: Commit**

```bash
git add -A
git commit -m "chore(scaffold): trip-mate-api 레포 scaffold·툴체인·core 스텁

- Bun+Hono+Drizzle, tsconfig strict(데코레이터 OFF), oxlint/oxfmt, vitest, lefthook
- core/{config,errors,composition,openapi} 스텁 + main.ts(/health)"
```

---

## Task 1: 도메인 타입 + Money VO (TDD)

**Files:**
- Create: `src/core/money.ts`
- Test: `src/core/money.test.ts`

근거: architecture §10.3 (브랜디드 타입 / Money VO). 통화·단위·id 혼동을 컴파일러가 차단, 엔진은 Money/Minor로 동작.

**Step 1: 실패 테스트 `src/core/money.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { add, money, type CurrencyCode } from './money.ts'
import { SettlementInvariantError } from './errors.ts'

describe('Money VO', () => {
  it('같은 통화는 합산된다', () => {
    const a = money(100n, 'KRW')
    const b = money(250n, 'KRW')
    expect(add(a, b).amount).toBe(350n)
    expect(add(a, b).currency).toBe('KRW' as CurrencyCode)
  })
  it('다른 통화 합산은 SettlementInvariantError', () => {
    expect(() => add(money(100n, 'KRW'), money(1n, 'USD'))).toThrow(SettlementInvariantError)
  })
})
```

**Step 2: 실패 확인** — Run: `bun run test src/core/money.test.ts` · Expected: FAIL (money.ts 없음).

**Step 3: 구현 `src/core/money.ts`**

```ts
import { SettlementInvariantError } from './errors.ts'

type Brand<T, B> = T & { readonly __brand: B }
export type TripId = Brand<string, 'TripId'>
export type MemberId = Brand<string, 'MemberId'>
export type ExpenseId = Brand<string, 'ExpenseId'>
export type CurrencyCode = Brand<string, 'CurrencyCode'>
export type Minor = Brand<bigint, 'Minor'>

export interface Money { readonly amount: Minor; readonly currency: CurrencyCode }

export const minor = (n: bigint): Minor => n as Minor
export const money = (amount: bigint, currency: string): Money => ({
  amount: amount as Minor,
  currency: currency as CurrencyCode,
})

export const add = (a: Money, b: Money): Money => {
  if (a.currency !== b.currency) throw new SettlementInvariantError('currency mismatch in add')
  return { amount: (a.amount + b.amount) as Minor, currency: a.currency }
}
```

**Step 4: 통과 확인** — Run: `bun run test src/core/money.test.ts` · Expected: PASS.

**Step 5: Commit**

```bash
git add src/core/money.ts src/core/money.test.ts
git commit -m "feat(core): 브랜디드 타입·Money VO 추가 (동일통화 가드)"
```

---

## Task 2: 정산엔진 — splitExpense (지출별 분배, TDD)

**Files:**
- Create: `src/modules/settlements/domain/compute.ts`
- Test: `src/modules/settlements/domain/compute.test.ts`

SSOT: `docs/plans/2026-06-25-settlement-engine-design.md` §2. **BigInt 0방향 절삭을 -∞ floor로 보정**(음수/환불 잔여 불변식). 잔여는 member_id asc 앞에서부터 +1.

**Step 1: 실패 테스트 (명시 케이스 + property)** — `compute.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { splitExpense } from './compute.ts'
import { minor, type MemberId } from '../../../core/money.ts'

const M = (s: string) => s as MemberId
const sum = (m: Map<MemberId, bigint>) => [...m.values()].reduce((a, b) => a + b, 0n)

describe('splitExpense', () => {
  it('나눠떨어짐: 9000/3 = 3000씩', () => {
    const r = splitExpense(minor(9000n), [M('a'), M('b'), M('c')])
    expect([...r.values()]).toEqual([3000n, 3000n, 3000n])
  })
  it('안나눠짐: 10000/3 → 잔여 1을 member_id asc 첫 1명에', () => {
    const r = splitExpense(minor(10000n), [M('c'), M('a'), M('b')])
    expect(r.get(M('a'))).toBe(3334n)
    expect(r.get(M('b'))).toBe(3333n)
    expect(r.get(M('c'))).toBe(3333n)
  })
  it('음수(환불) -10000/3 → -3333/-3333/-3334', () => {
    const r = splitExpense(minor(-10000n), [M('a'), M('b'), M('c')])
    expect(r.get(M('a'))).toBe(-3333n)
    expect(r.get(M('b'))).toBe(-3333n)
    expect(r.get(M('c'))).toBe(-3334n)
  })
  it('n=1: 전액', () => {
    expect(splitExpense(minor(777n), [M('a')]).get(M('a'))).toBe(777n)
  })
  it('참여자 0명은 에러', () => {
    expect(() => splitExpense(minor(100n), [])).toThrow()
  })
  it('property: Σ분배 == amount (양·음수)', () => {
    fc.assert(fc.property(
      fc.bigInt({ min: -10_000_000n, max: 10_000_000n }),
      fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 8 }),
      (amount, ids) => {
        const r = splitExpense(minor(amount), ids.map(M))
        return sum(r) === amount
      },
    ))
  })
})
```

**Step 2: 실패 확인** — Run: `bun run test src/modules/settlements/domain/compute.test.ts` · Expected: FAIL (compute.ts 없음).

**Step 3: 구현 `compute.ts`** (splitExpense + floorDiv)

```ts
import { type MemberId, type Minor } from '../../../core/money.ts'
import { SettlementInvariantError } from '../../../core/errors.ts'

export const byIdAsc = (a: MemberId, b: MemberId): number => (a < b ? -1 : a > b ? 1 : 0)

/** b > 0 가정. BigInt '/'는 0방향 절삭 → -∞ floor로 보정. */
export function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b
  const r = a % b
  return r !== 0n && r < 0n ? q - 1n : q
}

export function splitExpense(amount: Minor, members: readonly MemberId[]): Map<MemberId, Minor> {
  if (members.length === 0) throw new SettlementInvariantError('expense has no participants')
  const n = BigInt(members.length)
  const base = floorDiv(amount, n)
  const remainder = amount - base * n // 0 <= remainder < n (음수에도 성립)
  const sorted = [...members].sort(byIdAsc)
  const out = new Map<MemberId, Minor>()
  sorted.forEach((m, i) => out.set(m, (base + (BigInt(i) < remainder ? 1n : 0n)) as Minor))
  let s = 0n
  for (const v of out.values()) s += v
  if (s !== amount) throw new SettlementInvariantError('split sum != amount')
  return out
}
```

**Step 4: 통과 확인** — Run: same · Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/settlements/domain/compute.ts src/modules/settlements/domain/compute.test.ts
git commit -m "feat(settlements): splitExpense 분배 산식 (-∞ floor, member_id asc 잔여)"
```

---

## Task 3: 정산엔진 — minTransfers (최소 송금, TDD)

**Files:** Modify `src/modules/settlements/domain/compute.ts` · Test 추가 `compute.test.ts`

SSOT: 엔진 설계 §4. greedy(금액 desc·동률 id asc), ≤(n−1)건, 결정적.

**Step 1: 실패 테스트 추가**

```ts
import { minTransfers } from './compute.ts'

describe('minTransfers', () => {
  it('단순: a +100, b -100 → b→a 100', () => {
    const net = new Map<MemberId, bigint>([[M('a'), 100n], [M('b'), -100n]])
    const t = minTransfers(net as Map<MemberId, any>, 'KRW' as any)
    expect(t).toEqual([{ from: M('b'), to: M('a'), amount: 100n, currency: 'KRW' }])
  })
  it('순환채무 정리 후 transfers ≤ n-1, from≠to, amount>0', () => {
    const net = new Map<MemberId, bigint>([[M('a'), 50n], [M('b'), 30n], [M('c'), -80n]])
    const t = minTransfers(net as any, 'KRW' as any)
    expect(t.length).toBeLessThanOrEqual(2)
    for (const x of t) { expect(x.from).not.toBe(x.to); expect(x.amount > 0n).toBe(true) }
    // round-trip: transfer 적용 시 전원 0
    const acc = new Map(net)
    for (const x of t) { acc.set(x.to, acc.get(x.to)! - x.amount); acc.set(x.from, acc.get(x.from)! + x.amount) }
    expect([...acc.values()].every((v) => v === 0n)).toBe(true)
  })
})
```

**Step 2: 실패 확인** — Run test · Expected: FAIL (minTransfers 없음).

**Step 3: 구현 (compute.ts에 추가)**

```ts
import { type CurrencyCode } from '../../../core/money.ts'

export interface Transfer { from: MemberId; to: MemberId; amount: Minor; currency: CurrencyCode }

export function minTransfers(net: Map<MemberId, Minor>, currency: CurrencyCode): Transfer[] {
  const cred = [...net.entries()].filter(([, v]) => v > 0n)
    .map(([id, amt]) => ({ id, amt }))
    .sort((a, b) => (b.amt !== a.amt ? (b.amt > a.amt ? 1 : -1) : byIdAsc(a.id, b.id)))
  const debt = [...net.entries()].filter(([, v]) => v < 0n)
    .map(([id, amt]) => ({ id, amt: -amt }))
    .sort((a, b) => (b.amt !== a.amt ? (b.amt > a.amt ? 1 : -1) : byIdAsc(a.id, b.id)))
  const out: Transfer[] = []
  let i = 0
  let j = 0
  while (i < cred.length && j < debt.length) {
    const c = cred[i]!
    const d = debt[j]!
    const give = c.amt < d.amt ? c.amt : d.amt
    out.push({ from: d.id, to: c.id, amount: give as Minor, currency })
    c.amt = (c.amt - give) as Minor
    d.amt = (d.amt - give) as Minor
    if (c.amt === 0n) i++
    if (d.amt === 0n) j++
  }
  return out
}
```

**Step 4: 통과 확인** — Run test · Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/settlements/domain/compute.ts src/modules/settlements/domain/compute.test.ts
git commit -m "feat(settlements): minTransfers greedy 최소 송금 (≤n-1, 결정적)"
```

---

## Task 4: 정산엔진 — computeSettlement 집계·이중축 (TDD)

**Files:** Modify `compute.ts` · Test 추가

SSOT: 엔진 설계 §1·§3·§5. 입력 expenses(+참여자)에서 멤버별 `total_paid/total_share/net` 집계(`Σnet==0`), settlement 축(1통화) + local 축(통화별 독립). **이 Task는 환불 미포함(refund_of 없는 입력).**

**Step 1: 실패 테스트 추가**

```ts
import { computeSettlement, type ExpenseInput } from './compute.ts'
import { money } from '../../../core/money.ts'

const exp = (o: Partial<ExpenseInput> & Pick<ExpenseInput,'id'|'paid_by'|'participants'|'local'|'settlement'>): ExpenseInput => o as ExpenseInput

describe('computeSettlement (환불 없음)', () => {
  it('3인 균등: a가 9000 KRW 결제, 셋이 분담 → a +6000, b/c -3000', () => {
    const r = computeSettlement({
      members: [M('a'), M('b'), M('c')],
      expenses: [exp({
        id: 'e1' as any, paid_by: M('a'), participants: [M('a'), M('b'), M('c')],
        local: money(9000n, 'KRW'), settlement: money(9000n, 'KRW'),
      })],
    })
    const byMember = Object.fromEntries(r.settlement.summaries.map((s) => [s.member, s.net]))
    expect(byMember[M('a')]).toBe(6000n)
    expect(byMember[M('b')]).toBe(-3000n)
    expect(byMember[M('c')]).toBe(-3000n)
    expect(r.settlement.summaries.reduce((a, s) => a + s.net, 0n)).toBe(0n) // Σnet==0
    expect(r.settlement.total).toBe(9000n)
  })

  it('결제자가 참여자가 아님(대납): paid_by=a, participants=[b,c]', () => {
    const r = computeSettlement({
      members: [M('a'), M('b'), M('c')],
      expenses: [exp({ id: 'e1' as any, paid_by: M('a'), participants: [M('b'), M('c')],
        local: money(1000n, 'KRW'), settlement: money(1000n, 'KRW') })],
    })
    const by = Object.fromEntries(r.settlement.summaries.map((s) => [s.member, s.net]))
    expect(by[M('a')]).toBe(1000n); expect(by[M('b')]).toBe(-500n); expect(by[M('c')]).toBe(-500n)
  })

  it('local 다통화 독립 서브축', () => {
    const r = computeSettlement({
      members: [M('a'), M('b')],
      expenses: [
        exp({ id: 'e1' as any, paid_by: M('a'), participants: [M('a'), M('b')], local: money(1000n,'JPY'), settlement: money(9320n,'KRW') }),
        exp({ id: 'e2' as any, paid_by: M('b'), participants: [M('a'), M('b')], local: money(100n,'THB'), settlement: money(3790n,'KRW') }),
      ],
    })
    expect(Object.keys(r.local).sort()).toEqual(['JPY', 'THB'])
    expect(r.local['JPY']!.total).toBe(1000n)
    expect(r.local['THB']!.total).toBe(100n)
  })

  it('property: 임의 입력에서 Σnet==0 (settlement·local 모든 축)', () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        amount: fc.bigInt({ min: 1n, max: 1_000_000n }),
        payer: fc.integer({ min: 0, max: 4 }),
        parts: fc.uniqueArray(fc.integer({ min: 0, max: 4 }), { minLength: 1, maxLength: 5 }),
      }), { minLength: 1, maxLength: 20 }),
      (rows) => {
        const members = [M('m0'),M('m1'),M('m2'),M('m3'),M('m4')]
        const expenses = rows.map((row, k) => exp({
          id: `e${k}` as any, paid_by: members[row.payer]!,
          participants: row.parts.map((p) => members[p]!),
          local: money(row.amount, 'KRW'), settlement: money(row.amount, 'KRW'),
        }))
        const r = computeSettlement({ members, expenses })
        const s = r.settlement.summaries.reduce((a, x) => a + x.net, 0n)
        return s === 0n
      },
    ))
  })

  it('property: 결정성 — 입력 순서를 셔플해도 동일 transfers', () => {
    const members = [M('a'),M('b'),M('c'),M('d')]
    const base: ExpenseInput[] = [
      exp({ id:'e1' as any, paid_by:M('a'), participants:[M('a'),M('b'),M('c')], local:money(1000n,'KRW'), settlement:money(1000n,'KRW') }),
      exp({ id:'e2' as any, paid_by:M('b'), participants:[M('b'),M('c'),M('d')], local:money(2000n,'KRW'), settlement:money(2000n,'KRW') }),
      exp({ id:'e3' as any, paid_by:M('d'), participants:members, local:money(700n,'KRW'), settlement:money(700n,'KRW') }),
    ]
    const r1 = computeSettlement({ members, expenses: base })
    const r2 = computeSettlement({ members, expenses: [...base].reverse() })
    expect(r1.settlement.transfers).toEqual(r2.settlement.transfers)
  })
})
```

**Step 2: 실패 확인** — Run test · Expected: FAIL.

**Step 3: 구현 (compute.ts에 추가)**

```ts
import { type Money, add as _addUnused } from '../../../core/money.ts'

export interface ExpenseInput {
  id: ExpenseId
  paid_by: MemberId
  participants: MemberId[] // ≥1 (검증됨)
  local: Money
  settlement: Money // settlement.currency = trip 정산통화(단일)
  refund_of?: ExpenseId
}
export interface Summary { member: MemberId; total_paid: Minor; total_share: Minor; net: Minor }
export interface AxisResult { transfers: Transfer[]; summaries: Summary[]; total: Minor }
export interface SettlementResult { settlement: AxisResult; local: Record<string, AxisResult> }

/** 한 통화축: expenses(같은 통화) → 멤버별 집계 + 최소송금. amountOf로 축(local/settlement) 금액 선택. */
function computeAxis(
  members: MemberId[],
  expenses: ExpenseInput[],
  currency: CurrencyCode,
  amountOf: (e: ExpenseInput) => Minor,
): AxisResult {
  const paid = new Map<MemberId, bigint>(members.map((m) => [m, 0n]))
  const share = new Map<MemberId, bigint>(members.map((m) => [m, 0n]))
  let total = 0n
  for (const e of expenses) {
    const amt = amountOf(e)
    total += amt
    paid.set(e.paid_by, (paid.get(e.paid_by) ?? 0n) + amt)
    const s = splitExpense(amt, e.participants)
    for (const [m, v] of s) share.set(m, (share.get(m) ?? 0n) + v)
  }
  const summaries: Summary[] = members.map((m) => {
    const tp = (paid.get(m) ?? 0n) as Minor
    const ts = (share.get(m) ?? 0n) as Minor
    return { member: m, total_paid: tp, total_share: ts, net: (tp - ts) as Minor }
  })
  let netSum = 0n
  const net = new Map<MemberId, Minor>()
  for (const s of summaries) { netSum += s.net; net.set(s.member, s.net) }
  if (netSum !== 0n) throw new SettlementInvariantError('Σnet != 0')
  return { transfers: minTransfers(net, currency), summaries, total: total as Minor }
}

export function computeSettlement(input: { expenses: ExpenseInput[]; members: MemberId[] }): SettlementResult {
  // 이 Task: refund_of 없는 입력만. (환불은 Task 5에서 확장)
  const settlementCurrency = input.expenses[0]?.settlement.currency
  // settlement 축: 모든 지출이 동일 정산통화여야 함
  for (const e of input.expenses) {
    if (settlementCurrency && e.settlement.currency !== settlementCurrency) {
      throw new SettlementInvariantError('mixed settlement currency')
    }
  }
  const settlement = computeAxis(
    input.members, input.expenses,
    (settlementCurrency ?? ('KRW' as CurrencyCode)),
    (e) => e.settlement.amount,
  )
  // local 축: 통화별 독립
  const byCurrency = new Map<string, ExpenseInput[]>()
  for (const e of input.expenses) {
    const c = e.local.currency
    if (!byCurrency.has(c)) byCurrency.set(c, [])
    byCurrency.get(c)!.push(e)
  }
  const local: Record<string, AxisResult> = {}
  for (const [c, es] of byCurrency) {
    local[c] = computeAxis(input.members, es, c as CurrencyCode, (e) => e.local.amount)
  }
  return { settlement, local }
}
```

> `_addUnused` import는 제거(린트). 위 스니펫에서 실제 필요한 import만 남길 것.

**Step 4: 통과 확인** — Run test · Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/settlements/domain/compute.ts src/modules/settlements/domain/compute.test.ts
git commit -m "feat(settlements): computeSettlement 멤버 집계·이중축(settlement+local 통화별)"
```

---

## Task 5: 정산엔진 — 환불 미러링 (TDD, 의미론만)

**Files:** Modify `compute.ts` · Test 추가

SSOT: 엔진 설계 §6 (D2 하이브리드, pass1~2 정밀화). **링크 환불(`refund_of`)은 원지출 단위 누적 apportionment로 share를 미러**, paid는 원 결제자에 음수 집계. 검증: 환불 음수·원지출 양수·통화 일치·`refund.paid_by==original.paid_by`·누적|R|≤원액. 위반 시 `ValidationError`. 원지출 부재(입력 닫힘 위반)면 `SettlementInvariantError`. **기능 노출 아님 — 엔진 의미론·테스트만.**

**Step 1: 실패 테스트 추가**

```ts
// compute.test.ts 상단 import에 추가 (finding #1 pass5 — 메시지 정규식 대신 클래스 단언):
//   import { ValidationError, SettlementInvariantError } from '../../../core/errors.ts'
describe('환불 미러링', () => {
  const orig = (id: string, payer: string, parts: string[], amt: bigint): ExpenseInput =>
    exp({ id: id as any, paid_by: M(payer), participants: parts.map(M), local: money(amt,'KRW'), settlement: money(amt,'KRW') })
  const refund = (id: string, of: string, payer: string, parts: string[], amt: bigint): ExpenseInput =>
    exp({ id: id as any, refund_of: of as any, paid_by: M(payer), participants: parts.map(M), local: money(amt,'KRW'), settlement: money(amt,'KRW') })

  it('전액 환불 → 전원 net 0 (원지출+환불)', () => {
    const r = computeSettlement({ members:[M('a'),M('b'),M('c')], expenses:[
      orig('e1','a',['a','b','c'],100n),
      refund('r1','e1','a',['a','b','c'],-100n),
    ]})
    expect(r.settlement.summaries.every((s) => s.net === 0n)).toBe(true)
    expect(r.settlement.transfers).toEqual([]) // phantom 송금 없음
  })

  it('다중 분할 환불 합성 = 원 split 정확 미러 (phantom 0)', () => {
    // 원 100 → 34/33/33. -50 두 번 → 누적 -100 == -원split
    const r = computeSettlement({ members:[M('a'),M('b'),M('c')], expenses:[
      orig('e1','a',['a','b','c'],100n),
      refund('r1','e1','a',['a','b','c'],-50n),
      refund('r2','e1','a',['a','b','c'],-50n),
    ]})
    expect(r.settlement.summaries.every((s) => s.net === 0n)).toBe(true)
  })

  it('부분 환불 -50 → 잔여 apportionment (소수부 desc·id asc)', () => {
    const r = computeSettlement({ members:[M('a'),M('b'),M('c')], expenses:[
      orig('e1','a',['a','b','c'],100n),       // share 34/33/33
      refund('r1','e1','a',['a','b','c'],-50n), // cumShare -17/-17/-16
    ]})
    const share = Object.fromEntries(r.settlement.summaries.map((s) => [s.member, s.total_share]))
    expect(share[M('a')]).toBe(34n - 17n)
    expect(share[M('b')]).toBe(33n - 17n)
    expect(share[M('c')]).toBe(33n - 16n)
  })

  it('over-refund(누적>원액) → ValidationError', () => {
    expect(() => computeSettlement({ members:[M('a'),M('b')], expenses:[
      orig('e1','a',['a','b'],100n),
      refund('r1','e1','a',['a','b'],-150n),
    ]})).toThrow(ValidationError)
  })

  it('refund.paid_by != original.paid_by → ValidationError', () => {
    expect(() => computeSettlement({ members:[M('a'),M('b')], expenses:[
      orig('e1','a',['a','b'],100n),
      refund('r1','e1','b',['a','b'],-50n),
    ]})).toThrow(ValidationError)
  })

  it('원지출 부재(입력 닫힘 위반) → SettlementInvariantError', () => {
    expect(() => computeSettlement({ members:[M('a'),M('b')], expenses:[
      refund('r1','eX','a',['a','b'],-50n),
    ]})).toThrow(SettlementInvariantError)
  })
})
```

**Step 2: 실패 확인** — Run test · Expected: FAIL.

**Step 3: 구현 — `computeSettlement`/`computeAxis`에 환불 처리 결합**

엔진 설계 §6.1 누적 apportionment 헬퍼 추가 + 축 집계에서 환불을 원지출에 합성:

```ts
/** |R|을 origShare 가중으로 정수 apportion (floor + largest-remainder, 소수부 desc·id asc). 부호 음수로 반환. */
function apportionRefund(
  absR: bigint,
  origShare: Map<MemberId, Minor>,
  absOrig: bigint,
): Map<MemberId, bigint> {
  const entries = [...origShare.entries()] // [member, share>=0 가정 양수 분배]
  const base = new Map<MemberId, bigint>()
  const frac = new Map<MemberId, bigint>() // 분자(소수부 비교용): absR*share mod absOrig
  let assigned = 0n
  for (const [m, sh] of entries) {
    const num = absR * (sh as bigint)
    base.set(m, num / absOrig)
    frac.set(m, num % absOrig)
    assigned += num / absOrig
  }
  let remainder = absR - assigned // 0 <= remainder < entries.length
  const order = [...entries.map(([m]) => m)].sort((a, b) => {
    const fb = frac.get(b)! - frac.get(a)!
    return fb !== 0n ? (fb > 0n ? 1 : -1) : byIdAsc(a, b)
  })
  const out = new Map<MemberId, bigint>()
  for (const m of order) {
    const bonus = remainder > 0n ? 1n : 0n
    if (remainder > 0n) remainder -= 1n
    out.set(m, -(base.get(m)! + bonus)) // 음수
  }
  return out
}
```

`computeAxis`를 환불 인지하도록 변경 — 시그니처에 환불 그룹을 받거나, `computeSettlement`에서 사전 분리 후 "합성 지출" 형태로 축에 투입. 권장 구현: `computeSettlement`가 (1) 원지출/환불 분리·검증, (2) 각 축에서 일반 지출은 splitExpense, 환불 그룹은 apportionRefund로 share 기여를 더하고 paid는 환불행 음수를 원결제자에 더한다.

```ts
// computeSettlement 내부 (refund 처리 버전):
function computeAxisWithRefunds(
  members: MemberId[],
  normal: ExpenseInput[],           // refund_of 없는 지출
  refundGroups: Map<ExpenseId, { original: ExpenseInput; refunds: ExpenseInput[] }>,
  currency: CurrencyCode,
  amountOf: (e: ExpenseInput) => Minor,
): AxisResult {
  const paid = new Map<MemberId, bigint>(members.map((m) => [m, 0n]))
  const share = new Map<MemberId, bigint>(members.map((m) => [m, 0n]))
  let total = 0n
  for (const e of normal) {
    const amt = amountOf(e); total += amt
    paid.set(e.paid_by, (paid.get(e.paid_by) ?? 0n) + amt)
    for (const [m, v] of splitExpense(amt, e.participants)) share.set(m, (share.get(m) ?? 0n) + v)
  }
  for (const { original, refunds } of refundGroups.values()) {
    const oAmt = amountOf(original); total += oAmt
    paid.set(original.paid_by, (paid.get(original.paid_by) ?? 0n) + oAmt)
    const oShare = splitExpense(oAmt, original.participants)
    for (const [m, v] of oShare) share.set(m, (share.get(m) ?? 0n) + v)
    let R = 0n
    for (const rf of refunds) {
      const rAmt = amountOf(rf); total += rAmt; R += rAmt
      paid.set(rf.paid_by, (paid.get(rf.paid_by) ?? 0n) + rAmt) // 음수
    }
    const cum = apportionRefund(-R, oShare as Map<MemberId, Minor>, oAmt < 0n ? -oAmt : oAmt)
    for (const [m, v] of cum) share.set(m, (share.get(m) ?? 0n) + v)
  }
  const summaries: Summary[] = members.map((m) => {
    const tp = (paid.get(m) ?? 0n) as Minor; const ts = (share.get(m) ?? 0n) as Minor
    return { member: m, total_paid: tp, total_share: ts, net: (tp - ts) as Minor }
  })
  let netSum = 0n; const net = new Map<MemberId, Minor>()
  for (const s of summaries) { netSum += s.net; net.set(s.member, s.net) }
  if (netSum !== 0n) throw new SettlementInvariantError('Σnet != 0')
  return { transfers: minTransfers(net, currency), summaries, total: total as Minor }
}
```

`computeSettlement`에 환불 분리·검증 추가:

```ts
function partitionAndValidate(expenses: ExpenseInput[], amountOf: (e: ExpenseInput) => Minor) {
  const byId = new Map(expenses.map((e) => [e.id, e]))
  const normal: ExpenseInput[] = []
  const groups = new Map<ExpenseId, { original: ExpenseInput; refunds: ExpenseInput[] }>()
  for (const e of expenses) {
    if (e.refund_of === undefined) { normal.push(e); continue }
    const original = byId.get(e.refund_of)
    if (!original || original.refund_of !== undefined) throw new SettlementInvariantError('refund input not closed')
    if (e.local.currency !== original.local.currency || e.settlement.currency !== original.settlement.currency)
      throw new ValidationError('refund currency mismatch')
    if (e.paid_by !== original.paid_by) throw new ValidationError('refund payer must equal original payer')
    if (amountOf(e) >= 0n) throw new ValidationError('refund amount must be negative')
    if (amountOf(original) <= 0n) throw new ValidationError('original amount must be positive')
    if (!groups.has(original.id)) groups.set(original.id, { original, refunds: [] })
    groups.get(original.id)!.refunds.push(e)
  }
  // normal에서 원지출은 빼고(그룹으로 이동), 그룹 없는 원지출은 normal 유지
  const grouped = new Set([...groups.keys()])
  const onlyNormal = normal.filter((e) => !grouped.has(e.id))
  for (const g of groups.values()) {
    const cum = g.refunds.reduce((a, r) => a + amountOf(r), 0n) // 음수
    if (-cum > amountOf(g.original)) throw new ValidationError('over-refund: cumulative > original')
  }
  return { onlyNormal, groups }
}
```

그리고 `computeSettlement`에서 settlement 축·local 축 각각 `partitionAndValidate` + `computeAxisWithRefunds` 사용하도록 Task 4의 `computeAxis` 호출을 교체. (settlement 축은 단일 통화 전제 유지, local 축은 통화별 그룹 후 각 통화에서 partition.)

> 검증 순서 주의: over-refund는 절대값 누적(`-cum`)으로 판정. apportionRefund의 `absOrig`는 원지출 절대값. 음수 원지출은 위 검증에서 차단되므로 `oAmt>0` 보장.

**Step 4: 통과 확인** — Run: `bun run test src/modules/settlements/domain/compute.test.ts` · Expected: PASS (모든 환불 케이스).

**Step 5: 전체 엔진 회귀** — Run: `bun run test` · Expected: PASS (Task 1~5 전부).

**Step 6: Commit**

```bash
git add src/modules/settlements/domain/compute.ts src/modules/settlements/domain/compute.test.ts
git commit -m "feat(settlements): 환불 미러링 (원지출 단위 누적 apportionment, 의미론·테스트)"
```

---

## Task 6: DB 스키마 — enums + 공통 헬퍼 + currencies(+seed)

**Files (Create):** `src/db/schema/_shared.ts` · `src/db/schema/enums.ts` · `src/db/schema/currencies.ts` · `src/db/seed/currencies.ts`

SSOT: DB 설계 §2·§3·§4·§48. 안정 enum=`pgEnum`, 진화 enum=text+CHECK.

**Step 1: `_shared.ts`**

```ts
import { uuid, timestamp } from 'drizzle-orm/pg-core'

export const pk = () => uuid('id').defaultRandom().primaryKey()
export const timestamps = {
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}
```

**Step 2: `enums.ts`**

```ts
import { pgEnum } from 'drizzle-orm/pg-core'

export const roleEnum = pgEnum('role', ['admin', 'member'])
export const memberStatusEnum = pgEnum('member_status', ['invited', 'joined', 'deactivated', 'invite_expired'])
export const settlementStatusEnum = pgEnum('settlement_status', ['open', 'finalized'])
export const snapshotStatusEnum = pgEnum('snapshot_status', ['active', 'superseded'])
export const paymentStatusEnum = pgEnum('payment_status', ['pending', 'paid'])
export const basisEnum = pgEnum('basis', ['settlement', 'local'])
export const amountSourceEnum = pgEnum('settlement_amount_source', ['card_billed', 'converted'])
export const rateSourceEnum = pgEnum('exchange_rate_source', ['identity', 'manual', 'auto', 'last_known', 'trip_default'])
export const expenseStateEnum = pgEnum('expense_settlement_state', ['included', 'personal', 'record_only'])
// 진화 enum은 text + CHECK (input_source·category·payment_method·change_type) — 각 테이블에서 CHECK로 강제
```

**Step 3: `currencies.ts`**

```ts
import { pgTable, text, integer, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const currencies = pgTable('currencies', {
  code: text('code').primaryKey(),
  iso_exponent: integer('iso_exponent').notNull(),
  minor_unit: integer('minor_unit').notNull(),
  symbol: text('symbol').notNull(),
}, (t) => [check('currency_code_len', sql`length(${t.code}) = 3`)])
```

**Step 4: `seed/currencies.ts`** (§48 표, TWD minor=0)

```ts
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { currencies } from '../schema/currencies.ts'
import { env } from '../../core/config.ts'

const ROWS = [
  { code: 'KRW', iso_exponent: 0, minor_unit: 0, symbol: '₩' },
  { code: 'JPY', iso_exponent: 0, minor_unit: 0, symbol: '¥' },
  { code: 'VND', iso_exponent: 0, minor_unit: 0, symbol: '₫' },
  { code: 'TWD', iso_exponent: 2, minor_unit: 0, symbol: 'NT$' },
  { code: 'USD', iso_exponent: 2, minor_unit: 2, symbol: '$' },
  { code: 'EUR', iso_exponent: 2, minor_unit: 2, symbol: '€' },
  { code: 'THB', iso_exponent: 2, minor_unit: 2, symbol: '฿' },
  { code: 'GBP', iso_exponent: 2, minor_unit: 2, symbol: '£' },
  { code: 'CHF', iso_exponent: 2, minor_unit: 2, symbol: 'Fr' },
]
export async function seedCurrencies(db: PostgresJsDatabase<Record<string, never>>) {
  await db.insert(currencies).values(ROWS).onConflictDoNothing()
}

// CLI: 클라이언트 소유 + finally에서 종료 (postgres.js는 sql.end() 전까지 프로세스 유지 → seed 행 방지, finding #3)
if (import.meta.main) {
  const sql = postgres(env.DATABASE_URL)
  try {
    await seedCurrencies(drizzle(sql, { casing: 'snake_case' }))
  } finally {
    await sql.end()
  }
}
```

**Step 5: 검증·Commit** — `bun run typecheck` PASS. (마이그레이션은 Task 10에서 일괄.)

```bash
git add src/db/schema/_shared.ts src/db/schema/enums.ts src/db/schema/currencies.ts src/db/seed/currencies.ts
git commit -m "feat(db): enum·공통 헬퍼·currencies 룩업(+9통화 seed, TWD minor=0)"
```

---

## Task 7: DB 스키마 — Better Auth (cli generate, 스키마만)

**Files (Create):** `src/auth.ts`(최소 설정) · `src/db/schema/auth-schema.ts`(생성물)

SSOT: auth-invite 설계 §1·§7. **런타임 배선 아님** — `cli generate`가 Drizzle 스키마를 뽑게 하는 최소 설정만. `user.id=uuid`, `account unique(provider_id, account_id)`, 이메일 링킹 금지.

**Step 1: `src/auth.ts` (최소)**

```ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { createDb } from './db/client.ts'
import { env } from './core/config.ts'

// cli generate용 최소 설정 (라우트 핸들러 마운트는 후속 인증 slice)
export const auth = betterAuth({
  database: drizzleAdapter(createDb(env.DATABASE_URL), { provider: 'pg' }),
  advanced: { database: { generateId: 'uuid' } },
  account: { accountLinking: { enabled: false } },
  socialProviders: {
    google: { clientId: env.GOOGLE_CLIENT_ID ?? '', clientSecret: env.GOOGLE_CLIENT_SECRET ?? '' },
  },
})
```

**Step 2: 스키마 생성** — **전제: Task 0의 `.env` 존재**(없으면 `cp .env.example .env`). `auth.ts`가 `core/config.ts`(createEnv 검증)를 import하므로 `.env` 없이는 import 시점에 throw해 생성이 실패한다(finding #2). Run: `bun run auth:generate`
Expected: `src/db/schema/auth-schema.ts`에 `user`/`account`/`session`/`verification` 테이블 생성. (실패 시 `.env` 유무부터 확인)

**Step 3: 불변식 보강(1회, 영구) — 생성-후 하드닝 + 재생성 경고 (finding #1 pass4)**

`auth-schema.ts`를 **생성 직후 1회** 하드닝하고, 이 파일은 그 시점부터 **소스로 취급**(이후 `auth:generate` 재실행 금지 — 재실행하면 하드닝이 지워진다). 하드닝은 **drizzle 스키마 정의에 반영**되므로 Task 10의 `db:generate`가 이를 마이그레이션에 자연 포함한다(별도 마이그레이션 불필요).
- `account` 테이블 정의에 `uniqueIndex('uq_account_provider').on(t.providerId, t.accountId)` 추가(auth 설계 pass2 — 이메일 링킹 금지). cli가 이미 동등 unique를 넣었으면 중복 생성 말 것.
- `user.id`가 uuid 타입인지 확인(generateId='uuid'). 텍스트면 FK 호환 위해 uuid로 맞춤.
- **파일 헤더에 재생성 경고 주석**을 단다:
  ```ts
  // ⚠️ 생성-후 하드닝됨(account uq_account_provider · user.id uuid). auth:generate 재실행 금지 —
  //    재실행 시 이 하드닝을 반드시 재적용할 것. (backend-foundation plan finding #1)
  ```

> auth-schema.ts는 생성물이므로 oxlint ignore(Task 0 `.oxlintrc.json`에 포함). import 확장자 규칙도 제외. **DoD는 auth:generate를 재실행하지 않는다**(Step 5의 `git status` clean으로 drift만 확인).

**Step 4: 검증·Commit** — `bun run typecheck` PASS.

```bash
git add src/auth.ts src/db/schema/auth-schema.ts
git commit -m "feat(db): Better Auth 스키마 생성(user/account/session/verification, account unique 보강)

- cli generate 산출, 런타임 배선은 인증 slice"
```

---

## Task 8: DB 스키마 — trips + trip_members

**Files (Create):** `src/db/schema/trips.ts` · `src/db/schema/members.ts`

SSOT: DB 설계 §5. **DB 설계 §5의 Drizzle 코드를 그대로** 옮긴다(아래는 핵심 — 부분 유니크·CHECK·composite FK 타깃 UNIQUE 포함). `user` 참조는 `auth-schema.ts`의 `user.id`.

**Step 1: `trips.ts`** (DB 설계 §5 trips 블록 그대로)

```ts
import { pgTable, uuid, text, date, timestamp, check, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { pk, timestamps } from './_shared.ts'
import { currencies } from './currencies.ts'
import { settlementStatusEnum } from './enums.ts'
import { user } from './auth-schema.ts'

export const trips = pgTable('trips', {
  id: pk(),
  title: text().notNull(),
  start_date: date().notNull(),
  end_date: date().notNull(),
  destination_countries: text().array().notNull(),
  timezone: text().notNull(),
  primary_local_currency: text().notNull().references(() => currencies.code),
  settlement_currency: text().notNull().references(() => currencies.code),
  created_by_user_id: uuid().notNull().references(() => user.id),
  settlement_status: settlementStatusEnum().notNull().default('open'),
  finalized_at: timestamp({ withTimezone: true }),
  ...timestamps,
}, (t) => [
  check('trip_dates', sql`${t.start_date} <= ${t.end_date}`),
  uniqueIndex('uq_trip_settlement_ccy').on(t.id, t.settlement_currency),
  index('ix_trip_creator').on(t.created_by_user_id),
])
```

**Step 2: `members.ts`** (DB 설계 §5 trip_members 블록 그대로 — 부분 유니크 5종)

```ts
import { pgTable, uuid, text, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { pk, timestamps } from './_shared.ts'
import { trips } from './trips.ts'
import { user } from './auth-schema.ts'
import { roleEnum, memberStatusEnum } from './enums.ts'

export const tripMembers = pgTable('trip_members', {
  id: pk(),
  trip_id: uuid().notNull().references(() => trips.id, { onDelete: 'cascade' }),
  user_id: uuid().references(() => user.id),
  invited_email: text().notNull(),
  normalized_invited_email: text().notNull(),
  invite_token_hash: text(),
  invite_token_expires_at: timestamp({ withTimezone: true }),
  display_name: text().notNull(),
  role: roleEnum().notNull().default('member'),
  status: memberStatusEnum().notNull().default('invited'),
  joined_at: timestamp({ withTimezone: true }),
  ...timestamps,
}, (t) => [
  uniqueIndex('uq_member_email').on(t.trip_id, t.normalized_invited_email),
  uniqueIndex('uq_member_user').on(t.trip_id, t.user_id),
  uniqueIndex('uq_one_admin').on(t.trip_id).where(sql`role = 'admin' AND status = 'joined'`),
  uniqueIndex('uq_member_trip_id').on(t.trip_id, t.id),
  uniqueIndex('uq_invite_token').on(t.invite_token_hash).where(sql`invite_token_hash IS NOT NULL`),
  index('ix_member_user').on(t.user_id),
])
```

**Step 3: 검증·Commit** — `bun run typecheck` PASS.

```bash
git add src/db/schema/trips.ts src/db/schema/members.ts
git commit -m "feat(db): trips·trip_members (부분유니크 5종, composite FK 타깃 UNIQUE)"
```

---

## Task 9: DB 스키마 — expenses + participants + audit / settlements 묶음

**Files (Create):** `src/db/schema/expenses.ts` · `src/db/schema/settlements.ts`

SSOT: DB 설계 §6·§7. **DB 설계 문서의 Drizzle 코드를 그대로** 옮긴다 — `fx_by_source`·`refund_self` CHECK, same-trip composite FK 전부(`foreignKey({columns,foreignColumns})`), `expense_participants` 복합 PK, settlements/transfers/summaries/currency_totals의 CHECK·부분유니크·composite FK. (분량이 크므로 본 plan은 출처를 가리킨다: **`docs/plans/2026-06-25-trip-mate-db-design.md` §6·§7의 코드 블록을 1:1로 작성**. 컬럼·인덱스·제약을 누락 없이.)

**text+CHECK 값 정의(진화 enum — 이름 부여해 introspection으로 검증, finding #1):** DB 설계는 이 값들을 "Phase마다 증가"로 미열거했으므로 MVP(Phase 1) 값 집합을 여기서 확정한다(코드값 저장, 표시는 i18n).
- `expenses.payment_method` → `check('payment_method_check', sql\`... IN ('cash','card','transit_card','easy_pay','other')\`)` (PRD §12.1)
- `expenses.category` → `check('category_check', sql\`... IN ('food','cafe_snack','transport','lodging','shopping','sightseeing','convenience','other')\`)` (PRD §33)
- `expenses.input_source` → `check('input_source_check', sql\`... IN ('manual','ai_oneline','card_sms','receipt','card_capture')\`)` (PRD §22.2)
- `expense_audit_logs.change_type` → `check('change_type_check', sql\`... IN ('create','update','delete','restore')\`)` (DB §8)

**핵심 체크리스트(구현 후 grep 확인 + Task 11 introspection이 강제):**
- `expenses`: `exchange_rate numeric({precision:20,scale:10})`, `exchange_rate_source` nullable, provenance 3컬럼, `fx_by_source` CHECK, `refund_self` CHECK, 위 3개 text+CHECK, composite FK 4종(paid_by·created_by·last_modified_by·settlement_currency) + refund composite FK, `uq_expense_trip_id`, `ix_exp_*` 인덱스.
- `expense_participants`: `primaryKey(expense_id, member_id)`, composite FK 2종(`onDelete:'cascade'` for expense), `ix_part_member`.
- `expense_audit_logs`: append-only(`updated_at` 없음), composite FK 2종, `change_type` CHECK IN.
- `settlements`: `uq_settlement_active`(partial), `uq_settlement_version`, `uq_settlement_trip_id`, composite FK finalized_by.
- `settlement_transfers`: CHECK 3종(`transfer_amount_pos`·`transfer_distinct`·`paid_consistency`) + `local_not_tracked`, composite FK(settlement·from·to·marked_by), `uq_transfer_pair`.
- `settlement_member_summaries`: `uq_summary`, composite FK.
- `settlement_currency_totals`: `primaryKey(settlement_id, currency)`.

**Step: 검증·Commit** — `bun run typecheck` PASS.

> ⚠️ **완성도 게이트(finding #1):** typecheck는 생성될 SQL에 모든 CHECK·부분유니크·composite FK가 실제로 들어갔는지 증명하지 못한다. **이 스키마는 Task 11의 introspection 테스트가 통과해야 비로소 완성으로 간주**한다. Task 11이 누락 객체를 보고하면 이 Task로 돌아와 추가한다(커밋은 Task 11에서 게이트). 위 체크리스트는 그 introspection의 기대 목록과 1:1 대응한다.

```bash
git add src/db/schema/expenses.ts src/db/schema/settlements.ts
git commit -m "feat(db): expenses·participants·audit·settlements·transfers·summaries·currency_totals (composite FK·CHECK·부분유니크)"
```

---

## Task 10: relations + index + 마이그레이션 생성·적용

**Files (Create):** `src/db/schema/relations.ts` · `src/db/schema/index.ts` · (생성) `src/db/migrations/*`

**Step 1: `relations.ts`** — drizzle `relations()` 중앙화(trips↔members↔expenses↔settlements 관계). 최소한 FK 기반 관계 선언(목록 조회용). DB 설계 §4.3 "relations 중앙화".

**Step 2: `index.ts`** — 모든 스키마 re-export:

```ts
export * from './enums.ts'
export * from './currencies.ts'
export * from './auth-schema.ts'
export * from './trips.ts'
export * from './members.ts'
export * from './expenses.ts'
export * from './settlements.ts'
export * from './relations.ts'
```
(Task 0의 임시 `export {}`가 있었다면 교체.)

**Step 3: 마이그레이션 생성** — Run: `bun run db:generate`
Expected: `src/db/migrations/0000_*.sql` 생성, 0 errors.

**Step 4: composite FK 타깃 UNIQUE 선생성 순서 검증** — 생성된 SQL을 열어 `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY (trip_id, ...)`가 참조 대상 `UNIQUE(trip_id, id)`(및 `trips UNIQUE(id, settlement_currency)`) **생성 이후**에 오는지 확인. 순서가 어긋나 적용 실패하면 SQL 내 문장 순서를 수동 조정(타깃 UNIQUE → FK).

**Step 5: 마이그레이션 적용 검증(로컬/임시 PG)** — Docker 가용 시 **재시도 안전**하게(finding #2 pass3 — 실패해도 정리·재실행 항상 clean):
```bash
docker rm -f tmpg 2>/dev/null || true                 # stale 컨테이너 선제거(이전 실패 잔류 방지)
trap 'docker rm -f tmpg 2>/dev/null || true' EXIT      # 마이그레이션/시드 실패해도 항상 정리
docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=trip -e POSTGRES_USER=trip -e POSTGRES_DB=trip_mate --name tmpg postgres:16
until docker exec tmpg pg_isready -U trip >/dev/null 2>&1; do sleep 1; done   # ready 대기
DATABASE_URL=postgres://trip:trip@localhost:5433/trip_mate bun run db:migrate
DATABASE_URL=postgres://trip:trip@localhost:5433/trip_mate bun run db:seed
# trap이 EXIT 시 tmpg 제거 → 마이그레이션 SQL 편집 후 재실행은 항상 새 컨테이너로 clean 시작.
```
Expected: 마이그레이션·시드 0 errors. **마이그레이션 실패 시:** trap이 컨테이너를 제거하므로 SQL 수정 후 위 블록을 그대로 재실행하면 clean DB에서 다시 적용된다(부분 적용 상태 잔류 없음). (canonical 검증은 Task 11 testcontainers — 동적 포트라 포트 충돌 무관. 이 docker smoke는 보조 수동 확인.)

**Step 6: 생성 idempotency 확인 + Commit** (finding #1 pass4 — 생성기는 여기서 1회만, DoD에서 재실행 안 함)

Run: `bun run db:generate` (재실행) · Expected: **"No schema changes" / 새 마이그레이션 파일 0** — 커밋될 마이그레이션이 (하드닝된) 스키마와 정확히 일치함을 증명.
Run: `git status --short` · Expected: 생성기 재실행 후 **uncommitted drift 0** (산출물=생성결과).

```bash
git add src/db/schema/relations.ts src/db/schema/index.ts src/db/migrations
git commit -m "feat(db): relations·index·초기 마이그레이션(composite FK 타깃 UNIQUE 선생성 순서 검증)"
```

---

## Task 11: DB 제약 통합테스트 (testcontainers PG16)

**Files (Create):** `tests/db/helpers.ts` · `tests/db/schema-introspection.test.ts` · `tests/db/constraints.test.ts`

SSOT: 설계 §3.5. 하드닝된 DB 불변식이 실제로 막는지 검증. **Docker 데몬 필요**(없으면 블로커 보고). finding #1 반영: typecheck로는 증명 못 하는 "스키마 객체 존재"를 introspection으로, "불변식 강제"를 negative-insert로 **이중 검증**.

**Step 1: `tests/db/helpers.ts`** — PG16 컨테이너 기동 + 마이그레이션 + 시드 + 세션 라이프사이클(vitest `beforeAll`/`afterAll`).

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import * as schema from '../../src/db/schema/index.ts'
import { seedCurrencies } from '../../src/db/seed/currencies.ts'

export async function startDb() {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16').start()
  const sql = postgres(container.getConnectionUri())
  const db = drizzle(sql, { schema, casing: 'snake_case' })
  await migrate(db, { migrationsFolder: './src/db/migrations' })
  await seedCurrencies(db as any)
  return { container, sql, db }
}
```

**Step 1b: 스키마 introspection 테스트 `tests/db/schema-introspection.test.ts`** (finding #1 — 모든 named 제약/인덱스/FK 존재를 SSOT와 1:1로 강제)

마이그레이션 적용된 DB의 `pg_catalog`/`pg_indexes`를 조회해 **기대 객체가 전부 존재**하는지 단언한다. 하나라도 누락이면 실패 → Task 9로 회귀해 추가. (Task 9 체크리스트 = 이 기대 목록.)

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startDb } from './helpers.ts'

let ctx: Awaited<ReturnType<typeof startDb>>
beforeAll(async () => { ctx = await startDb() })
afterAll(async () => { await ctx.sql.end(); await ctx.container.stop() })

const CHECKS = [
  'currency_code_len', 'trip_dates', 'fx_by_source', 'refund_self',
  'payment_method_check', 'category_check', 'input_source_check', 'change_type_check',
  'transfer_amount_pos', 'transfer_distinct', 'paid_consistency', 'local_not_tracked',
]
const INDEXES = [
  'uq_trip_settlement_ccy', 'ix_trip_creator',
  'uq_member_email', 'uq_member_user', 'uq_one_admin', 'uq_member_trip_id', 'uq_invite_token', 'ix_member_user',
  'ix_exp_trip_spent', 'ix_exp_paid_by', 'ix_exp_created_by', 'ix_exp_settle', 'uq_expense_trip_id', 'ix_exp_refund',
  'ix_part_member', 'ix_audit_expense', 'ix_audit_trip',
  'uq_settlement_active', 'uq_settlement_version', 'uq_settlement_trip_id', 'ix_settlement_finalizer',
  'uq_transfer_pair', 'ix_transfer_settlement', 'ix_transfer_from', 'ix_transfer_to',
  'uq_summary', 'ix_summary_settlement', 'ix_summary_member',
]
// auto-name FK는 정의(pg_get_constraintdef) 부분일치로 검증
const FK_DEFS = [
  'FOREIGN KEY (trip_id, paid_by_member_id) REFERENCES trip_members(trip_id, id)',
  'FOREIGN KEY (trip_id, created_by_member_id) REFERENCES trip_members(trip_id, id)',
  'FOREIGN KEY (trip_id, last_modified_by_member_id) REFERENCES trip_members(trip_id, id)',
  'FOREIGN KEY (trip_id, settlement_currency) REFERENCES trips(id, settlement_currency)',
  'FOREIGN KEY (trip_id, refund_of_expense_id) REFERENCES expenses(trip_id, id)',
  'FOREIGN KEY (trip_id, expense_id) REFERENCES expenses(trip_id, id)',
  'FOREIGN KEY (trip_id, member_id) REFERENCES trip_members(trip_id, id)',
  'FOREIGN KEY (trip_id, changed_by_member_id) REFERENCES trip_members(trip_id, id)',
  'FOREIGN KEY (trip_id, finalized_by_member_id) REFERENCES trip_members(trip_id, id)',
  'FOREIGN KEY (trip_id, settlement_id) REFERENCES settlements(trip_id, id)',
  'FOREIGN KEY (trip_id, from_member_id) REFERENCES trip_members(trip_id, id)',
  'FOREIGN KEY (trip_id, to_member_id) REFERENCES trip_members(trip_id, id)',
  'FOREIGN KEY (trip_id, marked_by_member_id) REFERENCES trip_members(trip_id, id)',
]

describe('schema introspection (SSOT 객체 존재)', () => {
  it('모든 named CHECK 제약 존재', async () => {
    const rows = await ctx.sql`select conname from pg_constraint where contype='c'`
    const names = new Set(rows.map((r: any) => r.conname))
    for (const c of CHECKS) expect(names, `missing CHECK ${c}`).toContain(c)
  })
  it('모든 named 인덱스 존재', async () => {
    const rows = await ctx.sql`select indexname from pg_indexes where schemaname='public'`
    const names = new Set(rows.map((r: any) => r.indexname))
    for (const i of INDEXES) expect(names, `missing index ${i}`).toContain(i)
  })
  it('모든 same-trip composite FK 정의 존재', async () => {
    const rows = await ctx.sql`select pg_get_constraintdef(oid) as def from pg_constraint where contype='f'`
    const defs = rows.map((r: any) => r.def.replace(/"/g, ''))
    for (const fk of FK_DEFS) expect(defs.some((d: string) => d.includes(fk)), `missing FK: ${fk}`).toBe(true)
  })
  it('복합 PK 존재 (expense_participants·settlement_currency_totals)', async () => {
    const rows = await ctx.sql`select conrelid::regclass::text as tbl, pg_get_constraintdef(oid) as def from pg_constraint where contype='p'`
    const find = (t: string) => (rows.find((r: any) => r.tbl === t)?.def ?? '').replace(/"/g, '')
    expect(find('expense_participants')).toContain('PRIMARY KEY (expense_id, member_id)')
    expect(find('settlement_currency_totals')).toContain('PRIMARY KEY (settlement_id, currency)')
  })
  it('account(provider_id, account_id) 유니크 존재 (이메일 링킹 금지 — auth 설계 §1)', async () => {
    const rows = await ctx.sql`select indexdef from pg_indexes where schemaname='public' and tablename='account'`
    const ok = rows.some((r: any) => /UNIQUE/i.test(r.indexdef) && /provider_id/.test(r.indexdef) && /account_id/.test(r.indexdef))
    expect(ok, 'account unique(provider_id, account_id) missing').toBe(true)
  })

  // ── 의미론 검증 (finding #1 pass3): 이름만으로는 over-broad 정의가 통과한다
  it('부분유니크 WHERE 술어 정확 (over-broad UNIQUE 차단)', async () => {
    const rows = await ctx.sql`select indexname, indexdef from pg_indexes where schemaname='public'`
    const def = (n: string) => (rows.find((r: any) => r.indexname === n)?.indexdef ?? '')
    expect(def('uq_one_admin')).toMatch(/WHERE .*role.* = .*'admin'.* AND .*status.* = .*'joined'/s)
    expect(def('uq_settlement_active')).toMatch(/WHERE .*status.* = .*'active'/s)
    expect(def('uq_invite_token')).toMatch(/WHERE .*invite_token_hash.* IS NOT NULL/s)
  })
  it('cascade ON DELETE 정확 — 테이블별 명시 (일부 누락 통과 방지, finding #2 pass5)', async () => {
    // confdeltype='c' = ON DELETE CASCADE. child→parent를 각각 단언(대표 some 금지).
    const rows = await ctx.sql`
      select conrelid::regclass::text as child, confrelid::regclass::text as parent, confdeltype
      from pg_constraint where contype='f'`
    const cascades = rows
      .filter((r: any) => r.confdeltype === 'c')
      .map((r: any) => `${r.child.replace(/^public\./, '')}->${r.parent.replace(/^public\./, '')}`)
    const required = [
      'trip_members->trips', 'expenses->trips', 'expense_audit_logs->trips', 'settlements->trips',
      'expense_participants->expenses',
      'settlement_currency_totals->settlements', 'settlement_transfers->settlements', 'settlement_member_summaries->settlements',
    ]
    for (const r of required) expect(cascades, `missing ON DELETE CASCADE: ${r}`).toContain(r)
  })
  it('text-enum CHECK 값집합 정확 (잘못된 목록이 이름만으로 통과 방지)', async () => {
    const rows = await ctx.sql`select conname, pg_get_constraintdef(oid) as def from pg_constraint where contype='c'`
    const def = (n: string) => (rows.find((r: any) => r.conname === n)?.def ?? '')
    expect(def('payment_method_check')).toMatch(/'cash'.*'card'.*'transit_card'.*'easy_pay'.*'other'/s)
    expect(def('category_check')).toMatch(/'food'.*'cafe_snack'.*'transport'.*'lodging'.*'shopping'.*'sightseeing'.*'convenience'.*'other'/s)
    expect(def('input_source_check')).toMatch(/'manual'.*'ai_oneline'.*'card_sms'.*'receipt'.*'card_capture'/s)
    expect(def('change_type_check')).toMatch(/'create'.*'update'.*'delete'.*'restore'/s)
  })
})
```
> ⚠️ `pg_get_constraintdef`/`indexdef` 포맷(공백·따옴표·컬럼순서)은 PG 버전마다 미세 차이 가능 → 부분일치로 검증하고, 실패 시 실제 출력에 맞춰 **기대 문자열만** 보정(객체 누락과 포맷 차이를 구분). 컬럼 순서가 다르면 그건 진짜 스키마 차이일 수 있으니 신중히.

**Step 2: 실패 테스트 `tests/db/constraints.test.ts`** (핵심 제약 — 거부되어야 정상)

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startDb } from './helpers.ts'

let ctx: Awaited<ReturnType<typeof startDb>>
beforeAll(async () => { ctx = await startDb() })
afterAll(async () => { await ctx.sql.end(); await ctx.container.stop() })

// 강한 단언 (finding #2): "옳은 이유로 실패"를 증명. postgres.js 에러는 e.code(SQLSTATE)·e.constraint_name 제공.
// SQLSTATE: 23503 FK · 23505 unique · 23514 check · 23502 not-null.
async function expectViolation(fn: () => Promise<unknown>, code: string, constraint?: string) {
  try { await fn() } catch (e: any) {
    expect(e.code, 'SQLSTATE').toBe(code)
    if (constraint) expect(e.constraint_name).toBe(constraint)
    return
  }
  throw new Error('expected a DB violation but the insert succeeded')
}

// 각 negative it = 단일 위반만 주입 · 유효 fixture 먼저 · per-test 고유 id 격리 · expectViolation으로 SQLSTATE+constraint 단언
describe('DB 제약', () => {
  it('currencies seed 9통화 + TWD minor=0', async () => {
    const rows = await ctx.sql`select code, minor_unit from currencies order by code`
    expect(rows.length).toBe(9)
    expect(rows.find((r: any) => r.code === 'TWD').minor_unit).toBe(0)
  })
  it('positive: 유효 enum 값 expense insert 성공 (값집합 허용 실증)', async () => {
    await expect(insertValidEnumExpense(ctx)).resolves.toBeDefined()
  })

  it('uq_one_admin: 두 번째 active admin 거부', () => expectViolation(() => insertSecondActiveAdmin(ctx), '23505', 'uq_one_admin'))
  it('cross-trip paid_by FK: 다른 trip 멤버 결제자 거부', () => expectViolation(() => insertCrossTripExpense(ctx), '23503'))
  it('fx_by_source: converted인데 rate NULL 거부', () => expectViolation(() => insertConvertedWithoutRate(ctx), '23514', 'fx_by_source'))
  it('fx_by_source: card_billed인데 source 있음 거부', () => expectViolation(() => insertCardBilledWithSource(ctx), '23514', 'fx_by_source'))
  it('transfer amount<=0 거부', () => expectViolation(() => insertTransferNonPositive(ctx), '23514', 'transfer_amount_pos'))
  it('transfer from==to 거부', () => expectViolation(() => insertTransferSelf(ctx), '23514', 'transfer_distinct'))
  it('transfer paid half-state 거부', () => expectViolation(() => insertTransferPaidHalfState(ctx), '23514', 'paid_consistency'))
  it('local_not_tracked: basis=local인데 paid 거부', () => expectViolation(() => insertPaidLocalTransfer(ctx), '23514', 'local_not_tracked'))
  it('uq_member_email: 중복 초대 거부', () => expectViolation(() => insertDuplicateInvite(ctx), '23505', 'uq_member_email'))
  it('refund_self 거부', () => expectViolation(() => insertSelfRefund(ctx), '23514', 'refund_self'))
  it('cross-trip refund FK 거부', () => expectViolation(() => insertCrossTripRefund(ctx), '23503'))
  it('uq_settlement_active: 두 번째 active 스냅샷 거부', () => expectViolation(() => insertSecondActiveSnapshot(ctx), '23505', 'uq_settlement_active'))
  it('settlement_currency drift 거부 (composite FK→trips)', () => expectViolation(() => insertCurrencyDriftExpense(ctx), '23503'))
  it('expense_participants 복합 PK: 중복 참여자 거부', () => expectViolation(() => insertDuplicateParticipant(ctx), '23505'))
  it('uq_invite_token: 같은 해시 2개 pending 거부', () => expectViolation(() => insertDuplicateInviteToken(ctx), '23505', 'uq_invite_token'))
  it('invalid payment_method 값 거부', () => expectViolation(() => insertInvalidPaymentMethod(ctx), '23514', 'payment_method_check'))
})

// 헬퍼(helpers.ts): 유효 fixture(user→trip→admin member 1세트, DRY) 위에 단일 위반만 주입하는 insert* 함수들.
//   (insertSecondActiveAdmin·insertCrossTripExpense·insertConvertedWithoutRate·insertCardBilledWithSource·
//    insertTransferNonPositive·insertTransferSelf·insertTransferPaidHalfState·insertPaidLocalTransfer·
//    insertDuplicateInvite·insertSelfRefund·insertCrossTripRefund·insertSecondActiveSnapshot·
//    insertCurrencyDriftExpense·insertDuplicateParticipant·insertDuplicateInviteToken·
//    insertInvalidPaymentMethod·insertValidEnumExpense)
//   per-test 격리 = savepoint(BEGIN/ROLLBACK) 또는 테스트마다 고유 id로 실패 귀속 보장. raw ctx.sql 또는 ctx.db.insert.
```

> 각 헬퍼(`insertSecondActiveAdmin` 등)는 유효한 부모 행(user→trip→member)을 먼저 만들고, 위반 케이스를 insert해 reject를 단언한다. 유효 fixture 1세트를 `helpers.ts`에 두고 재사용(DRY).

**Step 3: 실패 확인** — Run: `bun run test tests/db/constraints.test.ts` · Expected: 헬퍼 미구현으로 FAIL.

**Step 4: 헬퍼 구현** — fixture + 위반 insert 함수들 작성(raw `ctx.sql` 또는 `ctx.db.insert`).

**Step 5: 통과 확인** — Run: same · Expected: PASS (모든 제약이 위반을 reject).

**Step 6: 전체 검증** — Run: `bun run check && bun run test` · Expected: 전부 PASS (introspection + negative-insert + 엔진).

**Step 7: Commit**

```bash
git add tests/db
git commit -m "test(db): 스키마 introspection + 제약 통합테스트

- introspection: 모든 named CHECK·인덱스·composite FK·복합PK·account unique 존재 강제
- negative-insert: cross-trip FK·uq_one_admin·fx_by_source·transfer CHECK·refund_self·cross-trip refund·local_not_tracked·uq_settlement_active·settlement_currency drift·중복참여자·중복초대·중복토큰"
```

---

## 완료 기준 (DoD 재확인)

- [ ] `cp .env.example .env` 후 `bun install` 성공 (계약 정합 경고 처리됨)
- [ ] `bun run check` PASS (oxlint + oxfmt --check + tsc)
- [ ] `bun run test` PASS (엔진 property/명시 + DB introspection(전 객체+의미론) + DB negative-insert SQLSTATE/constraint)
- [ ] **커밋된 산출물 위에서** `db:migrate`가 깨끗한 PG16에 클린 적용 + `db:seed` 성공 (생성기 재실행 아님)
- [ ] 생성기(auth:generate·db:generate)는 Task 7/10에서 **1회 실행·커밋** — 재실행 시 `git status` clean(drift 0, finding #1). auth-schema 하드닝은 재생성 경고로 보존
- [ ] `/health` 응답 확인
- [ ] `git status --short` empty (미커밋 생성물 drift 없음)
- [ ] 모든 커밋이 한국어·AI 마커 없음·허용 type만

## 후속 plan 예고 (이 slice 완료 후)
FX 파이프라인(provider 포트·Valkey 캐시·4단계 해결·동결) → 인증·초대 런타임(Better Auth 배선·초대 CAS·CSRF origin 미들웨어·guards) → API 라우트+DTO+OpenAPI 생성+계약 테스트 → (별도 레포) 프론트엔드.

---

## Adversarial review dispositions

Codex 적대적 리뷰(working-tree 모드) **5 passes**로 hardening. **총 12건 finding, 11건 Accept·반영 / 1건 부분 reject**(범위 외). high 추세 **1→2→1→1→0**으로 수렴(pass5에서 HIGH 소멸). 최종 verdict는 `needs-attention`(pass5의 MEDIUM 2건)이었고, **그 2건을 반영한 뒤 사용자 결정으로 확정**(미해결 HIGH 없음). 이 섹션은 확정 후 감사 추적이며 재리뷰 대상이 아니다.

| pass | # | finding | sev | 결정 | 반영 |
|---|---|---|---|---|---|
| 1 | 1 | DB 제약이 누락돼도 typecheck만으로 통과(Task 9/11) | high | Accept | introspection 존재검증 + 고위험 negative-insert를 게이트화(Task 11) |
| 1 | 2 | Better Auth 스키마 생성에 재현 env 경로 부재 | med | Accept | Task 0 `.env` 생성 스텝(Bun 자동 로드) |
| 1 | 3 | Dockerfile이 Bun 락파일과 불일치 | med | **Accept(부분)** | `COPY`에 `bun.lock` 추가. "docker build smoke 추가"는 **Reject**(배포 범위 외 YAGNI) |
| 2 | 1 | Docker `COPY . .`가 `.env` 시크릿을 이미지에 구움 | high | Accept | `.dockerignore`에 `.env`·`.env.*`·`!.env.example` |
| 2 | 2 | negative 테스트가 무관 에러로 통과 가능 | high | Accept | positive fixture+SQLSTATE+constraint명+격리(expectViolation) |
| 2 | 3 | seed CLI가 연결 미종료로 행 | med | Accept | seed CLI가 client 소유 + `finally`서 `sql.end()` |
| 3 | 1 | 스키마 게이트가 이름만, 의미론 미검증 | high | Accept | 부분유니크 WHERE·cascade·CHECK 값집합 정확 단언 + enum positive/negative |
| 3 | 2 | 마이그레이션 검증이 실패 후 재시도 불안전 | med | Accept | stale 선제거+`trap` cleanup+ready 대기 |
| 4 | 1 | 최종 생성기가 검증된 산출물 덮어씀 | high | Accept | 생성기 1회·커밋, 재생성 경고, DoD 재실행 제거 + `git status` clean |
| 4 | 2 | negative `it` 본문이 여전히 broad(예제 미수정) | med | Accept | 전 `it`을 `expectViolation`으로 본문 재작성, transfer 3분리 |
| 5 | 1 | 환불 에러 테스트가 메시지 정규식이라 정상 구현도 실패 | med | Accept | `toThrow(ValidationError/SettlementInvariantError)` 클래스 단언 |
| 5 | 2 | cascade 검증이 `some`이라 일부 누락 통과 | med | Accept | 테이블별 child→parent CASCADE 명시 단언(`confdeltype='c'`) |

**최종 pass5 `summary`:** "Do not ship this plan yet; it contains acceptance tests that can either block correct implementation or falsely certify unsafe schema behavior." → 해당 2건(pass5 #1·#2)을 반영해 해소. **확정 시점 미해결 HIGH 0.**

---

## Execution directives

- **Skill:** 이 plan은 **별도 세션에서, 이 워크트리(`~/workspace/trip-mate-api/.worktrees/backend-foundation`, 브랜치 `feat/backend-foundation`)에서** `executing-plans`로 task-by-task 구현한다.
- **연속 실행:** 일상 리뷰로 배치 사이에 멈추지 말 것. **진짜 블로커에서만 정지** — 의존성 부재, 반복 실패하는 검증, 불명확·모순 지시, 치명적 plan 공백(executing-plans의 "When to Stop and Ask"). 그 외에는 모든 batch를 끝까지.
- **커밋 — 아래 규칙을 직접 적용, `Skill(commit)` 호출 금지**(대화형 확인이 연속 실행을 깨뜨림):
  - **언어:** 커밋 메시지 **한국어**. **AI 마커 금지** — `🤖 Generated with`·`Co-Authored-By: Claude` 등 절대 포함 안 함.
  - **형식:** `<type>(<scope>): 한국어 설명` (필요 시 `- 상세` 본문).
  - **type — 다음만:** `feat`(새 기능)·`fix`(버그)·`refactor`(리팩토링/성능)·`docs`(문서)·`style`(포맷)·`test`(테스트)·`chore`(빌드/설정). `perf`/`build`/`ci` 등 금지.
  - **그룹화(우선순위):** ① 같은 기능/모듈 디렉토리 함께 ② 목적별 분리(refactor vs fix vs feature) ③ 서로 import/참조하는 파일 함께 ④ 변경 종류로 분리 — config(`package.json`/`tsconfig`…)·테스트·문서·독립 style을 각각 자기 커밋.
  - **판단:** 같은 디렉토리+같은 목적 → 한 커밋; 다른 파일 없이 무의미한 변경 → 같은 커밋; 독립 설명 가능한 변경 → 자기 커밋.
  - **위치:** 각 plan의 Commit 스텝에서 현재 `feat/backend-foundation` 워크트리 브랜치에 직접 커밋(이미 main 밖이므로 새 브랜치 불필요).
- **시작점:** 이 plan 문서를 위에서부터(Task 0 → 11) 순서대로. SSOT 충돌 시 `docs/plans/`의 설계 문서가 본 plan보다 우선.
