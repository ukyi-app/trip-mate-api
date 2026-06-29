# trip-mate-api 인증·초대 런타임 슬라이스 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Better Auth(Google OAuth) 런타임을 Hono에 배선하고, 토큰=포인터·email_verified 매칭=권한 모델로 초대→참여를 **원자 CAS**로 바인딩하며, 커스텀 라우트를 **host-only 쿠키 + 정확 Origin CSRF 미들웨어 + 멤버십 인가 가드**로 방어한다. HTTP 라우트의 풀 OpenAPI DTO·코드젠과 Resend 실발송은 후속 API 슬라이스로 분리한다.

**Architecture:** functional core(순수: 토큰 해시·이메일 정규화·email_verified 판정·CSRF origin 판정) / imperative shell(포트+어댑터: MemberRepo·SecondaryStorage·InviteMailer). Better Auth는 `modules/auth`에 배선(secondaryStorage=Valkey, accountLinking 금지, host-only `__Host-` 쿠키, trustedOrigins), 초대/참여는 `modules/members`(InviteService·MembersService·MemberRepo), 인가·CSRF는 `core/guards`·`core/csrf`. 세션 리졸버는 **주입 가능 의존성**으로 두어 라우트/가드를 실 OAuth 없이 테스트한다.

**Tech Stack:** Bun · Hono(@hono/zod-openapi) · Better Auth(이미 deps) · ioredis(Valkey, fx 슬라이스에서 추가됨) · Drizzle · vitest · testcontainers(PG16·redis). 기반: `src/auth.ts`(최소 Better Auth)·`src/db/schema/auth-schema.ts`(user·account·session·verification + `uq_account_provider`)·`src/db/schema/members.ts`(trip_members + `uq_invite_token`·`uq_member_email`·`uq_member_user`·`uq_one_admin`)·`src/core/errors.ts`·`src/core/composition.ts`·`tests/db/helpers.ts`.

**SSOT(충돌 시 우선):** `docs/plans/2026-06-29-auth-invite-design.md`(인증·초대 결정·CAS·CSRF — Codex 5-pass) · `docs/plans/2026-06-29-api-contract-design.md`(계약) · `docs/architecture.md`(§4.1~4.8). ⚠️ **architecture §4.7의 `Domain=.ukyi.app`/crossSubDomainCookies는 폐기** — 설계 §2(pass1 #1)가 host-only `__Host-`로 override(형제 서브도메인 노출 차단). 설계 문서가 본 계획·architecture보다 우선.

---

## 진행 원칙 (executing-plans)
- **연속 실행** — 진짜 블로커에서만 정지. TDD(테스트 먼저→실패→구현→통과→커밋).
- **워크트리** — 이미 `feat/auth-invite`(`.worktrees/auth-invite`, `feat/fx-pipeline`에서 적층)로 격리됨. 새 워크트리 만들지 말 것. 경로는 워크트리 기준 절대경로.
- **커밋** — 각 Task Commit 스텝에서 직접. 한국어·**AI 마커 금지**·`<type>(<scope>): 설명`, type은 `feat/fix/refactor/docs/style/test/chore`만. `Skill(commit)` 호출 금지.
- **포맷** — 새 .ts 작성 후 커밋 전 `bun run fmt` → `bun run check`. (oxfmt가 .md·migrations 제외.)
- **import 확장자** `.ts` 필수(우리 파일). 외부(Better Auth·Google)는 통합테스트에서 stub/주입/testcontainers — 실 Google 키 불필요.
- **Better Auth API 검증** — Better Auth 버전(`^1.6.22`)의 정확한 옵션 키(secondaryStorage·advanced.cookies·databaseHooks·socialProviders.google.mapProfileToUser)는 구현 시 [better-auth.com/docs](https://better-auth.com/docs)와 설치 버전 타입으로 확인. **본 계획은 보안 결정과 테스트 대상(순수 판정 함수·CAS·미들웨어)을 고정**하고, 프레임워크 배선의 정확한 옵션 형태는 executor가 docs로 맞춘다(아래 각 Task에 명시).

## Out of scope (후속 슬라이스 — 이 slice 미구현)
- **풀 HTTP 라우트 + DTO + OpenAPI 코드젠**(@hono/zod-openapi `createRoute`·`*.schema.ts`·`gen:openapi`·Hey API) — 다음 **API 라우트 슬라이스**. 본 슬라이스의 얇은 초대수락 라우트는 **test-only**(Task 8 통합테스트 앱에서만; 프로덕션 main.ts 미배선) — **비버전 라우트 ship 금지**, 프로덕션 `/v1` 경로·풀 DTO/OpenAPI는 defer(finding #2 pass5).
- **Resend 실 이메일 발송 + 발송 재시도 멱등** — `createInvite`/`resendInvite`는 **delivery command(`{token, link, inviteId}`)를 반환만** 하고, 실제 발송(Resend)은 컨트롤러/후속 슬라이스가 link로 수행. 서비스는 IO 발송을 critical path에서 하지 않는다(토큰 고아·미발송 방지, pass2 #1). **resendInvite는 원자 회전 primitive**이며, **재시도 멱등(Idempotency-Key per api-contract §5 + 트랜잭션 아웃박스)으로 "1 resend = 1 deliverable token" 보장은 API/발송 슬라이스 책임**(pass4 #2 — 본 슬라이스엔 발송이 없어 링크 경쟁 자체가 없음). Resend 어댑터·템플릿·아웃박스·Idempotency-Key는 후속.
- **trip 생성 라우트·trip 모듈** — 어드민 자동 멤버십(`ensureCreatorMembership`)은 본 슬라이스가 제공하되, trip *생성* 경로 연결은 trip 라우트 슬라이스에서 호출.
- **레이트리밋 운영 튜닝**(Better Auth `rateLimit` 활성 기본값만, secondary-storage=Valkey), **audit 로깅**, **세션 rolling 정책 튜닝**, **다중 OAuth·이메일 변경 재인증·MFA·패스키·로그아웃 세션 청소 운영**.
- **expense/settlement 라우트 인가 적용** — 가드(`requireTripMember`)는 제공하되 해당 라우트 연결은 각 도메인 슬라이스.

## 빌드 순서 (의존성)
`Task 0 env/config → 1 이메일정규화·토큰유틸(순수) → 2 email_verified판정(순수)·Valkey SecondaryStorage 어댑터 → 3 Better Auth 런타임 하드닝(auth.ts) → 4 CSRF/origin 미들웨어 → 5 Better Auth 마운트·세션 리졸버·authz 가드 → 6 MemberRepo(CAS 포함) → 7 Invite/Members 서비스 → 8 통합 보안 테스트(얇은 accept 라우트) → 9 컴포지션 배선·opt-in 실 OAuth smoke`.

---

## Task 0: env·config 확장 (`core/config.ts`)

**Files:** Modify `src/core/config.ts` · Modify `.env.example`

세션 저장(Valkey)·CSRF allowlist(FE origin)·Google는 이미 일부 존재. 런타임 로직 없음 → 컴파일·부팅 검증.

**Step 1: `core/config.ts`에 추가** (기존 server 블록에 필드 추가)

```ts
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
    BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET는 최소 32자(고엔트로피, openssl rand -base64 32) — finding #1"),
    BETTER_AUTH_URL: z.string().url(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    // ── 인증·초대 슬라이스 추가 ──
    VALKEY_URL: z.string().url(), // 세션 secondaryStorage (ioredis). 예 redis://localhost:6379
    // FE origin allowlist(CSRF 정확 일치 + Better Auth trustedOrigins). 콤마구분 → 배열.
    WEB_ORIGINS: z
      .string()
      .min(1)
      .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)),
    INVITE_TOKEN_TTL_HOURS: z.coerce.number().int().positive().default(168), // 7d
    USE_SECURE_COOKIES: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"), // prod=true, 로컬 http 개발만 false
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
```
> `WEB_ORIGINS`는 정확 문자열 비교용(스킴+호스트+포트). 예 `https://app.ukyi.app` 또는 로컬 `http://localhost:5173`. **와일드카드·서브도메인 패턴 금지**(설계 §6: 정확 일치만).

**Step 2: `.env.example`에 추가**

```
VALKEY_URL=redis://localhost:6379
WEB_ORIGINS=http://localhost:5173
INVITE_TOKEN_TTL_HOURS=168
USE_SECURE_COOKIES=false
```

**Step 3: config 검증 테스트** `src/core/config.test.ts` (finding #1 — 약한 시크릿 거부)

```ts
import { describe, it, expect, vi, afterEach } from "vitest";

const FULL: Record<string, string> = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  BETTER_AUTH_URL: "http://localhost:3000",
  VALKEY_URL: "redis://localhost:6379",
  WEB_ORIGINS: "http://localhost:5173",
  BETTER_AUTH_SECRET: "x".repeat(32),
};
const stub = (over: Record<string, string>) => {
  for (const [k, v] of Object.entries({ ...FULL, ...over })) vi.stubEnv(k, v);
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("env 검증 (createEnv)", () => {
  it("32자 이상 시크릿 → 로드 성공", async () => {
    stub({});
    const { env } = await import("./config.ts");
    expect(env.BETTER_AUTH_SECRET.length).toBeGreaterThanOrEqual(32);
  });
  it("짧은 시크릿(<32) → 부팅 실패 (finding #1)", async () => {
    stub({ BETTER_AUTH_SECRET: "short" });
    await expect(import("./config.ts")).rejects.toThrow();
  });
});
```
> `@t3-oss/env-core`는 import 시점에 `createEnv`를 평가 → 짧은 시크릿이면 import가 throw. `vi.resetModules()`로 매 테스트 재평가. 다른 테스트 파일과 격리 위해 본 파일에서만 stubEnv.

**Step 4: 검증·Commit**

```bash
bun run fmt && bun run check
bun run test src/core/config.test.ts
git add src/core/config.ts src/core/config.test.ts .env.example
git commit -m "feat(auth): 세션 Valkey·CSRF origin allowlist·초대 TTL env + 시크릿 ≥32 강제"
```

---

## Task 1: 이메일 정규화 + 초대 토큰 유틸 (`modules/members/domain/invite-token.ts`, 순수·TDD)

**Files:** Create `src/modules/members/domain/invite-token.ts` · Test `src/modules/members/domain/invite-token.test.ts`

SSOT: 설계 §3·§8.5. 토큰=`randomBytes(32)`→base64url(링크), DB는 sha256 해시. 이메일 정규화는 매칭 키.

**Step 1: 실패 테스트**

```ts
import { describe, it, expect } from "vitest";
import { normalizeEmail, generateInviteToken, hashToken } from "./invite-token.ts";

describe("normalizeEmail (§8.5)", () => {
  it("소문자·trim", () => {
    expect(normalizeEmail("  Foo@Example.COM ")).toBe("foo@example.com");
  });
  it("gmail 점 제거 + plus 태그 제거", () => {
    expect(normalizeEmail("john.doe+trip@gmail.com")).toBe("johndoe@gmail.com");
    expect(normalizeEmail("J.O.H.N+x.y@googlemail.com")).toBe("john@googlemail.com");
  });
  it("비-gmail은 점·+태그 보존(canonicalize 안 함, finding #2)", () => {
    expect(normalizeEmail("A.b+Tag@outlook.com")).toBe("a.b+tag@outlook.com"); // lowercase·trim만, +/점 보존
    expect(normalizeEmail("a+x@example.com")).not.toBe(normalizeEmail("a@example.com")); // 별개 principal 유지
  });
  it("@ 없으면 ValidationError", () => {
    expect(() => normalizeEmail("nope")).toThrow();
  });
});

describe("generateInviteToken / hashToken", () => {
  it("토큰은 base64url, hash는 sha256 hex 64자, 결정적", () => {
    const { token, hash } = generateInviteToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32바이트 base64url(패딩 없음)
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hash); // hash(token)==저장 hash
  });
  it("매 호출 고유 토큰", () => {
    expect(generateInviteToken().token).not.toBe(generateInviteToken().token);
  });
});
```

**Step 2: 실패 확인** — Run: `bun run test src/modules/members/domain/invite-token.test.ts` · Expected: FAIL.

**Step 3: 구현**

```ts
import { createHash, randomBytes } from "node:crypto";
import { ValidationError } from "../../../core/errors.ts";

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** §8.5(하드닝, finding #2): 소문자·trim. **Gmail 계열만** local part의 '.'·'+태그' canonicalize.
 *  비-Gmail은 '+태그'·'.'이 별개 mailbox/principal일 수 있어 **보존**한다 — 토큰 유출 시 `a@dom`이
 *  `a+trip@dom` 초대를 매칭하는 것을 차단(토큰=포인터 모델 유지). 모든 도메인 일괄 '+' 제거는 금지. */
export function normalizeEmail(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) throw new ValidationError(`invalid email: ${raw}`);
  const domain = trimmed.slice(at + 1);
  let local = trimmed.slice(0, at);
  if (GMAIL_DOMAINS.has(domain)) {
    const plus = local.indexOf("+");
    if (plus >= 0) local = local.slice(0, plus);
    local = local.replaceAll(".", "");
  }
  if (!local) throw new ValidationError(`invalid email local part: ${raw}`);
  return `${local}@${domain}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 링크용 raw 토큰(base64url, 패딩 없음) + DB 저장용 sha256 hash. */
export function generateInviteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}
```

**Step 4: 통과 확인** — Run: same · Expected: PASS.

**Step 5: Commit**

```bash
bun run fmt && bun run check
git add src/modules/members/domain/invite-token.ts src/modules/members/domain/invite-token.test.ts
git commit -m "feat(members): 이메일 정규화·초대 토큰 생성/해시 유틸(순수)"
```

---

## Task 2: email_verified 판정(순수) + Valkey SecondaryStorage 어댑터 (`modules/auth/`, TDD)

**Files:** Create `src/modules/auth/email-verified.ts` · Test `src/modules/auth/email-verified.test.ts` · Create `src/modules/auth/secondary-storage.ts` · Test `src/modules/auth/secondary-storage.test.ts`

SSOT: 설계 §1·§2·§5. email_verified=false Google 계정은 초대 매칭·로그인에서 거부(§34.4). 세션은 Valkey(ioredis) secondaryStorage.

**Step 1: 실패 테스트 — email_verified**

```ts
import { describe, it, expect } from "vitest";
import { assertGoogleEmailVerified, type GoogleProfileLike } from "./email-verified.ts";
import { ForbiddenError } from "../../core/errors.ts";

const p = (over: Partial<GoogleProfileLike> = {}): GoogleProfileLike => ({
  email: "u@gmail.com",
  email_verified: true,
  ...over,
});

describe("assertGoogleEmailVerified (§34.4)", () => {
  it("verified=true → 통과(프로필 반환)", () => {
    expect(assertGoogleEmailVerified(p()).email).toBe("u@gmail.com");
  });
  it("verified=false → ForbiddenError", () => {
    expect(() => assertGoogleEmailVerified(p({ email_verified: false }))).toThrow(ForbiddenError);
  });
  it("verified 누락 → ForbiddenError(미검증 취급)", () => {
    expect(() => assertGoogleEmailVerified(p({ email_verified: undefined }))).toThrow(ForbiddenError);
  });
});
```

**Step 2: 실패 테스트 — SecondaryStorage** (testcontainers redis, fx의 cache.test 패턴 — `beforeEach` 훅 회피)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import Redis from "ioredis";
import { RedisSecondaryStorage } from "./secondary-storage.ts";

let container: StartedRedisContainer;
let redis: Redis;
beforeAll(async () => {
  container = await new RedisContainer("redis:7").start();
  redis = new Redis(container.getConnectionUrl());
});
afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
});

describe("RedisSecondaryStorage (Better Auth secondaryStorage 계약)", () => {
  it("set→get round-trip", async () => {
    const s = new RedisSecondaryStorage(redis);
    await s.set("k1", "v1");
    expect(await s.get("k1")).toBe("v1");
  });
  it("miss → null", async () => {
    const s = new RedisSecondaryStorage(redis);
    expect(await s.get("absent")).toBeNull();
  });
  it("ttl(초) 설정 시 만료", async () => {
    const s = new RedisSecondaryStorage(redis);
    await s.set("k2", "v2", 1);
    expect(await redis.ttl("k2")).toBeGreaterThan(0);
  });
  it("delete", async () => {
    const s = new RedisSecondaryStorage(redis);
    await s.set("k3", "v3");
    await s.delete("k3");
    expect(await s.get("k3")).toBeNull();
  });
});
```
> Better Auth `secondaryStorage` 계약: `{ get(key): Promise<string|null>; set(key, value, ttl?): Promise<void>; delete(key): Promise<void> }`(ttl=초). 구현 시 설치 버전의 타입으로 시그니처 확인.

**Step 3: 실패 확인** — Run: `bun run test src/modules/auth/` · Expected: FAIL.

**Step 4: 구현**

`email-verified.ts`:
```ts
import { ForbiddenError } from "../../core/errors.ts";

export interface GoogleProfileLike {
  email: string;
  email_verified?: boolean;
}

/** Google profile의 email_verified=true만 허용. 아니면 ForbiddenError(초대 매칭·로그인 차단, §34.4). */
export function assertGoogleEmailVerified<T extends GoogleProfileLike>(profile: T): T {
  if (profile.email_verified !== true) {
    throw new ForbiddenError("google email not verified", { email: profile.email });
  }
  return profile;
}
```

`secondary-storage.ts`:
```ts
import type Redis from "ioredis";

/** Better Auth secondaryStorage 어댑터(Valkey/ioredis). ttl 단위=초. */
export class RedisSecondaryStorage {
  constructor(private readonly redis: Redis) {}
  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }
  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (ttl && ttl > 0) await this.redis.set(key, value, "EX", ttl);
    else await this.redis.set(key, value);
  }
  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
```

**Step 5: 통과 확인** — Run: same · Expected: PASS.

**Step 6: Commit**

```bash
bun run fmt && bun run check
git add src/modules/auth/email-verified.ts src/modules/auth/email-verified.test.ts src/modules/auth/secondary-storage.ts src/modules/auth/secondary-storage.test.ts
git commit -m "feat(auth): email_verified 판정(순수)·Valkey SecondaryStorage 어댑터"
```

---

## Task 3: Better Auth 런타임 하드닝 (`auth.ts`)

**Files:** Modify `src/auth.ts` · Test `src/auth.test.ts`

SSOT: 설계 §1·§2·§5·§6. **secondaryStorage=Valkey**, **email_verified 거부 hook**(assertGoogleEmailVerified), **host-only `__Host-` 쿠키**(Domain 미설정·Secure·SameSite=Lax·HttpOnly), **trustedOrigins=WEB_ORIGINS**, **accountLinking 금지**(유지). 프레임워크 옵션 형태는 docs로 확정하되, **테스트는 결정적 불변식(아래)만 단언**한다.

**Step 1: 실패 테스트** (auth 인스턴스 옵션·동작 불변식 — 실 OAuth 없이 검증 가능한 것만)

```ts
import { describe, it, expect, vi } from "vitest";
import { createAuth, type AuthDeps } from "./auth.ts";
import { createDb } from "./db/client.ts";

// 외부 IO 없음(finding #2): fake redis + lazy postgres 클라이언트(연결 안 함) 주입. env 미평가.
const fakeRedis = {
  get: vi.fn(async () => null),
  set: vi.fn(async () => "OK"),
  del: vi.fn(async () => 1),
} as unknown as import("ioredis").default;

const deps = (over: Partial<AuthDeps> = {}): AuthDeps => ({
  db: createDb("postgres://u:p@localhost:5432/db"), // postgres.js lazy — 구성만, 연결 X
  redis: fakeRedis,
  secret: "x".repeat(32),
  baseURL: "http://localhost:3000",
  trustedOrigins: ["https://app.ukyi.app"],
  useSecureCookies: false,
  ...over,
});

describe("createAuth 보안 불변식", () => {
  it("accountLinking 비활성(이메일 기반 링킹 금지)", () => {
    expect(createAuth(deps()).options.account?.accountLinking?.enabled).toBe(false);
  });
  it("trustedOrigins=주입 origin", () => {
    expect(createAuth(deps({ trustedOrigins: ["https://app.ukyi.app"] })).options.trustedOrigins).toContain("https://app.ukyi.app");
  });
  it("secondaryStorage 주입(세션 Postgres 비대화)", () => {
    expect(createAuth(deps()).options.secondaryStorage).toBeDefined();
  });
  it("쿠키는 Domain 미설정(host-only) — crossSubDomainCookies 비활성", () => {
    expect(createAuth(deps()).options.advanced?.crossSubDomainCookies?.enabled ?? false).toBe(false);
  });
  it("prod(useSecureCookies) → Secure 강제·host-only(Domain 없음) (finding #1 pass4/5)", () => {
    const auth = createAuth(deps({ useSecureCookies: true }));
    expect(auth.options.advanced?.useSecureCookies).toBe(true);
    expect(auth.options.advanced?.crossSubDomainCookies?.enabled ?? false).toBe(false);
    // 실제 __Host- 이름 보장은 enforceHostCookie 미들웨어의 Set-Cookie 헤더 테스트(core/host-cookie.test.ts)가 검증(pass5).
  });
});
```
> 단언 키(`options.account.accountLinking.enabled`·`options.trustedOrigins`·`options.secondaryStorage`·`options.advanced.crossSubDomainCookies`)는 Better Auth가 노출하는 `auth.options` 형태를 설치 버전 타입으로 확인 후 맞춘다. **노출 형태가 다르면, 동일 의미를 검증하도록 단언을 조정**(예: 별도 export한 옵션 객체 단언). 핵심은 "host-only·링킹금지·secondaryStorage·trustedOrigins"의 회귀 가드.

**Step 2: 실패 확인** — Run: `bun run test src/auth.test.ts` · Expected: FAIL(createAuth 미존재).

**Step 3: 구현** — `auth.ts`를 팩토리로 리팩터(테스트 주입 가능) + 하드닝

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type Redis from "ioredis";
import type { DB } from "./db/client.ts";
import { RedisSecondaryStorage } from "./modules/auth/secondary-storage.ts";
import { assertGoogleEmailVerified } from "./modules/auth/email-verified.ts";

export interface AuthDeps {
  db: DB;
  redis: Redis;
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  useSecureCookies: boolean;
  google?: { clientId: string; clientSecret: string };
}

/** **완전 DI 팩토리** — top-level env read·IO·싱글톤 없음(finding #2 pass2). 테스트는 fake만 주입,
 *  운영 싱글톤은 main.ts 컴포지션 루트가 구성(`new IoRedis(env.VALKEY_URL)` 등은 거기서). */
export function createAuth(deps: AuthDeps) {
  const storage = new RedisSecondaryStorage(deps.redis);
  return betterAuth({
    database: drizzleAdapter(deps.db, { provider: "pg" }),
    secret: deps.secret,
    baseURL: deps.baseURL,
    trustedOrigins: deps.trustedOrigins,
    // 세션: Valkey(secondaryStorage) — Postgres 세션 테이블 비대화 회피(설계 D2)
    secondaryStorage: {
      get: (k) => storage.get(k),
      set: (k, v, ttl) => storage.set(k, v, ttl),
      delete: (k) => storage.delete(k),
    },
    // 계정 링킹 금지: Google sub 1:1, 이메일 기반 병합 차단(설계 §1·pass2)
    account: { accountLinking: { enabled: false } },
    socialProviders: {
      google: {
        clientId: deps.google?.clientId ?? "",
        clientSecret: deps.google?.clientSecret ?? "",
        // email_verified=false Google 계정 거부(§34.4). mapProfileToUser에서 가드.
        mapProfileToUser: (profile) => {
          assertGoogleEmailVerified(profile as { email: string; email_verified?: boolean });
          return { email: profile.email, name: profile.name, image: profile.picture };
        },
      },
    },
    // 쿠키: host-only **__Host-** (설계 §2·pass1 #1·pass4 필수화) — Domain 미설정·Secure·Path=/·SameSite=Lax·HttpOnly.
    // __Host-는 브라우저가 Domain-scoped **동명** 쿠키를 거부 → 형제 *.ukyi.app의 cookie-tossing/fixation 차단(host-only만으론 형제가 동명 Domain 쿠키 set 가능).
    // ⚠️ __Host-는 Secure(https) 요구 → prod(useSecureCookies=true)에서만 강제. 로컬 http 개발은 비-__Host-.
    advanced: {
      useSecureCookies: deps.useSecureCookies,
      // ⚠️ cookiePrefix로 __Host- 위조 금지(finding #1 pass5): BA 1.6.22는 useSecureCookies 시 __Secure- 를 prepend →
      //    이름이 __Secure-__Host-... 가 되어 브라우저 __Host- 규칙 미적용. 실제 __Host- 보장은
      //    응답 Set-Cookie를 정규화하는 enforceHostCookie 미들웨어(Task 5)가 담당(Set-Cookie 헤더 테스트로 검증).
      // crossSubDomainCookies 미설정 = Domain 없음 = host-only.
      defaultCookieAttributes: { sameSite: "lax", httpOnly: true, path: "/", secure: deps.useSecureCookies },
    },
  });
}
// ⚠️ top-level `export const auth = ...` 싱글톤 금지(finding #2) — main.ts에서 구성(Task 9).
```
> ⚠️ **docs 확인 필수**: ① `secondaryStorage` 객체 시그니처(특히 set의 ttl 인자 단위/유무), ② `socialProviders.google.mapProfileToUser`가 profile에 `email_verified`를 노출하는지(아니면 `databaseHooks.user.create.before` 또는 `socialProviders.google.verifyIdToken`로 이동), ③ `advanced`의 쿠키 옵션 키(`useSecureCookies`·`defaultCookieAttributes`·`cookiePrefix`·`crossSubDomainCookies`)와 `__Host-` prefix 지원 여부. **의미(host-only·__Host-·verified-only·secondaryStorage·링킹금지·trustedOrigins)는 고정**, 키 이름만 버전에 맞춤. 단언이 깨지면 동일 의미로 조정.
> 🛑 **하드 요구(pass4)**: prod(https)에서 세션 Set-Cookie 이름이 `__Host-`로 시작하고 Secure·Path=/·Domain 없음을 만족해야 한다. Better Auth가 이를 emit하지 못하면 **구현을 중단하고 보고**(약한 host-only로 진행 금지 — 형제 cookie-tossing 잔존).
> `auth:generate` 재실행 금지(auth-schema.ts 하드닝 보존 — DB 설계 §10). 본 슬라이스는 스키마 무변경.

**Step 4: 통과 확인** — Run: same · Expected: PASS.

**Step 5: Commit**

```bash
bun run fmt && bun run check
git add src/auth.ts src/auth.test.ts
git commit -m "feat(auth): Better Auth 하드닝(Valkey 세션·email_verified 거부·host-only 쿠키·trustedOrigins)"
```

---

## Task 4: CSRF/origin 미들웨어 (`core/csrf.ts`, TDD)

**Files:** Create `src/core/csrf.ts` · Test `src/core/csrf.test.ts`

SSOT: 설계 §6(pass1 #2·pass3 #1). 커스텀 라우트는 Better Auth CSRF 미커버 → **앱 전역**: unsafe 메서드(POST/PUT/PATCH/DELETE)는 **`Origin`이 allowlist와 정확 일치할 때만 허용**, `Origin` 누락 거부, `Sec-Fetch-Site`는 **추가 deny 신호만**. 안전 메서드(GET/HEAD/OPTIONS) 통과.

**Step 1: 실패 테스트** (순수 판정 함수 + Hono 미들웨어 둘 다)

```ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { decideCsrf, csrf } from "./csrf.ts";

const ALLOW = ["https://app.ukyi.app"];

describe("decideCsrf (순수 판정)", () => {
  it("안전 메서드는 origin 무관 allow", () => {
    expect(decideCsrf("GET", null, null, ALLOW)).toEqual({ allow: true });
  });
  it("정확 origin 일치 → allow", () => {
    expect(decideCsrf("POST", "https://app.ukyi.app", null, ALLOW)).toEqual({ allow: true });
  });
  it("형제 서브도메인 → deny", () => {
    expect(decideCsrf("POST", "https://evil.ukyi.app", null, ALLOW).allow).toBe(false);
  });
  it("외부 origin → deny", () => {
    expect(decideCsrf("POST", "https://evil.com", null, ALLOW).allow).toBe(false);
  });
  it("Origin 누락(unsafe) → deny", () => {
    expect(decideCsrf("POST", null, null, ALLOW).allow).toBe(false);
  });
  it("Sec-Fetch-Site=cross-site는 origin 일치해도 deny(추가 신호)", () => {
    expect(decideCsrf("POST", "https://app.ukyi.app", "cross-site", ALLOW).allow).toBe(false);
  });
  it("Sec-Fetch-Site=same-origin + 정확 origin → allow", () => {
    expect(decideCsrf("POST", "https://app.ukyi.app", "same-origin", ALLOW).allow).toBe(true);
  });
});

describe("csrf 미들웨어", () => {
  const app = new Hono();
  app.use("*", csrf(ALLOW));
  app.post("/x", (c) => c.json({ ok: true }));
  app.get("/x", (c) => c.json({ ok: true }));

  it("정확 origin POST → 200", async () => {
    const res = await app.request("/x", { method: "POST", headers: { origin: "https://app.ukyi.app" } });
    expect(res.status).toBe(200);
  });
  it("형제 origin POST → 403", async () => {
    const res = await app.request("/x", { method: "POST", headers: { origin: "https://evil.ukyi.app" } });
    expect(res.status).toBe(403);
  });
  it("Origin 없는 POST → 403", async () => {
    const res = await app.request("/x", { method: "POST" });
    expect(res.status).toBe(403);
  });
  it("GET은 origin 없이도 200", async () => {
    const res = await app.request("/x", { method: "GET" });
    expect(res.status).toBe(200);
  });
});
```

**Step 2: 실패 확인** — Run: `bun run test src/core/csrf.test.ts` · Expected: FAIL.

**Step 3: 구현**

```ts
import type { Context, Next } from "hono";
import { ForbiddenError } from "./errors.ts";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** 순수 판정: unsafe 메서드는 Origin 정확 일치 필요, Sec-Fetch-Site=cross-site는 추가 deny. */
export function decideCsrf(
  method: string,
  origin: string | null,
  secFetchSite: string | null,
  allow: readonly string[],
): { allow: boolean; reason?: string } {
  if (SAFE.has(method.toUpperCase())) return { allow: true };
  if (secFetchSite === "cross-site") return { allow: false, reason: "sec-fetch-site:cross-site" };
  if (!origin) return { allow: false, reason: "origin-missing" };
  if (!allow.includes(origin)) return { allow: false, reason: "origin-not-allowed" };
  return { allow: true };
}

/** 앱 전역 미들웨어. 위반 시 ForbiddenError → onError(403). */
export function csrf(allow: readonly string[]) {
  return async (c: Context, next: Next) => {
    const d = decideCsrf(
      c.req.method,
      c.req.header("origin") ?? null,
      c.req.header("sec-fetch-site") ?? null,
      allow,
    );
    if (!d.allow) throw new ForbiddenError("csrf origin check failed", { reason: d.reason });
    await next();
  };
}
```
> Better Auth 자체 `/api/auth` 라우트는 Better Auth 내장 CSRF/origin을 쓰므로, 본 미들웨어는 **커스텀 라우트에만** 적용(마운트 순서는 Task 8·9). `ForbiddenError`는 onError(Task 5/9의 registerErrorFilter)가 403 problem+json으로 매핑.

**Step 4: 통과 확인** — Run: same · Expected: PASS.

**Step 5: Commit**

```bash
bun run fmt && bun run check
git add src/core/csrf.ts src/core/csrf.test.ts
git commit -m "feat(core): CSRF origin 미들웨어(정확 일치·Origin 누락 거부·Sec-Fetch-Site deny)"
```

---

## Task 5: Better Auth 마운트 + 세션 리졸버 + authz 가드 (`core/guards.ts`, `modules/auth/mount.ts`, TDD)

**Files:** Create `src/modules/auth/mount.ts` · Create `src/core/guards.ts` · Test `src/core/guards.test.ts`

SSOT: 설계 §4, architecture §4.4. **세션 리졸버 주입**(실 OAuth 없이 테스트). `requireAuth`=인증(c.var.user), `requireTripMember(role?)`=멤버십 status=joined·role 게이팅(c.var.membership). 위반 → ForbiddenError.

**Step 1: 실패 테스트** (stub 세션 리졸버 + fake 멤버십 조회)

```ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { requireAuth, requireTripMember, type SessionResolver, type MembershipLookup } from "./guards.ts";

const userSession = (id: string): SessionResolver => async () => ({ user: { id } });
const noSession: SessionResolver = async () => null;

const lookup =
  (rows: Record<string, { role: string; status: string }>): MembershipLookup =>
  async (tripId, userId) => rows[`${tripId}:${userId}`] ?? null;

function appWith(resolver: SessionResolver, look: MembershipLookup) {
  const app = new Hono();
  app.onError((e, c) => c.json({ code: (e as { code?: string }).code ?? "Error" }, (e as { status?: number }).status ?? 500 as never));
  app.use("/trips/:tripId/*", requireAuth(resolver), requireTripMember(look));
  app.get("/trips/:tripId/x", (c) => c.json({ user: c.get("user"), m: c.get("membership") }));
  app.use("/admin/:tripId/*", requireAuth(resolver), requireTripMember(look, "admin"));
  app.get("/admin/:tripId/x", (c) => c.json({ ok: true }));
  return app;
}

describe("requireAuth", () => {
  it("세션 없음 → 401/403", async () => {
    const app = appWith(noSession, lookup({}));
    const res = await app.request("/trips/t1/x");
    expect([401, 403]).toContain(res.status);
  });
});

describe("requireTripMember", () => {
  it("joined 멤버 → 통과 + membership 노출", async () => {
    const app = appWith(userSession("u1"), lookup({ "t1:u1": { role: "member", status: "joined" } }));
    const res = await app.request("/trips/t1/x");
    expect(res.status).toBe(200);
    expect((await res.json()).m.role).toBe("member");
  });
  it("비멤버 → 403", async () => {
    const app = appWith(userSession("u9"), lookup({}));
    expect((await app.request("/trips/t1/x")).status).toBe(403);
  });
  it("invited(미참여) 상태 → 403(joined만 접근)", async () => {
    const app = appWith(userSession("u1"), lookup({ "t1:u1": { role: "member", status: "invited" } }));
    expect((await app.request("/trips/t1/x")).status).toBe(403);
  });
  it("role=admin 요구인데 member → 403", async () => {
    const app = appWith(userSession("u1"), lookup({ "t1:u1": { role: "member", status: "joined" } }));
    expect((await app.request("/admin/t1/x")).status).toBe(403);
  });
  it("admin 요구 + admin → 200", async () => {
    const app = appWith(userSession("u1"), lookup({ "t1:u1": { role: "admin", status: "joined" } }));
    expect((await app.request("/admin/t1/x")).status).toBe(200);
  });
});
```

**Step 2: 실패 확인** — Run: `bun run test src/core/guards.test.ts` · Expected: FAIL.

**Step 3: 구현**

`core/guards.ts`:
```ts
import type { Context, Next } from "hono";
import { ForbiddenError } from "./errors.ts";

export interface SessionUser {
  id: string;
}
export type SessionResolver = (headers: Headers) => Promise<{ user: SessionUser } | null>;
export interface Membership {
  role: string;
  status: string;
}
export type MembershipLookup = (tripId: string, userId: string) => Promise<Membership | null>;

declare module "hono" {
  interface ContextVariableMap {
    user: SessionUser;
    membership: Membership;
  }
}

/** 인증: 세션 리졸버(주입)로 user 확립. 없으면 ForbiddenError(403). */
export function requireAuth(resolve: SessionResolver) {
  return async (c: Context, next: Next) => {
    const session = await resolve(c.req.raw.headers);
    if (!session) throw new ForbiddenError("authentication required");
    c.set("user", session.user);
    await next();
  };
}

/** 멤버십 게이팅: status=joined만 접근, role 지정 시 일치 필요. requireAuth 뒤에 둔다. */
export function requireTripMember(lookup: MembershipLookup, role?: "admin" | "member") {
  return async (c: Context, next: Next) => {
    const user = c.get("user");
    const tripId = c.req.param("tripId");
    if (!user || !tripId) throw new ForbiddenError("trip membership required");
    const m = await lookup(tripId, user.id);
    if (!m || m.status !== "joined") throw new ForbiddenError("not an active trip member", { tripId });
    if (role && m.role !== role) throw new ForbiddenError(`requires role ${role}`, { tripId });
    c.set("membership", m);
    await next();
  };
}
```
> `ForbiddenError`(403)로 통일(미인증·미멤버·role 부족 모두 403 — 멤버십 존재 여부 노출 최소화). 테스트의 `[401,403]`은 이를 수용.

`modules/auth/mount.ts` (Better Auth 핸들러 마운트 + 운영 세션 리졸버):
```ts
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { createAuth } from "../../auth.ts";
import type { SessionResolver } from "../../core/guards.ts";

type AuthInstance = ReturnType<typeof createAuth>; // 싱글톤이 아니라 팩토리 반환 타입(finding #2)

/** /api/auth/* 를 Better Auth web fetch 핸들러로 마운트. */
export function mountAuth(app: OpenAPIHono, auth: AuthInstance): void {
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
}

/** 운영 세션 리졸버: Better Auth가 헤더(쿠키)로 세션 해석. */
export function betterAuthSessionResolver(auth: AuthInstance): SessionResolver {
  return async (headers) => {
    const session = await auth.api.getSession({ headers });
    return session?.user ? { user: { id: session.user.id } } : null;
  };
}
```
> ⚠️ **docs 확인**: `auth.handler`(web fetch Request→Response)와 `auth.api.getSession({ headers })` 반환 형태(`{ user, session } | null`)를 설치 버전 타입으로 확인. mount.ts는 통합(Task 8·9)에서 검증, guards.ts는 본 Task에서 stub 리졸버로 단위 검증.

**Step 3b: `__Host-` 쿠키 정규화 미들웨어** `src/core/host-cookie.ts` + Test `src/core/host-cookie.test.ts` (finding #1 pass5)

BA 1.6.22의 `__Secure-` prepend 때문에 cookiePrefix로는 `__Host-`를 못 만든다 → **응답 Set-Cookie 이름을 `__Host-`로 정규화**(Domain 제거·Secure·Path=/ 보장). 우리 코드라 결정적·Set-Cookie 헤더로 테스트.

테스트:
```ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { enforceHostCookie } from "./host-cookie.ts";

describe("enforceHostCookie", () => {
  it("__Secure- 세션 쿠키 → __Host- 정규화, Domain 제거, Secure 보장", async () => {
    const app = new Hono();
    app.use("*", enforceHostCookie({ secure: true }));
    app.get("/x", (c) => {
      c.header("set-cookie", "__Secure-better-auth.session_token=abc; Domain=.ukyi.app; Path=/; HttpOnly; SameSite=Lax; Secure");
      return c.body("ok");
    });
    const sc = (await app.request("/x")).headers.get("set-cookie") ?? "";
    expect(sc.startsWith("__Host-")).toBe(true);
    expect(sc).not.toMatch(/Domain=/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/Path=\//i);
  });
  it("secure=false(로컬 http) → 미변경(__Host- 불가)", async () => {
    const app = new Hono();
    app.use("*", enforceHostCookie({ secure: false }));
    app.get("/x", (c) => {
      c.header("set-cookie", "better-auth.session_token=abc; Path=/");
      return c.body("ok");
    });
    expect((await app.request("/x")).headers.get("set-cookie")).toBe("better-auth.session_token=abc; Path=/");
  });
});
```

구현:
```ts
import type { MiddlewareHandler } from "hono";

/** 응답 Set-Cookie 이름을 __Host- 로 강제(Domain 제거·Secure·Path=/). BA의 __Secure- prepend를 무력화(finding #1 pass5).
 *  secure=false(로컬 http)면 __Host-(Secure 요구) 불가 → 그대로 둔다. */
export function enforceHostCookie(opts: { secure: boolean }): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (!opts.secure) return;
    const cookies = c.res.headers.getSetCookie();
    if (cookies.length === 0) return;
    const fixed = cookies.map((raw) => {
      const eq = raw.indexOf("=");
      if (eq < 0) return raw;
      const bareName = raw.slice(0, eq).replace(/^__Secure-/i, "").replace(/^__Host-/i, "");
      let attrs = raw.slice(eq).replace(/;\s*Domain=[^;]*/i, ""); // "=value; attrs" 에서 Domain 제거
      if (!/;\s*Secure/i.test(attrs)) attrs += "; Secure";
      attrs = /;\s*Path=/i.test(attrs) ? attrs.replace(/;\s*Path=[^;]*/i, "; Path=/") : attrs + "; Path=/";
      return `__Host-${bareName}${attrs}`;
    });
    c.res.headers.delete("set-cookie");
    for (const sc of fixed) c.res.headers.append("set-cookie", sc);
  };
}
```
> `/api/auth/*` 응답에 적용(Task 9). `getSetCookie()`는 표준 Headers API(Bun 지원). 비-세션 쿠키까지 정규화하지만, 인증 라우트 응답엔 세션 쿠키만 존재하므로 안전(필요 시 이름 필터 추가).

**Step 4: 통과 확인** — Run: same · Expected: PASS.

**Step 5: Commit**

```bash
bun run fmt && bun run check
git add src/core/guards.ts src/modules/auth/mount.ts src/core/guards.test.ts src/core/host-cookie.ts src/core/host-cookie.test.ts
git commit -m "feat(auth): Better Auth 마운트·세션 리졸버·authz 가드·__Host- 쿠키 정규화 미들웨어"
```

---

## Task 6: MemberRepo — 포트 + Drizzle 어댑터 (초대·원자 CAS·멤버십, TDD testcontainers PG)

**Files:** Create `src/modules/members/members.repo.ts` · Test `src/modules/members/members.repo.test.ts`

SSOT: 설계 §3(원자 CAS)·§7. trip_members 스키마는 기존(무변경). **CAS는 검증 predicate 전부 WHERE에 포함**(TOCTOU 제거).

**Step 1: 실패 테스트** (testcontainers PG — helpers의 startDb·mkUser·mkTrip·mkMember 재사용)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, mkTrip, type Ctx } from "../../../tests/db/helpers.ts";
import { DrizzleMemberRepo } from "./members.repo.ts";
import { generateInviteToken, normalizeEmail } from "./domain/invite-token.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

const future = () => new Date(Date.now() + 3600_000);
const past = () => new Date(Date.now() - 1000);

describe("DrizzleMemberRepo", () => {
  it("createInvite → findByTokenHash 조회", async () => {
    const u = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const repo = new DrizzleMemberRepo(ctx.db);
    const { hash } = generateInviteToken();
    await repo.createInvite({ tripId: trip, email: "Guest@example.com", hash, expiresAt: future(), displayName: "G" });
    const row = await repo.findByTokenHash(hash);
    expect(row?.normalized_invited_email).toBe("guest@example.com");
    expect(row?.status).toBe("invited");
  });

  it("acceptInviteCas: 유효 invite → 1행 바인딩(joined·user_id)", async () => {
    const u = await mkUser(ctx.sql);
    const me = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const repo = new DrizzleMemberRepo(ctx.db);
    const { hash } = generateInviteToken();
    const email = "cas@example.com";
    await repo.createInvite({ tripId: trip, email, hash, expiresAt: future(), displayName: "C" });
    const row = await repo.findByTokenHash(hash);
    const bound = await repo.acceptInviteCas({
      inviteId: row!.id,
      userId: me,
      hash,
      normalizedEmail: normalizeEmail(email),
    });
    expect(bound?.user_id).toBe(me);
    expect(bound?.status).toBe("joined");
  });

  it("acceptInviteCas 멱등: 같은 user 재수락 → 동일 행(성공 취급은 service)", async () => {
    const u = await mkUser(ctx.sql);
    const me = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const repo = new DrizzleMemberRepo(ctx.db);
    const { hash } = generateInviteToken();
    const email = "idem@example.com";
    await repo.createInvite({ tripId: trip, email, hash, expiresAt: future(), displayName: "I" });
    const row = await repo.findByTokenHash(hash);
    await repo.acceptInviteCas({ inviteId: row!.id, userId: me, hash, normalizedEmail: normalizeEmail(email) });
    const second = await repo.acceptInviteCas({ inviteId: row!.id, userId: me, hash, normalizedEmail: normalizeEmail(email) });
    expect(second).toBeNull(); // 0행(이미 joined) — service가 user_id==me면 멱등 성공 판정
  });

  it("acceptInviteCas: 만료된 invite → 0행", async () => {
    const u = await mkUser(ctx.sql);
    const me = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const repo = new DrizzleMemberRepo(ctx.db);
    const { hash } = generateInviteToken();
    const email = "exp@example.com";
    await repo.createInvite({ tripId: trip, email, hash, expiresAt: past(), displayName: "E" });
    const row = await repo.findByTokenHash(hash);
    const bound = await repo.acceptInviteCas({ inviteId: row!.id, userId: me, hash, normalizedEmail: normalizeEmail(email) });
    expect(bound).toBeNull();
  });

  it("rotateInviteToken: pending invite → 원자 교체(1행), 비-pending → 0행 (finding #3)", async () => {
    const u = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const repo = new DrizzleMemberRepo(ctx.db);
    const { hash: h1 } = generateInviteToken();
    await repo.createInvite({ tripId: trip, email: "rot@example.com", hash: h1, expiresAt: future(), displayName: "R" });
    const row = await repo.findByTokenHash(h1);
    const { hash: h2 } = generateInviteToken();
    const rotated = await repo.rotateInviteToken(row!.id, h2, future());
    expect(rotated?.id).toBe(row!.id);
    expect(await repo.findByTokenHash(h1)).toBeNull(); // 이전 hash 무효
    expect((await repo.findByTokenHash(h2))?.id).toBe(row!.id); // 새 hash 유효
    // joined된 행은 rotate 0행
    const me = await mkUser(ctx.sql);
    await repo.acceptInviteCas({ inviteId: row!.id, userId: me, hash: h2, normalizedEmail: "rot@example.com" });
    expect(await repo.rotateInviteToken(row!.id, generateInviteToken().hash, future())).toBeNull();
  });

  it("findMembership·countActiveAdmins", async () => {
    const u = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const repo = new DrizzleMemberRepo(ctx.db);
    await repo.ensureCreatorMembership({ tripId: trip, userId: u, displayName: "Admin", email: "admin@example.com" });
    expect((await repo.findMembership(trip, u))?.role).toBe("admin");
    expect(await repo.countActiveAdmins(trip)).toBe(1);
  });

  it("ensureCreatorMembership 동시 호출 → 동일 멤버십·unique 위반 노출 없음 (finding #4)", async () => {
    const u = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const repo = new DrizzleMemberRepo(ctx.db);
    const args = { tripId: trip, userId: u, displayName: "Admin", email: "creator@example.com" };
    const results = await Promise.all([
      repo.ensureCreatorMembership(args),
      repo.ensureCreatorMembership(args),
    ]); // 동시 — 둘 다 성공, 같은 행
    expect(results[0].id).toBe(results[1].id);
    expect(await repo.countActiveAdmins(trip)).toBe(1); // 중복 insert 없음
  });
});
```

**Step 2: 실패 확인** — Run: `bun run test src/modules/members/members.repo.test.ts` · Expected: FAIL.

**Step 3: 구현**

```ts
import { and, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { tripMembers } from "../../db/schema/members.ts";
import { normalizeEmail } from "./domain/invite-token.ts";
import { ConflictError } from "../../core/errors.ts";

export interface MemberRow {
  id: string;
  trip_id: string;
  user_id: string | null;
  normalized_invited_email: string;
  role: string;
  status: string;
}
export interface CreateInviteInput {
  tripId: string;
  email: string;
  hash: string;
  expiresAt: Date;
  displayName: string;
}
export interface AcceptCasInput {
  inviteId: string;
  userId: string;
  hash: string;
  normalizedEmail: string;
}
export interface MemberRepo {
  createInvite(i: CreateInviteInput): Promise<MemberRow>;
  findByTokenHash(hash: string): Promise<MemberRow | null>;
  acceptInviteCas(i: AcceptCasInput): Promise<MemberRow | null>;
  /** 재발송: hash·expires를 **원자 단일 UPDATE**로 교체(status='invited' 가드·RETURNING). revoke→reissue 2단계 금지(finding #3). */
  rotateInviteToken(inviteId: string, hash: string, expiresAt: Date): Promise<MemberRow | null>;
  findMembership(tripId: string, userId: string): Promise<MemberRow | null>;
  countActiveAdmins(tripId: string): Promise<number>;
  ensureCreatorMembership(i: { tripId: string; userId: string; displayName: string; email: string }): Promise<MemberRow>;
}

const COLS = {
  id: tripMembers.id,
  trip_id: tripMembers.trip_id,
  user_id: tripMembers.user_id,
  normalized_invited_email: tripMembers.normalized_invited_email,
  role: tripMembers.role,
  status: tripMembers.status,
};

export class DrizzleMemberRepo<T extends Record<string, unknown>> implements MemberRepo {
  constructor(private readonly db: PostgresJsDatabase<T>) {}

  async createInvite(i: CreateInviteInput): Promise<MemberRow> {
    const norm = normalizeEmail(i.email);
    const rows = await this.db
      .insert(tripMembers)
      .values({
        trip_id: i.tripId,
        invited_email: i.email,
        normalized_invited_email: norm,
        invite_token_hash: i.hash,
        invite_token_expires_at: i.expiresAt,
        display_name: i.displayName,
        role: "member",
        status: "invited",
      })
      .returning(COLS);
    return rows[0]!;
  }

  async findByTokenHash(hash: string): Promise<MemberRow | null> {
    const rows = await this.db.select(COLS).from(tripMembers).where(eq(tripMembers.invite_token_hash, hash));
    return rows[0] ?? null;
  }

  /** 원자 CAS: 검증 predicate 전부 WHERE에 포함(TOCTOU 제거, 설계 §3·pass3·4·5). 1행=성공·0행=경쟁/이미바인딩. */
  async acceptInviteCas(i: AcceptCasInput): Promise<MemberRow | null> {
    const rows = await this.db
      .update(tripMembers)
      .set({ user_id: i.userId, status: "joined", joined_at: new Date() })
      .where(
        and(
          eq(tripMembers.id, i.inviteId),
          eq(tripMembers.status, "invited"),
          isNull(tripMembers.user_id),
          eq(tripMembers.invite_token_hash, i.hash),
          eq(tripMembers.normalized_invited_email, i.normalizedEmail),
          sql`${tripMembers.invite_token_expires_at} > now()`,
        ),
      )
      .returning(COLS);
    return rows[0] ?? null;
  }

  /** 원자 재발송: 단일 UPDATE로 hash·expires 동시 교체(status='invited' 가드). 1행=성공·0행=비-pending(이미 joined/제거). finding #3. */
  async rotateInviteToken(inviteId: string, hash: string, expiresAt: Date): Promise<MemberRow | null> {
    const rows = await this.db
      .update(tripMembers)
      .set({ invite_token_hash: hash, invite_token_expires_at: expiresAt })
      .where(and(eq(tripMembers.id, inviteId), eq(tripMembers.status, "invited")))
      .returning(COLS);
    return rows[0] ?? null;
  }

  async findMembership(tripId: string, userId: string): Promise<MemberRow | null> {
    const rows = await this.db
      .select(COLS)
      .from(tripMembers)
      .where(and(eq(tripMembers.trip_id, tripId), eq(tripMembers.user_id, userId)));
    return rows[0] ?? null;
  }

  async countActiveAdmins(tripId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(tripMembers)
      .where(and(eq(tripMembers.trip_id, tripId), eq(tripMembers.role, "admin"), eq(tripMembers.status, "joined")));
    return rows[0]?.n ?? 0;
  }

  /** 어드민 자동 멤버십(생성자 첫 로그인). **원자 멱등**(finding #4): onConflictDoNothing(uq_member_user/email)
   *  후 재read — 동시 호출에도 unique 위반을 사용자에게 노출하지 않고 동일 멤버십 반환. read-before-insert 경쟁 제거. */
  async ensureCreatorMembership(i: { tripId: string; userId: string; displayName: string; email: string }): Promise<MemberRow> {
    await this.db
      .insert(tripMembers)
      .values({
        trip_id: i.tripId,
        user_id: i.userId,
        invited_email: i.email,
        normalized_invited_email: normalizeEmail(i.email),
        display_name: i.displayName,
        role: "admin",
        status: "joined",
        joined_at: new Date(),
      })
      .onConflictDoNothing(); // uq_member_user(trip_id,user_id) 또는 uq_member_email 충돌 시 no-op
    const row = await this.findMembership(i.tripId, i.userId);
    if (!row) throw new ConflictError("failed to ensure creator membership", { tripId: i.tripId });
    return row;
  }
}
```
> 제네릭 `<T extends Record<string, unknown>>`로 `ctx.db`(typeof schema) 수용(fx의 trip-defaults repo 패턴). `rows[0]!`는 insert/returning 보장(noUncheckedIndexedAccess 대응).

**Step 4: 통과 확인** — Run: same · Expected: PASS.

**Step 5: Commit**

```bash
bun run fmt && bun run check
git add src/modules/members/members.repo.ts src/modules/members/members.repo.test.ts
git commit -m "feat(members): MemberRepo(초대 생성·원자 CAS 수락·멤버십·어드민 자동, 포트+drizzle)"
```

---

## Task 7: Invite/Members 서비스 (수락 게이팅·재발송·last-admin, TDD testcontainers PG)

**Files:** Create `src/modules/members/members.service.ts` · Test `src/modules/members/members.service.test.ts`

SSOT: 설계 §3·§4·§5·§9.5. acceptInvite 오케스트레이션: 토큰 hash→invite 조회→**email_verified·정규화 이메일 일치 검증**→원자 CAS→`user_id==me`면 멱등 성공·아니면 ConflictError. createInvite/resendInvite(이전 hash 폐기)·last-admin 가드.

**Step 1: 실패 테스트** (testcontainers PG)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, mkTrip, type Ctx } from "../../../tests/db/helpers.ts";
import { DrizzleMemberRepo } from "./members.repo.ts";
import { MembersService } from "./members.service.ts";
import { generateInviteToken, hashToken } from "./domain/invite-token.ts";
import { ForbiddenError, ConflictError } from "../../core/errors.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

function svc() {
  return new MembersService(new DrizzleMemberRepo(ctx.db), { ttlHours: 168, now: () => new Date() });
}
// 인증 principal(세션 user) — email_verified는 Better Auth가 보장하지만 매칭은 정규화 이메일로.
const actor = (userId: string, email: string) => ({ id: userId, email });

describe("MembersService.acceptInvite", () => {
  it("정규화 이메일 일치 + 유효 토큰 → joined", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const me = await mkUser(ctx.sql);
    const s = svc();
    const { token } = await s.createInvite(trip, "Guest+x@gmail.com", "Guest");
    const r = await s.acceptInvite(token, actor(me, "guest@gmail.com")); // 정규화 동일
    expect(r.status).toBe("joined");
    expect(r.user_id).toBe(me);
  });

  it("이메일 불일치 → ForbiddenError(이 trip만 거부)", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const me = await mkUser(ctx.sql);
    const s = svc();
    const { token } = await s.createInvite(trip, "invited@example.com", "G");
    await expect(s.acceptInvite(token, actor(me, "someoneelse@example.com"))).rejects.toThrow(ForbiddenError);
  });

  it("멱등 재클릭(같은 user) → 멱등 성공", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const me = await mkUser(ctx.sql);
    const s = svc();
    const { token } = await s.createInvite(trip, "idem@example.com", "G");
    await s.acceptInvite(token, actor(me, "idem@example.com"));
    const again = await s.acceptInvite(token, actor(me, "idem@example.com"));
    expect(again.status).toBe("joined");
    expect(again.user_id).toBe(me);
  });

  it("다른 user가 이미 바인딩된 토큰 → ConflictError", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const u1 = await mkUser(ctx.sql);
    const u2 = await mkUser(ctx.sql);
    const s = svc();
    const { token } = await s.createInvite(trip, "shared@example.com", "G");
    await s.acceptInvite(token, actor(u1, "shared@example.com"));
    await expect(s.acceptInvite(token, actor(u2, "shared@example.com"))).rejects.toThrow(ConflictError);
  });

  it("존재하지 않는/폐기된 토큰 → ForbiddenError", async () => {
    const s = svc();
    const { token } = generateInviteToken();
    await expect(s.acceptInvite(token, actor("x", "a@b.com"))).rejects.toThrow(ForbiddenError);
  });

  it("이미 이 trip 멤버인 actor가 다른 이메일 초대 수락 → 멱등 성공(uq_member_user raw 위반 없음, finding #3 pass2)", async () => {
    const me = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, me);
    const s = svc();
    await s.ensureCreatorMembership(trip, me, "Creator", "creator@example.com"); // me=creator(joined)
    const { token } = await s.createInvite(trip, "myother@example.com", "G"); // me의 다른 이메일로 초대
    const r = await s.acceptInvite(token, actor(me, "myother@example.com"));
    expect(r.user_id).toBe(me); // 기존 멤버십 반환(멱등) — DB 23505 미노출
    expect(r.status).toBe("joined");
  });

  it("동시 수락(같은 토큰·다른 user) → 정확히 1명 joined, 나머지 ConflictError", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const a = await mkUser(ctx.sql);
    const b = await mkUser(ctx.sql);
    const s = svc();
    const { token } = await s.createInvite(trip, "race@example.com", "G");
    const results = await Promise.allSettled([
      s.acceptInvite(token, actor(a, "race@example.com")),
      s.acceptInvite(token, actor(b, "race@example.com")),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok.length).toBe(1); // CAS 원자성: 1명만
  });
});

describe("MembersService.createInvite 중복 (finding #3 pass4)", () => {
  it("같은 trip·같은 정규화 이메일 재초대 → ConflictError(raw 500 아님)", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const s = svc();
    await s.createInvite(trip, "dup@example.com", "G");
    await expect(s.createInvite(trip, "dup@example.com", "G2")).rejects.toThrow(ConflictError);
  });
  it("이미 멤버인 이메일로 초대 → ConflictError", async () => {
    const u = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const s = svc();
    await s.ensureCreatorMembership(trip, u, "C", "member@example.com");
    await expect(s.createInvite(trip, "member@example.com", "G")).rejects.toThrow(ConflictError);
  });
});

describe("MembersService.resendInvite", () => {
  it("재발송 → 이전 토큰 무효·새 토큰 유효", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const me = await mkUser(ctx.sql);
    const s = svc();
    const { token: old } = await s.createInvite(trip, "re@example.com", "G");
    const invite = await new DrizzleMemberRepo(ctx.db).findByTokenHash(hashToken(old));
    const { token: fresh } = await s.resendInvite(invite!.id);
    await expect(s.acceptInvite(old, actor(me, "re@example.com"))).rejects.toThrow(ForbiddenError); // 폐기
    const r = await s.acceptInvite(fresh, actor(me, "re@example.com"));
    expect(r.status).toBe("joined");
  });
});

describe("MembersService.assertNotLastAdmin", () => {
  it("마지막 어드민 강등 차단 → ForbiddenError", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const s = svc();
    await s.ensureCreatorMembership(trip, admin, "Admin", "admin@example.com");
    await expect(s.assertNotLastAdmin(trip)).rejects.toThrow(ForbiddenError);
  });
});
```

**Step 2: 실패 확인** — Run: `bun run test src/modules/members/members.service.test.ts` · Expected: FAIL.

**Step 3: 구현**

```ts
import { ConflictError, ForbiddenError } from "../../core/errors.ts";
import { generateInviteToken, hashToken, normalizeEmail } from "./domain/invite-token.ts";
import type { MemberRepo, MemberRow } from "./members.repo.ts";

export interface Actor {
  id: string;
  email: string; // 세션 user의 이메일(Better Auth, email_verified 보장)
}
/** 발송용 명령(서비스는 반환만, 실 발송은 caller/후속 — finding #1 pass2). */
export interface InviteCommand {
  token: string; // raw(링크 임베드용)
  link: string; // /invite/{token}
  inviteId: string;
}
interface Opts {
  ttlHours: number;
  now?: () => Date;
}

const isUniqueViolation = (e: unknown): boolean => (e as { code?: string } | null)?.code === "23505";

export class MembersService {
  private readonly now: () => Date;
  constructor(
    private readonly repo: MemberRepo,
    private readonly opts: Opts,
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  private expiry(): Date {
    return new Date(this.now().getTime() + this.opts.ttlHours * 3600_000);
  }

  /** 초대 생성 → **delivery command 반환**(token 항상 반환). 실 발송은 caller가 link로 수행(서비스는 IO 발송 안 함, finding #1 pass2). */
  async createInvite(tripId: string, email: string, displayName: string): Promise<InviteCommand> {
    const { token, hash } = generateInviteToken();
    let row: MemberRow;
    try {
      row = await this.repo.createInvite({ tripId, email, hash, expiresAt: this.expiry(), displayName });
    } catch (e) {
      // uq_member_email(정규화 이메일 중복·이미 멤버)는 사용자 행위 → ConflictError(409)로 매핑(raw 500 방지, finding #3 pass4).
      if (isUniqueViolation(e)) throw new ConflictError("already invited or a member of this trip", { tripId });
      throw e;
    }
    return { token, link: `/invite/${token}`, inviteId: row.id };
  }

  /** 재발송: 원자 rotateInviteToken 단일 호출 + **새 링크 반환**(발송은 caller). 부분실패 상태 없음(finding #3·pass2 #1). */
  async resendInvite(inviteId: string): Promise<InviteCommand> {
    const { token, hash } = generateInviteToken();
    const row = await this.repo.rotateInviteToken(inviteId, hash, this.expiry());
    if (!row) throw new ConflictError("invite not pending (already joined or removed)", { inviteId });
    return { token, link: `/invite/${token}`, inviteId };
  }

  /** 설계 §3: 토큰→invite, 정규화 이메일 매칭, 원자 CAS. 이미 멤버면 멱등 성공, 경쟁/만료/다른 user면 ConflictError. */
  async acceptInvite(token: string, actor: Actor): Promise<MemberRow> {
    const hash = hashToken(token);
    const invite = await this.repo.findByTokenHash(hash);
    if (!invite) throw new ForbiddenError("invite not found or revoked");
    // 권한 = 정규화 이메일 매칭(토큰은 포인터). 불일치 → 이 trip만 거부(세션 유지, 설계 §3·§5).
    if (invite.normalized_invited_email !== normalizeEmail(actor.email)) {
      throw new ForbiddenError("invite email mismatch", { tripId: invite.trip_id });
    }
    // 이미 이 trip 멤버(다른 행 경유 포함)면 멱등 성공 — uq_member_user raw 위반 방지(finding #3 pass2).
    const existing = await this.repo.findMembership(invite.trip_id, actor.id);
    if (existing && existing.status === "joined") return existing;
    let bound: MemberRow | null;
    try {
      bound = await this.repo.acceptInviteCas({ inviteId: invite.id, userId: actor.id, hash, normalizedEmail: invite.normalized_invited_email });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e; // 동시 다른행 바인딩 → 23505 방어
      const m = await this.repo.findMembership(invite.trip_id, actor.id);
      if (m && m.status === "joined") return m;
      throw new ConflictError("invite conflict", { tripId: invite.trip_id });
    }
    if (bound) return bound; // 1행 → 성공
    const after = await this.repo.findMembership(invite.trip_id, actor.id);
    if (after && after.status === "joined") return after; // 멱등(동시 수락·재클릭)
    throw new ConflictError("invite already bound or expired", { tripId: invite.trip_id });
  }

  async ensureCreatorMembership(tripId: string, userId: string, displayName: string, email: string): Promise<MemberRow> {
    return this.repo.ensureCreatorMembership({ tripId, userId, displayName, email });
  }

  /** 마지막 어드민 가드(§9.5): 활성 어드민 ≤1이면 강등/비활성 차단. */
  async assertNotLastAdmin(tripId: string): Promise<void> {
    if ((await this.repo.countActiveAdmins(tripId)) <= 1) {
      throw new ForbiddenError("cannot remove the last admin", { tripId });
    }
  }
}
```
> ⚠️ `acceptInvite`의 멱등 경로: CAS가 0행이면 (a) 이미 같은 user가 joined(멱등 성공) 또는 (b) 다른 user/만료(ConflictError). `findByTokenHash`는 토큰 폐기 전이라 invite row를 반환할 수 있으나, joined 후 hash 보존 여부는 repo 정책. **단순·안전을 위해**: CAS 0행 시 `findMembership(tripId, actor.id)`로 내 멤버십이 joined인지 확인 → 멱등 성공, 아니면 ConflictError. (위 코드의 `current` 판정.)
> `resendInvite`는 Task 6의 원자 `rotateInviteToken`만 호출(별도 revoke/reissue 없음, finding #3). repo 변경 없음.

**Step 4: 통과 확인** — Run: same · Expected: PASS.

**Step 5: Commit**

```bash
bun run fmt && bun run check
git add src/modules/members/members.service.ts src/modules/members/members.service.test.ts
git commit -m "feat(members): Invite/Members 서비스(수락 게이팅·멱등·원자 재발송·last-admin 가드)"
```

---

## Task 8: 통합 보안 테스트 — 얇은 accept 라우트 (mounted app, TDD)

**Files:** Create `src/modules/members/members.controller.ts`(얇은 라우트) · Test `src/modules/members/members.integration.test.ts`

SSOT: 설계 §8. **CSRF origin + requireAuth + 서비스 CAS**를 한 앱에서 end-to-end. 풀 OpenAPI DTO는 후속 — 본 Task는 `app.request`로 plain JSON 라우트 검증.

**Step 1: 실패 테스트** (testcontainers PG + 주입 세션 리졸버 + CSRF + Origin 헤더)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { startDb, mkUser, mkTrip, type Ctx } from "../../../tests/db/helpers.ts";
import { DrizzleMemberRepo } from "./members.repo.ts";
import { MembersService } from "./members.service.ts";
import { registerAcceptRoute } from "./members.controller.ts";
import { csrf } from "../../core/csrf.ts";
import { requireAuth, type SessionResolver } from "../../core/guards.ts";
import { registerErrorFilter } from "../../core/errors.ts"; // Task 9에서 추가(없으면 본 Task에서 생성)

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

const ORIGIN = "https://app.ukyi.app";
const corsMw = cors({
  origin: [ORIGIN],
  credentials: true,
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type"],
});
function appFor(userId: string, email: string) {
  const app = new Hono();
  registerErrorFilter(app);
  app.use("*", corsMw); // CORS → CSRF → 라우트 (main.ts 동일 체인)
  app.use("*", csrf([ORIGIN]));
  const resolver: SessionResolver = async () => ({ user: { id: userId } });
  const service = new MembersService(new DrizzleMemberRepo(ctx.db), { ttlHours: 168 });
  // accept 라우트: requireAuth + 본문에서 actor.email은 세션에서 — 테스트는 헤더로 주입 단순화
  registerAcceptRoute(app, { service, resolver, emailOf: async () => email });
  return app;
}

async function makeInvite(trip: string, email: string) {
  const s = new MembersService(new DrizzleMemberRepo(ctx.db), { ttlHours: 168 });
  const { token } = await s.createInvite(trip, email, "G");
  return token;
}

describe("POST /invites/:token/accept (통합)", () => {
  it("정확 Origin + 세션 + 이메일 일치 → 200 joined", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const me = await mkUser(ctx.sql);
    const token = await makeInvite(trip, "ok@example.com");
    const res = await appFor(me, "ok@example.com").request(`/invites/${token}/accept`, {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("joined");
  });

  it("형제 Origin → 403(CSRF, 서비스 도달 전 차단)", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const me = await mkUser(ctx.sql);
    const token = await makeInvite(trip, "csrf@example.com");
    const res = await appFor(me, "csrf@example.com").request(`/invites/${token}/accept`, {
      method: "POST",
      headers: { origin: "https://evil.ukyi.app" },
    });
    expect(res.status).toBe(403);
  });

  it("Origin 누락 → 403", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const me = await mkUser(ctx.sql);
    const token = await makeInvite(trip, "noorigin@example.com");
    const res = await appFor(me, "noorigin@example.com").request(`/invites/${token}/accept`, { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("이메일 불일치 → 403(problem+json code=ForbiddenError)", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const me = await mkUser(ctx.sql);
    const token = await makeInvite(trip, "real@example.com");
    const res = await appFor(me, "attacker@example.com").request(`/invites/${token}/accept`, {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("ForbiddenError");
  });

  // ── CORS (credentialed 교차 서브도메인, finding pass3) ──
  it("CORS preflight(OPTIONS) 정확 origin → ACAO·ACAC 헤더", async () => {
    const res = await appFor("u", "u@example.com").request("/invites/x/accept", {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "POST" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
  it("CORS 외부 origin → ACAO 미부여(브라우저 거부)", async () => {
    const res = await appFor("u", "u@example.com").request("/invites/x/accept", {
      method: "OPTIONS",
      headers: { origin: "https://evil.com", "access-control-request-method": "POST" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("credentialed POST 응답에 ACAO·ACAC", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const me = await mkUser(ctx.sql);
    const token = await makeInvite(trip, "cors-ok@example.com");
    const res = await appFor(me, "cors-ok@example.com").request(`/invites/${token}/accept`, {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
});
```

**Step 2: 실패 확인** — Run: `bun run test src/modules/members/members.integration.test.ts` · Expected: FAIL.

**Step 3: 구현** — `members.controller.ts`(얇은 라우트)

```ts
import type { Hono } from "hono";
import { requireAuth, type SessionResolver } from "../../core/guards.ts";
import type { MembersService } from "./members.service.ts";

interface Deps {
  service: MembersService;
  resolver: SessionResolver;
  emailOf: (userId: string) => Promise<string>; // 세션 user.id → 이메일(운영은 Better Auth user, 테스트는 stub)
}

/** 얇은 accept 라우트(풀 OpenAPI DTO는 후속 슬라이스). CSRF는 앱 전역 미들웨어가 선처리. */
export function registerAcceptRoute(app: Hono, deps: Deps): void {
  app.post("/invites/:token/accept", requireAuth(deps.resolver), async (c) => {
    const user = c.get("user");
    const email = await deps.emailOf(user.id);
    const row = await deps.service.acceptInvite(c.req.param("token"), { id: user.id, email });
    return c.json({ status: row.status, role: row.role, trip_id: row.trip_id });
  });
}
```
> 운영의 `emailOf`는 Better Auth 세션 user의 이메일(`auth.api.getSession` 결과). 본 Task는 stub. 풀 라우트(zod-openapi DTO·다른 멤버 엔드포인트)는 다음 슬라이스.
> `registerErrorFilter`가 없으면 본 Task에서 `core/errors.ts`에 추가(아래 Task 9 Step 참조)하고 import. AppError→problem+json(`{code,status}` 포함) 매핑.

**Step 4: 통과 확인** — Run: same · Expected: PASS.

**Step 5: Commit**

```bash
bun run fmt && bun run check
git add src/modules/members/members.controller.ts src/modules/members/members.integration.test.ts
git commit -m "test(members): 초대수락 통합(CORS·CSRF origin·세션·이메일 매칭 end-to-end)"
```

---

## Task 9: onError 필터 + 컴포지션 배선 + opt-in 실 OAuth smoke

**Files:** Modify `src/core/errors.ts`(registerErrorFilter 추가) · Modify `src/main.ts`(배선) · Create `src/modules/auth/oauth.smoke.test.ts`(키 없으면 skip)

**Step 1: `core/errors.ts`에 onError 필터 추가** (없을 경우)

```ts
import type { Hono } from "hono";
// ... 기존 AppError 등 ...

/** RFC 9457 problem+json 매핑. AppError는 code/status, 그 외 500. */
export function registerErrorFilter(app: Hono): void {
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(
        { type: "about:blank", title: err.code, status: err.status, code: err.code, detail: err.message, meta: err.meta },
        err.status as never,
      );
    }
    return c.json({ type: "about:blank", title: "InternalError", status: 500, code: "InternalError" }, 500);
  });
}
```
> 이미 존재하면 본 스텝 생략. Task 8이 import하므로 그 전에 존재해야 함 — Task 8 착수 시 없으면 먼저 추가(같은 커밋 또는 본 Task를 8 앞으로 당겨도 됨).

**Step 2: `main.ts` 배선** — Better Auth 마운트 + CORS + `__Host-` 정규화 + onError(컴포지션 루트, 런타임만)

```ts
import IoRedis from "ioredis";
import { cors } from "hono/cors";
import { createApp } from "./core/openapi.ts";
import { createCore } from "./core/composition.ts";
import { registerErrorFilter } from "./core/errors.ts";
import { enforceHostCookie } from "./core/host-cookie.ts";
import { createAuth } from "./auth.ts";
import { mountAuth } from "./modules/auth/mount.ts";

const core = createCore();
const app = createApp();

// auth 싱글톤은 컴포지션 루트에서 구성(finding #2 pass2): db·redis·시크릿·origin 주입. top-level 싱글톤 없음.
const auth = createAuth({
  db: core.db,
  redis: new IoRedis(core.config.VALKEY_URL),
  secret: core.config.BETTER_AUTH_SECRET,
  baseURL: core.config.BETTER_AUTH_URL,
  trustedOrigins: core.config.WEB_ORIGINS,
  useSecureCookies: core.config.USE_SECURE_COOKIES,
  google:
    core.config.GOOGLE_CLIENT_ID && core.config.GOOGLE_CLIENT_SECRET
      ? { clientId: core.config.GOOGLE_CLIENT_ID, clientSecret: core.config.GOOGLE_CLIENT_SECRET }
      : undefined,
});

// CORS(credentialed 교차 서브도메인) → __Host- 쿠키 정규화 → Better Auth 마운트.
// 와일드카드 금지(credentials와 양립 불가). 미배선 시 host-only 쿠키·CSRF가 맞아도 브라우저가 응답 차단(finding pass3).
const corsMw = cors({
  origin: core.config.WEB_ORIGINS, // 배열 정확 일치 → 매칭 origin echo, 미매칭은 헤더 미부여(브라우저 거부)
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
});
app.use("/api/auth/*", corsMw); // ⚠️ Better Auth가 자체 CORS 헤더를 emit하면 중복 ACAO 방지 위해 reconcile(docs 확인)
app.use("/api/auth/*", enforceHostCookie({ secure: core.config.USE_SECURE_COOKIES })); // 세션 Set-Cookie를 __Host- 로 정규화(finding #1 pass5)
mountAuth(app, auth);

app.get("/health", (c) => c.json({ status: "ok" }));
registerErrorFilter(app);

// ⚠️ 초대수락 라우트는 **test-only**(Task 8) — 비버전 mutation ship 금지. 프로덕션 `/v1` 라우트 + OpenAPI DTO + cors·csrf·guards·MembersService 배선은 다음 API 슬라이스(finding #2 pass5).
//    (csrf·cors·guards·MembersService·MemberRepo·host-cookie는 라이브러리로 구비·테스트 완료, /v1 배선만 후속.)

export default { port: 3000, fetch: app.fetch };
```
> ⚠️ 본 슬라이스 main.ts는 **auth 런타임만** ship(Better Auth `/api/auth/*` + CORS + `__Host-` 정규화 + onError). 커스텀 `/v1` 라우트(csrf·guards·MembersService 배선)는 다음 API 슬라이스. Better Auth가 자체 CORS 헤더를 emit하면 ACAO 중복을 docs로 reconcile.

**Step 3: opt-in 실 OAuth smoke** `src/modules/auth/oauth.smoke.test.ts` (키 없으면 skip — 슬라이스 CI 무영향)

```ts
import { describe, it, expect } from "vitest";

const e = process.env;
const hasKeys =
  !!e.GOOGLE_CLIENT_ID && !!e.GOOGLE_CLIENT_SECRET && !!e.VALKEY_URL && !!e.DATABASE_URL && !!e.BETTER_AUTH_SECRET && !!e.BETTER_AUTH_URL;

describe.skipIf(!hasKeys)("Better Auth 실 OAuth smoke (pre-deploy)", () => {
  it("auth 인스턴스 부팅 + /api/auth 핸들러 응답", async () => {
    const { createAuth } = await import("../../auth.ts");
    const { createDb } = await import("../../db/client.ts");
    const IoRedis = (await import("ioredis")).default;
    const redis = new IoRedis(e.VALKEY_URL!);
    try {
      const auth = createAuth({
        db: createDb(e.DATABASE_URL!),
        redis,
        secret: e.BETTER_AUTH_SECRET!,
        baseURL: e.BETTER_AUTH_URL!,
        trustedOrigins: (e.WEB_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        useSecureCookies: false,
        google: { clientId: e.GOOGLE_CLIENT_ID!, clientSecret: e.GOOGLE_CLIENT_SECRET! },
      });
      const res = await auth.handler(new Request("http://localhost/api/auth/ok"));
      expect([200, 401, 404]).toContain(res.status);
    } finally {
      redis.disconnect();
    }
  });
});
```
> 실 Google OAuth 콜백·email_verified 거부·host-only 쿠키 Set-Cookie는 **pre-deploy 수동 인수**(실 키·실 Valkey)로 1회 검증·증거 기록(DoD). 슬라이스 CI는 skip 유지.

**Step 4: 통과 확인** — Run: `bun run test` (전체) · Expected: 기존 + 신규 PASS, smoke skip. `bun run check` exit 0.

**Step 5: Commit**

```bash
bun run fmt && bun run check
git add src/core/errors.ts src/main.ts src/modules/auth/oauth.smoke.test.ts
git commit -m "feat(auth): onError 필터·컴포지션 배선(Better Auth 마운트·CORS·__Host- 정규화)·opt-in OAuth smoke"
```

---

## 완료 기준 (DoD)
- [ ] `bun run check` PASS (oxlint+oxfmt+tsc)
- [ ] `bun run test` PASS (기반 95 + 인증·초대: 토큰/이메일 순수·email_verified·SecondaryStorage(redis)·auth 불변식·CSRF·guards·MemberRepo CAS(PG)·MembersService(PG)·통합)
- [ ] 신규 마이그레이션 없음(스키마 무변경) — `bun run db:generate`가 "No schema changes"
- [ ] `git status` clean, 커밋 한국어·AI 마커 없음·허용 type만
- [ ] **보안 회귀 가드 존재**: CSRF(정확 Origin·형제 거부·Origin 누락 거부)·**CORS(정확 origin echo·Allow-Credentials·preflight·외부 origin 거부)**·CAS 동시성(1명만 joined)·이미-멤버 멱등(uq_member_user raw 미노출)·email 불일치 403·email_verified=false 거부·시크릿 ≥32·계정링킹 금지 불변식
- [ ] **중복 초대 처리**: 같은 trip·같은 정규화 이메일 재초대·이미-멤버 초대 → `ConflictError`(409, raw 500 아님)
- [ ] **pre-deploy 인수(배포 前):** 실 Google OAuth·실 Valkey로 1회 — ① email_verified=false 계정 로그인 거부, ② 세션 쿠키 **Set-Cookie 이름이 `__Host-`로 시작 + Secure + Path=/ + Domain 없음**(prod https), ③ `app.ukyi.app→api.ukyi.app` credentialed 요청에 쿠키 전송 + CORS 헤더(ACAO 정확·ACAC true), ④ Better Auth `/api/auth/callback/google` 동작 — 증거 기록. **`__Host-` 미충족 시 릴리스 중단.** 슬라이스 CI엔 키 불요(skip 유지)

## 후속 슬라이스 예고
**API 라우트+DTO+OpenAPI 생성** (멤버/초대/지출/정산 풀 라우트·`*.schema.ts` DTO·`gen:openapi`·Hey API·Idempotency-Key·커서 페이지네이션·낙관적 version·**초대수락 `/v1` 라우트 프로덕션 배선**·**resend 발송 멱등 아웃박스**) → **resolveFx를 expense 저장경로에 통합**(card_billed 분기·편집 재계산·trip_default 승격 in-tx) → **레이트리밋/관측 슬라이스**(Better Auth rateLimit 튜닝·provider single-flight·onWarn→pino/메트릭·Resend 실 발송) → 프론트엔드.

---

## Adversarial review dispositions

Codex 적대적 리뷰(working-tree 모드) **5 passes**. **총 13건 finding 전부 Accept·반영**(1건은 스코프-이관: pass4 #2 resend 멱등은 발송 슬라이스로 forward-ref). high 추세 4→3→1→2→1, pass1·2 코어 수정이 새 각도를 열어 pass3~5는 운영·배선 차원(CORS·`__Host-` 메커니즘·`/v1` 계약)으로 이동. cap은 3패스이나 **사용자 승인으로 pass4·5 연장**, 최종 pass5 verdict는 `needs-attention`(2건)이었고 그 2건(enforceHostCookie 미들웨어·라우트 test-only)을 반영한 뒤 **사용자 결정으로 pass6 없이 확정**. 이 섹션은 확정 후 감사추적이며 재리뷰 대상이 아니다.

| pass | # | finding | sev | 결정 | 반영 |
|---|---|---|---|---|---|
| 1 | 1 | `BETTER_AUTH_SECRET` min(1) 약한 시크릿 | high | Accept | `z.string().min(32)` + config 테스트(Task 0) |
| 1 | 2 | 이메일 정규화가 비-Gmail +tag도 제거(principal 붕괴) | high | Accept | **Gmail 한정** canonicalize, 비-Gmail 보존(Task 1) |
| 1 | 3 | resend revoke→reissue 2단계 부분실패 | high | Accept | 원자 `rotateInviteToken` 단일 UPDATE(Task 6·7) |
| 1 | 4 | `ensureCreatorMembership` read-before-insert 경쟁 | med | Accept | `onConflictDoNothing`+재read 원자 멱등(Task 6) |
| 2 | 1 | createInvite send 실패 토큰 고아 + resend 미발송 | high | Accept | **delivery-command 반환**(mailer를 critical path 제거, Task 7) |
| 2 | 2 | auth 싱글톤이 import 시 env+Redis 평가 | high | Accept | **완전 DI `createAuth(deps)`**, 싱글톤 main.ts 이관(Task 3·9) |
| 2 | 3 | CAS가 이미-멤버에 raw `uq_member_user` 위반 | med | Accept | `findMembership` 선검사 + 23505 catch→멱등/Conflict(Task 7) |
| 3 | 1 | credentialed 교차 서브도메인에 CORS 미배선 | high | Accept | `hono/cors`(정확 origin·credentials)·통합테스트·DoD(Task 8·9) |
| 4 | 1 | `__Host-`를 fallback 취급(형제 cookie-tossing 잔존) | high | Accept | `__Host-` 필수화(pass5에서 메커니즘 확정) |
| 4 | 2 | resend 회전이 재시도에 비멱등(죽은 링크) | high | **Accept(스코프 이관)** | resendInvite는 원자 회전 primitive·**발송 멱등(Idempotency-Key §5+아웃박스)은 발송 슬라이스**로 forward-ref(본 슬라이스 발송 없음→링크 경쟁 없음) |
| 4 | 3 | 중복 초대 → raw 500 | med | Accept | createInvite가 23505 catch→`ConflictError`+테스트(Task 7) |
| 5 | 1 | cookiePrefix가 실제 `__Host-` 미생성(BA `__Secure-` prepend) | high | Accept | **`enforceHostCookie` 응답 정규화 미들웨어** + Set-Cookie 헤더 테스트(Task 5·9) |
| 5 | 2 | accept 라우트가 `/v1` 계약 우회(비버전 ship) | med | Accept | 라우트 **test-only**, main.ts 프로덕션 배선 제거(Task 8·9) |

**최종 pass5 `summary`:** "the hard cookie isolation requirement is contradicted by the concrete Better Auth configuration, and the accept route is planned outside the API version contract." → enforceHostCookie 미들웨어(헤더 테스트로 `__Host-` 결정적 보장)·라우트 test-only로 해소. 잔여 deferred 1건(resend 발송 멱등)은 Out-of-scope에 forward-ref.

---

## Execution directives
- **Skill:** `executing-plans`로 **별도 세션, 이 워크트리**(`~/workspace/trip-mate-api/.worktrees/auth-invite`, 브랜치 `feat/auth-invite`)에서 task-by-task 구현.
- **연속 실행:** 일상 리뷰로 멈추지 말 것. 진짜 블로커(의존성 부재·반복 실패 검증·모순 지시·치명적 plan 공백)에서만 정지. Docker 데몬 필요(testcontainers PG16·redis). **Better Auth 1.6.22 옵션 형태(secondaryStorage·mapProfileToUser·advanced 쿠키·`auth.api.getSession`)는 docs/타입으로 확인**하며, 의미(host-only `__Host-`·verified-only·링킹금지·secondaryStorage)는 고정. **prod에서 세션 Set-Cookie가 `__Host-`를 만족 못하면 구현 중단·보고**(약한 host-only 진행 금지).
- **커밋 — 직접 적용, `Skill(commit)` 호출 금지:**
  - 한국어 메시지, **AI 마커 금지**(`🤖`·`Co-Authored-By: Claude` 등).
  - 형식 `<type>(<scope>): 한국어 설명`. **type은 `feat`/`fix`/`refactor`/`docs`/`style`/`test`/`chore`만**.
  - 그룹화: 같은 모듈 dir·같은 목적 together; config·테스트·문서·독립 변경은 각자 커밋. 각 Task Commit 스텝에서 현재 `feat/auth-invite` 워크트리에 직접.
  - 포맷: 새 .ts 후 `bun run fmt`→`bun run check`. oxfmt가 `.md`·`src/db/migrations/**` 제외.
- **시작점:** Task 0(env)→9 순서. SSOT 충돌 시 `docs/plans/2026-06-29-auth-invite-design.md`(인증·초대 설계) > 본 plan > `api-contract-design` > `architecture` > PRD.
