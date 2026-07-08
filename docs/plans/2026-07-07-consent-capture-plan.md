# PB-1 서버측 동의 캡처 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `user_consents` 영속 테이블 + `consents` 모듈(전용 엔드포인트)을 만들고, 사용내역 파싱 파이프라인이 외부 LLM 전송 **직전**에 `llm_disclosure` 동의를 **fail-closed**로 기록하도록 배선해 PB-1(P-1 프로덕션 블로커)을 해소한다.

**Architecture:** 기존 모듈 패턴(schema→repo→service→controller, DI 컴포지션 루트) 그대로 미러. 동의 기록은 `(user_id, consent_type, document_version)` unique 인덱스로 일회성-per-version 멱등(`ON CONFLICT DO NOTHING`). parse는 공용 `runParsePipeline`에서 쿼터 통과 후·`run()` 전에 `recordDisclosure` 호출(throw 시 파싱 중단 = fail-closed). `ConsentService`는 항상 배선되는 필수 dep이라 fail-closed가 타입 레벨에서 강제된다.

**Tech Stack:** TypeScript(strict: noUncheckedIndexedAccess·exactOptionalPropertyTypes), Hono + @hono/zod-openapi, Drizzle ORM(postgres-js, `casing: snake_case`), drizzle-kit 마이그레이션, Vitest + @testcontainers/postgresql, Better Auth(`user.id` = **text**).

**설계 근거:** `docs/plans/2026-07-07-consent-capture-design.md` · `docs/production-blockers.md` PB-1.

---

## Pre-flight (이미 완료된 상태 — 확인만)

- 브랜치: `feat/consent-capture` (설계문서 커밋 `650e0e5` 존재). 아니면 `git checkout -b feat/consent-capture`.
- 승인된 결정: 동의=전용 엔드포인트 / 강제=기록만(FE 게이트) / llm_disclosure=일회성(버전별) / parse 기록=**fail-closed**.
- ⚠️ 설계문서엔 미인증을 "401"로 적었으나, 이 repo의 `requireAuth`는 `ForbiddenError(403)`을 던진다 → **구현·테스트는 403** 사용(본 계획이 SSOT).

---

## Task 1: `user_consents` 스키마 + 마이그레이션

**Files:**
- Create: `src/db/schema/consents.ts`
- Modify: `src/db/schema/index.ts` (배럴에 export 추가)
- Generate: `src/db/migrations/XXXX_*.sql` (+ `meta/` 스냅샷 — drizzle-kit이 생성)

**Step 1: 스키마 파일 작성**

`src/db/schema/consents.ts`:
```ts
import { check, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk } from "./_shared.ts";
import { user } from "./auth-schema.ts";

/** 서버측 동의 기록(PB-1) — 가입·초대수락·사용내역파싱 시점의 약관/처리방침/LLM고지 동의를 영속 기록.
 *  불변 append-only 이벤트라 updated_at 없음(accepted_at만). user.id는 Better Auth text. */
export const userConsents = pgTable(
  "user_consents",
  {
    id: pk(),
    user_id: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    consent_type: text().notNull(), // tos | privacy | llm_disclosure
    document_version: text().notNull(), // 서버 소유 문서 버전
    source: text().notNull(), // signup | invite_accept | usage_parse | settings
    accepted_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
    ip: text(), // 감사용(nullable, best-effort)
  },
  (t) => [
    // 일회성-per-version 멱등의 근거 — 재수락 = ON CONFLICT DO NOTHING. (user_id) prefix라 listByUser도 커버.
    uniqueIndex("uq_user_consent").on(t.user_id, t.consent_type, t.document_version),
    check("consent_type_check", sql`${t.consent_type} IN ('tos','privacy','llm_disclosure')`),
    check(
      "consent_source_check",
      sql`${t.source} IN ('signup','invite_accept','usage_parse','settings')`,
    ),
  ],
);
```

**Step 2: 배럴 export 추가**

`src/db/schema/index.ts`에 한 줄 추가(기존 `export * from "./expense-drafts.ts";` 등과 같은 그룹):
```ts
export * from "./consents.ts";
```

**Step 3: 마이그레이션 생성**

Run: `bun run db:generate`
Expected: `src/db/migrations/`에 새 `.sql` 파일 1개(`CREATE TABLE "user_consents"` + unique index + 2 check + FK) 생성, `meta/_journal.json`·스냅샷 갱신. 새 테이블이라 비대화형.

**Step 4: 생성 SQL 육안 확인**

새 마이그레이션 파일을 열어 `CREATE TABLE "user_consents"`, `uq_user_consent` unique index, 2개 CHECK, `user_id` FK(`ON DELETE cascade`)가 있는지 확인. (다른 테이블 diff가 섞였으면 스키마 드리프트이므로 중단하고 조사.)

**Step 5: 컴파일 확인**

Run: `bun run typecheck`
Expected: PASS (스키마만 추가 — 소비처 없음).

**Step 6: Commit**
```bash
git add src/db/schema/consents.ts src/db/schema/index.ts src/db/migrations
git commit -m "feat(consents): user_consents 스키마·마이그레이션"
```

---

## Task 2: 동의 버전 config

**Files:**
- Create: `src/modules/consents/consents.config.ts`

**Step 1: 작성**
```ts
/** 서버 소유 동의 문서 버전(placeholder). 실 약관/개인정보 처리방침 확정 시 owner가 갱신 — 버전 변경 시 재동의. */
export const CONSENT_VERSIONS = {
  tos: "2026-07-07",
  privacy: "2026-07-07",
  llm_disclosure: "2026-07-07",
} as const;
```

**Step 2: Commit**
```bash
git add src/modules/consents/consents.config.ts
git commit -m "feat(consents): 동의 문서 버전 상수(CONSENT_VERSIONS)"
```

---

## Task 3: zod 스키마(요청/응답 계약)

**Files:**
- Create: `src/modules/consents/consents.schema.ts`

**Step 1: 작성**
```ts
import { z } from "@hono/zod-openapi";

export const consentTypeEnum = z.enum(["tos", "privacy", "llm_disclosure"]);
// 클라이언트 지정 시점 — usage_parse는 서버 내부(parse 파이프라인) 전용이라 제외.
export const consentSourceEnum = z.enum(["signup", "invite_accept", "settings"]);

export const postConsentsRequestSchema = z
  .object({
    consents: z
      .array(z.object({ type: consentTypeEnum, version: z.string().min(1).max(64) }))
      .min(1)
      .max(10),
    source: consentSourceEnum,
  })
  .openapi("PostConsentsRequest");

export const consentRecordSchema = z
  .object({ type: consentTypeEnum, version: z.string(), accepted_at: z.string() })
  .openapi("ConsentRecord");

export const postConsentsResponseSchema = z
  .object({ recorded: z.array(consentRecordSchema) })
  .openapi("PostConsentsResponse");

export const getConsentsResponseSchema = z
  .object({
    current: z.object({ tos: z.string(), privacy: z.string(), llm_disclosure: z.string() }),
    accepted: z.array(consentRecordSchema),
  })
  .openapi("GetConsentsResponse");
```

**Step 2: 컴파일**

Run: `bun run typecheck` → PASS.

**Step 3: Commit**
```bash
git add src/modules/consents/consents.schema.ts
git commit -m "feat(consents): 요청·응답 zod 스키마"
```

---

## Task 4: repo (멱등 INSERT + 조회) — TDD(testcontainer)

**Files:**
- Create: `src/modules/consents/consents.repo.ts`
- Test: `src/modules/consents/consents.repo.test.ts`

> ⚠️ 리포 테스트는 Docker(testcontainers)로 실 Postgres를 띄우고 `./src/db/migrations`를 적용한다 → **Task 1 마이그레이션이 반드시 선행**. Docker 데몬 필요.

**Step 1: 실패 테스트 작성**

`src/modules/consents/consents.repo.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkUser, startDb, type Ctx } from "../../../tests/db/helpers.ts";
import { DrizzleConsentRepo, type ConsentRepo } from "./consents.repo.ts";

let ctx: Ctx;
let repo: ConsentRepo;
beforeAll(async () => {
  ctx = await startDb();
  repo = new DrizzleConsentRepo(ctx.db);
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

describe("DrizzleConsentRepo", () => {
  it("insertMany + listByUser — tos·privacy 기록 후 조회(accepted_at 포함)", async () => {
    const u = await mkUser(ctx.sql);
    await repo.insertMany([
      { user_id: u, consent_type: "tos", document_version: "v1", source: "signup" },
      { user_id: u, consent_type: "privacy", document_version: "v1", source: "signup" },
    ]);
    const rows = await repo.listByUser(u);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.consent_type).sort()).toEqual(["privacy", "tos"]);
    expect(rows[0]!.accepted_at).toBeInstanceOf(Date);
  });

  it("멱등 — 같은 (user,type,version) 재삽입 no-op(ON CONFLICT DO NOTHING)", async () => {
    const u = await mkUser(ctx.sql);
    await repo.insertMany([
      { user_id: u, consent_type: "tos", document_version: "v1", source: "signup" },
    ]);
    await repo.insertMany([
      { user_id: u, consent_type: "tos", document_version: "v1", source: "settings" },
    ]);
    expect(await repo.listByUser(u)).toHaveLength(1);
  });

  it("버전 다르면 별도 행(재동의)", async () => {
    const u = await mkUser(ctx.sql);
    await repo.insertMany([
      { user_id: u, consent_type: "tos", document_version: "v1", source: "signup" },
    ]);
    await repo.insertMany([
      { user_id: u, consent_type: "tos", document_version: "v2", source: "settings" },
    ]);
    expect(await repo.listByUser(u)).toHaveLength(2);
  });

  it("ip 저장(감사용)", async () => {
    const u = await mkUser(ctx.sql);
    await repo.insertMany([
      {
        user_id: u,
        consent_type: "llm_disclosure",
        document_version: "v1",
        source: "usage_parse",
        ip: "1.2.3.4",
      },
    ]);
    const rows = await ctx.sql`select ip from user_consents where user_id = ${u}`;
    expect(rows[0]!.ip).toBe("1.2.3.4");
  });

  it("빈 배열 no-op", async () => {
    const u = await mkUser(ctx.sql);
    await repo.insertMany([]);
    expect(await repo.listByUser(u)).toEqual([]);
  });
});
```

**Step 2: 실패 확인**

Run: `bun run test src/modules/consents/consents.repo.test.ts`
Expected: FAIL (`consents.repo.ts` 없음 → import 에러).

**Step 3: repo 구현**

`src/modules/consents/consents.repo.ts`:
```ts
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { userConsents } from "../../db/schema/consents.ts";

export type ConsentType = "tos" | "privacy" | "llm_disclosure";
export type ConsentSource = "signup" | "invite_accept" | "usage_parse" | "settings";

export interface NewConsent {
  user_id: string;
  consent_type: ConsentType;
  document_version: string;
  source: ConsentSource;
  ip?: string;
}
export interface ConsentRecord {
  consent_type: ConsentType;
  document_version: string;
  accepted_at: Date;
}

export interface ConsentRepo {
  // (user_id, consent_type, document_version) 충돌 시 DO NOTHING(재수락 멱등 no-op).
  insertMany(rows: NewConsent[]): Promise<void>;
  listByUser(userId: string): Promise<ConsentRecord[]>;
}

export class DrizzleConsentRepo<T extends Record<string, unknown>> implements ConsentRepo {
  constructor(private readonly db: PostgresJsDatabase<T>) {}

  async insertMany(rows: NewConsent[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db
      .insert(userConsents)
      .values(
        rows.map((r) => ({
          user_id: r.user_id,
          consent_type: r.consent_type,
          document_version: r.document_version,
          source: r.source,
          ...(r.ip ? { ip: r.ip } : {}),
        })),
      )
      .onConflictDoNothing({
        target: [userConsents.user_id, userConsents.consent_type, userConsents.document_version],
      });
  }

  async listByUser(userId: string): Promise<ConsentRecord[]> {
    const rows = await this.db
      .select({
        consent_type: userConsents.consent_type,
        document_version: userConsents.document_version,
        accepted_at: userConsents.accepted_at,
      })
      .from(userConsents)
      .where(eq(userConsents.user_id, userId));
    return rows as ConsentRecord[];
  }
}
```

**Step 4: 통과 확인**

Run: `bun run test src/modules/consents/consents.repo.test.ts`
Expected: PASS (5 tests).

**Step 5: Commit**
```bash
git add src/modules/consents/consents.repo.ts src/modules/consents/consents.repo.test.ts
git commit -m "feat(consents): 멱등 동의 repo(DrizzleConsentRepo)"
```

---

## Task 5: service (버전검증·멱등·조회) — TDD(인메모리 fake)

**Files:**
- Create: `src/modules/consents/consents.service.ts`
- Test: `src/modules/consents/consents.service.test.ts`

**Step 1: 실패 테스트 작성**

`src/modules/consents/consents.service.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ConflictError } from "../../core/errors.ts";
import { CONSENT_VERSIONS } from "./consents.config.ts";
import type { ConsentRepo, NewConsent } from "./consents.repo.ts";
import { ConsentService } from "./consents.service.ts";

const FIXED = new Date("2026-07-07T00:00:00Z");
function memRepo(): ConsentRepo & { rows: (NewConsent & { accepted_at: Date })[] } {
  const rows: (NewConsent & { accepted_at: Date })[] = [];
  return {
    rows,
    async insertMany(rs) {
      for (const r of rs) {
        const dup = rows.some(
          (x) =>
            x.user_id === r.user_id &&
            x.consent_type === r.consent_type &&
            x.document_version === r.document_version,
        );
        if (!dup) rows.push({ ...r, accepted_at: FIXED });
      }
    },
    async listByUser(userId) {
      return rows
        .filter((r) => r.user_id === userId)
        .map((r) => ({
          consent_type: r.consent_type,
          document_version: r.document_version,
          accepted_at: r.accepted_at,
        }));
    },
  };
}
const V = CONSENT_VERSIONS;

describe("ConsentService.record", () => {
  it("current 버전 batch(tos+privacy) → 멱등 기록·기록분 반환", async () => {
    const repo = memRepo();
    const out = await new ConsentService(repo).record("u1", {
      consents: [
        { type: "tos", version: V.tos },
        { type: "privacy", version: V.privacy },
      ],
      source: "signup",
    });
    expect(out.map((r) => r.consent_type).sort()).toEqual(["privacy", "tos"]);
    expect(repo.rows).toHaveLength(2);
  });

  it("stale 버전 → ConflictError, insert 미도달", async () => {
    const repo = memRepo();
    await expect(
      new ConsentService(repo).record("u1", {
        consents: [{ type: "tos", version: "old" }],
        source: "signup",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(repo.rows).toHaveLength(0);
  });

  it("재수락 멱등 — 같은 버전 2회 → 1행", async () => {
    const repo = memRepo();
    const svc = new ConsentService(repo);
    const input = {
      consents: [{ type: "tos" as const, version: V.tos }],
      source: "settings" as const,
    };
    await svc.record("u1", input);
    await svc.record("u1", input);
    expect(repo.rows).toHaveLength(1);
  });
});

describe("ConsentService.recordDisclosure", () => {
  it("llm_disclosure(current·source=usage_parse) 멱등 기록", async () => {
    const repo = memRepo();
    const svc = new ConsentService(repo);
    await svc.recordDisclosure("u1", { ip: "9.9.9.9" });
    expect(repo.rows).toEqual([
      {
        user_id: "u1",
        consent_type: "llm_disclosure",
        document_version: V.llm_disclosure,
        source: "usage_parse",
        ip: "9.9.9.9",
        accepted_at: FIXED,
      },
    ]);
    await svc.recordDisclosure("u1");
    expect(repo.rows).toHaveLength(1);
  });
});

describe("ConsentService.list", () => {
  it("current + accepted 반환", async () => {
    const repo = memRepo();
    const svc = new ConsentService(repo);
    await svc.recordDisclosure("u1");
    const out = await svc.list("u1");
    expect(out.current).toEqual(CONSENT_VERSIONS);
    expect(out.accepted).toHaveLength(1);
    expect(out.accepted[0]!.consent_type).toBe("llm_disclosure");
  });
});
```

**Step 2: 실패 확인**

Run: `bun run test src/modules/consents/consents.service.test.ts` → FAIL (service 없음).

**Step 3: service 구현**

`src/modules/consents/consents.service.ts`:
```ts
import { ConflictError } from "../../core/errors.ts";
import { CONSENT_VERSIONS } from "./consents.config.ts";
import type { ConsentRecord, ConsentRepo, ConsentSource, ConsentType } from "./consents.repo.ts";

export interface RecordConsentsInput {
  consents: { type: ConsentType; version: string }[];
  source: Exclude<ConsentSource, "usage_parse">; // usage_parse는 recordDisclosure 전용
  ip?: string;
}

export class ConsentService {
  constructor(private readonly repo: ConsentRepo) {}

  /** tos·privacy 등 batch 수락. 각 버전이 서버 current와 다르면 409(stale). 멱등 기록 후 기록분 반환. */
  async record(userId: string, input: RecordConsentsInput): Promise<ConsentRecord[]> {
    for (const c of input.consents) {
      const expected = CONSENT_VERSIONS[c.type];
      if (c.version !== expected)
        throw new ConflictError("stale consent version", { type: c.type, expected });
    }
    await this.repo.insertMany(
      input.consents.map((c) => ({
        user_id: userId,
        consent_type: c.type,
        document_version: c.version,
        source: input.source,
        ...(input.ip ? { ip: input.ip } : {}),
      })),
    );
    const all = await this.repo.listByUser(userId);
    const wanted = new Set(input.consents.map((c) => `${c.type}:${c.version}`));
    return all.filter((r) => wanted.has(`${r.consent_type}:${r.document_version}`));
  }

  /** 외부 LLM 전송 고지 동의(일회성·버전별). parse가 전송 직전 호출 — 멱등 INSERT(fail-closed: throw 전파). */
  recordDisclosure(userId: string, opts?: { ip?: string }): Promise<void> {
    return this.repo.insertMany([
      {
        user_id: userId,
        consent_type: "llm_disclosure",
        document_version: CONSENT_VERSIONS.llm_disclosure,
        source: "usage_parse",
        ...(opts?.ip ? { ip: opts.ip } : {}),
      },
    ]);
  }

  async list(
    userId: string,
  ): Promise<{ current: typeof CONSENT_VERSIONS; accepted: ConsentRecord[] }> {
    const accepted = await this.repo.listByUser(userId);
    return { current: CONSENT_VERSIONS, accepted };
  }
}
```

**Step 4: 통과 확인**

Run: `bun run test src/modules/consents/consents.service.test.ts` → PASS.

**Step 5: Commit**
```bash
git add src/modules/consents/consents.service.ts src/modules/consents/consents.service.test.ts
git commit -m "feat(consents): ConsentService(버전검증·멱등·recordDisclosure)"
```

---

## Task 6: controller (POST/GET /consents) — TDD(app 하네스)

**Files:**
- Create: `src/modules/consents/consents.controller.ts`
- Test: `src/modules/consents/consents.controller.test.ts`

**Step 1: 실패 테스트 작성**

`src/modules/consents/consents.controller.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ConflictError, registerErrorFilter } from "../../core/errors.ts";
import type { SessionResolver } from "../../core/guards.ts";
import { createApp } from "../../core/openapi.ts";
import { CONSENT_VERSIONS } from "./consents.config.ts";
import { registerConsentRoutes } from "./consents.controller.ts";
import type { ConsentService } from "./consents.service.ts";

function appWith(service: Partial<ConsentService>, opts: { auth?: boolean } = {}) {
  const app = createApp();
  registerErrorFilter(app);
  const resolver: SessionResolver = async () =>
    opts.auth === false ? null : { user: { id: "u1" } };
  registerConsentRoutes(app, { service: service as ConsentService, resolver });
  return app;
}
const V = CONSENT_VERSIONS;
const AT = new Date("2026-07-07T00:00:00Z");

describe("consents 라우트", () => {
  it("POST — 200 {recorded}, service.record에 userId·consents·source 전달", async () => {
    let seen: unknown;
    const app = appWith({
      record: async (userId, input) => {
        seen = { userId, input };
        return [{ consent_type: "tos", document_version: V.tos, accepted_at: AT }];
      },
    });
    const res = await app.request("/consents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consents: [{ type: "tos", version: V.tos }], source: "signup" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      recorded: [{ type: "tos", version: V.tos, accepted_at: "2026-07-07T00:00:00.000Z" }],
    });
    expect(seen).toMatchObject({
      userId: "u1",
      input: { consents: [{ type: "tos", version: V.tos }], source: "signup" },
    });
  });

  it("POST — stale(service ConflictError) → 409 problem+json", async () => {
    const app = appWith({
      record: async () => {
        throw new ConflictError("stale consent version");
      },
    });
    const res = await app.request("/consents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consents: [{ type: "tos", version: "old" }], source: "signup" }),
    });
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });

  it("POST — 미인증 → 403", async () => {
    const app = appWith({ record: async () => [] }, { auth: false });
    const res = await app.request("/consents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consents: [{ type: "tos", version: V.tos }], source: "signup" }),
    });
    expect(res.status).toBe(403);
  });

  it("POST — source 누락 → 422", async () => {
    const app = appWith({ record: async () => [] });
    const res = await app.request("/consents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consents: [{ type: "tos", version: V.tos }] }),
    });
    expect(res.status).toBe(422);
  });

  it("GET — 200 {current, accepted}", async () => {
    const app = appWith({
      list: async () => ({
        current: CONSENT_VERSIONS,
        accepted: [
          { consent_type: "llm_disclosure", document_version: V.llm_disclosure, accepted_at: AT },
        ],
      }),
    });
    const res = await app.request("/consents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { current: unknown; accepted: unknown[] };
    expect(body.current).toEqual(CONSENT_VERSIONS);
    expect(body.accepted).toEqual([
      {
        type: "llm_disclosure",
        version: V.llm_disclosure,
        accepted_at: "2026-07-07T00:00:00.000Z",
      },
    ]);
  });

  it("GET — 미인증 → 403", async () => {
    const app = appWith(
      { list: async () => ({ current: CONSENT_VERSIONS, accepted: [] }) },
      { auth: false },
    );
    expect((await app.request("/consents")).status).toBe(403);
  });
});
```

**Step 2: 실패 확인**

Run: `bun run test src/modules/consents/consents.controller.test.ts` → FAIL (controller 없음).

**Step 3: controller 구현**

`src/modules/consents/consents.controller.ts`:
```ts
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { requireAuth } from "../../core/guards.ts";
import type { SessionResolver } from "../../core/guards.ts";
import { errorResponses } from "../../core/http.ts";
import { clientIp } from "../../core/rate-limit.ts";
import {
  getConsentsResponseSchema,
  postConsentsRequestSchema,
  postConsentsResponseSchema,
} from "./consents.schema.ts";
import type { ConsentRecord } from "./consents.repo.ts";
import type { ConsentService } from "./consents.service.ts";

interface Deps {
  service: ConsentService;
  resolver: SessionResolver;
}

const ok = <S extends z.ZodTypeAny>(schema: S) => ({
  200: { description: "ok", content: { "application/json": { schema } } },
});
const jsonBody = <S extends z.ZodTypeAny>(schema: S) => ({
  content: { "application/json": { schema } },
  required: true,
});

const toDto = (r: ConsentRecord) => ({
  type: r.consent_type,
  version: r.document_version,
  accepted_at: r.accepted_at.toISOString(),
});

export function registerConsentRoutes(app: OpenAPIHono, deps: Deps): void {
  const auth = requireAuth(deps.resolver);

  app.openapi(
    createRoute({
      method: "post",
      path: "/consents",
      security: [{ cookieAuth: [] }],
      middleware: [auth],
      request: { body: jsonBody(postConsentsRequestSchema) },
      responses: { ...ok(postConsentsResponseSchema), ...errorResponses(403, 409, 422) },
    }),
    async (c) => {
      const userId = c.get("user").id;
      const { consents, source } = c.req.valid("json");
      const ip = clientIp(c.req.raw.headers) || undefined;
      const recorded = await deps.service.record(userId, {
        consents,
        source,
        ...(ip ? { ip } : {}),
      });
      return c.json({ recorded: recorded.map(toDto) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/consents",
      security: [{ cookieAuth: [] }],
      middleware: [auth],
      responses: { ...ok(getConsentsResponseSchema), ...errorResponses(403) },
    }),
    async (c) => {
      const userId = c.get("user").id;
      const { current, accepted } = await deps.service.list(userId);
      return c.json({ current, accepted: accepted.map(toDto) }, 200);
    },
  );
}
```

**Step 4: 통과 확인**

Run: `bun run test src/modules/consents/consents.controller.test.ts` → PASS.

**Step 5: Commit**
```bash
git add src/modules/consents/consents.controller.ts src/modules/consents/consents.controller.test.ts
git commit -m "feat(consents): POST/GET /consents 라우트"
```

---

## Task 7: 모듈 배선(V1Deps·라우트 등록·컴포지션 루트·스텁 8곳)

`consentService`를 **필수** V1Deps로 추가 → `/v1/consents` 라이브 + usage-imports에 주입 준비. 필수 필드라 `buildV1App` 리터럴 **8곳 전부** 갱신 필요(누락 시 TS 컴파일 실패).

**Files:**
- Modify: `src/app.ts` (V1Deps + import + registerConsentRoutes)
- Modify: `src/main.ts` (ConsentService 생성·주입)
- Modify: `src/openapi-gen.ts` (스텁)
- Modify: `src/openapi-doc.test.ts` · `src/v1-security.test.ts` · `src/core/rate-limit.test.ts` · `src/expenses-doc.test.ts` · `src/app-error-mapping.test.ts` · `src/settlement-doc.test.ts` (스텁)

**Step 1: `src/app.ts` — import 추가**

상단 import 그룹에:
```ts
import { registerConsentRoutes } from "./modules/consents/consents.controller.ts";
import type { ConsentService } from "./modules/consents/consents.service.ts";
```

**Step 2: `src/app.ts` — V1Deps에 필드 추가**

`V1Deps` 인터페이스에(예: `expenseDrafts` 다음 줄):
```ts
  consentService: ConsentService; // 서버측 동의 기록(PB-1). 항상 배선 — parse recordDisclosure를 필수화(fail-closed).
```

**Step 3: `src/app.ts` — 라우트 등록**

`buildV1App` 안, `registerExpenseDraftRoutes(...)` 등록 블록 근처(사용내역 파싱 등록 앞)에 추가:
```ts
  registerConsentRoutes(v1, { service: deps.consentService, resolver: deps.resolver });
```

**Step 4: `bun run typecheck` → 8개 리터럴에서 `consentService` 누락 에러 확인**

에러 목록 = 갱신 대상. 아래에서 하나씩 채운다.

**Step 5: `src/main.ts` — ConsentService 생성**

import 추가:
```ts
import { DrizzleConsentRepo } from "./modules/consents/consents.repo.ts";
import { ConsentService } from "./modules/consents/consents.service.ts";
```
`expenseDrafts` 생성 라인 근처에:
```ts
const consentService = new ConsentService(new DrizzleConsentRepo(core.db));
```
`buildV1App({ ... })` 호출 객체에 `consentService,` 추가(예: `expenseDrafts,` 다음).

**Step 6: 스텁 7곳에 `consentService: {} as never,` 추가**

각 `buildV1App({ ... })` 리터럴에 (보통 `expenseDrafts: {} as never,` 옆) 추가:
- `src/openapi-gen.ts`
- `src/openapi-doc.test.ts`
- `src/v1-security.test.ts`
- `src/core/rate-limit.test.ts`
- `src/expenses-doc.test.ts`
- `src/app-error-mapping.test.ts`
- `src/settlement-doc.test.ts`

**Step 7: 컴파일 + 계약 테스트 확인**

Run: `bun run typecheck`
Expected: PASS.

Run: `bun run test src/openapi-doc.test.ts src/v1-security.test.ts`
Expected: PASS (경로 단언은 `.some(...)`이라 `/consents` 추가로 안 깨짐).

**Step 8: Commit**
```bash
git add src/app.ts src/main.ts src/openapi-gen.ts src/openapi-doc.test.ts src/v1-security.test.ts src/core/rate-limit.test.ts src/expenses-doc.test.ts src/app-error-mapping.test.ts src/settlement-doc.test.ts
git commit -m "feat(consents): /v1/consents 배선(V1Deps 필수 dep·라우트 등록)"
```

---

## Task 8: parse fail-closed 배선(recordDisclosure) — TDD

공용 `runParsePipeline`이 쿼터 통과 후·LLM 전송 전에 `recordDisclosure` 호출. throw 시 파싱 중단(fail-closed). `recordDisclosure`는 usage-imports의 **필수 dep** → app.ts가 `deps.consentService`에서 주입.

**Files:**
- Modify: `src/modules/usage-imports/usage-imports.controller.ts`
- Modify: `src/app.ts` (registerUsageImportRoutes에 recordDisclosure 주입)
- Modify: `src/modules/usage-imports/usage-imports.controller.test.ts` (하네스 + 신규 테스트)

**Step 1: controller에 dep·배관 추가(호출은 아직)**

`src/modules/usage-imports/usage-imports.controller.ts`:

(a) import 추가:
```ts
import { clientIp } from "../../core/rate-limit.ts";
```
(b) `Deps` 인터페이스에 **필수** 필드 추가:
```ts
  recordDisclosure: (userId: string, opts?: { ip?: string }) => Promise<void>; // PB-1: LLM 전송 전 llm_disclosure 기록(fail-closed)
```
(c) `runParsePipeline`의 `args` 타입에 `ip?: string;` 추가.
(d) 텍스트 라우트 핸들러 — `const userId = c.get("user").id;` 다음에:
```ts
      const ip = clientIp(c.req.raw.headers) || undefined;
```
그리고 `runParsePipeline(deps, { ... })` args에 `...(ip ? { ip } : {}),` 추가(`...(idemKey ? { importKey: idemKey } : {})` 옆).
(e) 이미지 라우트 핸들러 — `const userId = c.get("user").id;` 다음에 동일하게 `const ip = clientIp(...) || undefined;`, args에 `...(ip ? { ip } : {}),` 추가.

> 아직 `runParsePipeline` 내부에서 recordDisclosure를 **호출하지 않는다**(다음 RED 단계용).

**Step 2: `src/app.ts` — registerUsageImportRoutes에 recordDisclosure 주입**

`registerUsageImportRoutes(v1, { ... })` 객체에 추가:
```ts
    recordDisclosure: (userId, opts) => deps.consentService.recordDisclosure(userId, opts),
```

**Step 3: 테스트 하네스에 recordDisclosure 추가**

`src/modules/usage-imports/usage-imports.controller.test.ts`의 `appWith` opts 타입에:
```ts
    recordDisclosure?: (userId: string, opts?: { ip?: string }) => Promise<void>;
```
`registerUsageImportRoutes(app, { ... })` 객체에:
```ts
    recordDisclosure: opts.recordDisclosure ?? (async () => {}),
```

**Step 4: RED — PB-1 신규 테스트 작성**

`usage-imports.controller.test.ts` 텍스트 describe 안에 추가:
```ts
  it("PB-1 — 유효 parse는 LLM 전송 전 recordDisclosure(userId) 호출", async () => {
    const calls: string[] = [];
    let recordedBeforeParse = false;
    const app = appWith({
      parser: {
        parse: async () => {
          recordedBeforeParse = calls.length > 0;
          return [DRAFT];
        },
      },
      recordDisclosure: async (userId) => {
        calls.push(userId);
      },
    });
    const res = await post(app, { text: "x" });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["u1"]);
    expect(recordedBeforeParse).toBe(true); // 기록이 parse보다 먼저
  });

  it("PB-1 fail-closed — recordDisclosure 실패 시 파싱 중단, parser.parse 미호출", async () => {
    let parsed = 0;
    const app = appWith({
      parser: {
        parse: async () => {
          parsed++;
          return [DRAFT];
        },
      },
      recordDisclosure: async () => {
        throw new Error("db down");
      },
    });
    const res = await post(app, { text: "x" });
    expect(res.status).toBe(500); // 비-AppError → 500(전송 안 됨)
    expect(parsed).toBe(0);
  });

  it("PB-1 — cf-connecting-ip를 recordDisclosure ip로 전달", async () => {
    let seenIp: string | undefined;
    const app = appWith({
      parser: { parse: async () => [DRAFT] },
      recordDisclosure: async (_u, o) => {
        seenIp = o?.ip;
      },
    });
    const res = await app.request(`/trips/${TRIP_ID}/usage-imports/parse`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4" },
      body: JSON.stringify({ disclosure_accepted: true, text: "x" }),
    });
    expect(res.status).toBe(200);
    expect(seenIp).toBe("1.2.3.4");
  });

  it("PB-1 — 쿼터 초과 시 recordDisclosure 미호출(전송 없음)", async () => {
    let recorded = 0;
    const app = appWith({
      parser: { parse: async () => [DRAFT] },
      quotaCheck: async () => ({ ok: false, retryAfter: 5 }),
      recordDisclosure: async () => {
        recorded++;
      },
    });
    expect((await post(app, { text: "x" })).status).toBe(429);
    expect(recorded).toBe(0); // 쿼터 게이트가 앞
  });
```
이미지 describe 안에 추가:
```ts
  it("PB-1(image) — parse-image fail-closed(recordDisclosure throw → 파서 미도달)", async () => {
    let parsed = 0;
    const app = appWith({
      parser: imageParserWith(async () => {
        parsed++;
        return [DRAFT];
      }),
      recordDisclosure: async () => {
        throw new Error("db down");
      },
    });
    expect((await postImage(app)).status).toBe(500);
    expect(parsed).toBe(0);
  });
```

Run: `bun run test src/modules/usage-imports/usage-imports.controller.test.ts`
Expected: FAIL — "recordDisclosure 호출"·"쿼터 미호출" 테스트는 `calls`/`recorded` 불일치, fail-closed 테스트는 파싱이 성공(200)해 FAIL(아직 호출 안 하므로).

**Step 5: GREEN — 파이프라인에 호출 삽입**

`src/modules/usage-imports/usage-imports.controller.ts`의 `runParsePipeline`에서 **쿼터 블록(`if (deps.quotaCheck) { ... }`) 직후·`const startedAt = ...` 직전**에 삽입:
```ts
  // PB-1: 외부 LLM 전송 전 llm_disclosure 동의 기록 — fail-closed(기록 실패 시 throw 전파 → 전송 안 함).
  await deps.recordDisclosure(userId, args.ip !== undefined ? { ip: args.ip } : {});
```
(`userId`는 함수 상단에서 `const { userId, ... } = args;`로 이미 구조분해됨.)

Run: `bun run test src/modules/usage-imports/usage-imports.controller.test.ts`
Expected: PASS (기존 + 신규 5 테스트 전부).

**Step 6: Commit**
```bash
git add src/modules/usage-imports/usage-imports.controller.ts src/modules/usage-imports/usage-imports.controller.test.ts src/app.ts
git commit -m "feat(usage-imports): parse 전 llm_disclosure 동의 fail-closed 기록(PB-1)"
```

---

## Task 9: 전체 검증·OpenAPI 재생성·리뷰

**Step 1: 무회귀 전체 검증** (verification-before-completion)

Run: `bun run check`
Expected: PASS (oxlint + oxfmt --check + tsc). 포맷 실패 시 `bunx oxfmt` 후 재실행.

Run: `bun run test`
Expected: 전체 PASS(기존 548 + 신규 consents/parse 테스트). 실패 시 해당 파일만 재현·수정.

**Step 2: OpenAPI 스펙 재생성**

Run: `bun run gen:openapi`
Expected: `openapi.json`에 `/v1/consents`(GET·POST) 경로와 `PostConsentsRequest`/`ConsentRecord`/`GetConsentsResponse` 스키마 포함. `Object.keys(paths).length`가 이전보다 증가.

`openapi.json`이 git 추적 대상이면 커밋:
```bash
git add openapi.json && git status
```
`src/publish-openapi.test.ts`가 스펙 동기화를 강제하면(재생성 필요), 위 재생성으로 이미 최신.

**Step 3: 배선 스모크(선택, 권장)**

`src/main.ts` 부팅 경로는 실 DB/Redis가 필요하므로, 계약 수준 확인은 `bun run test src/openapi-doc.test.ts`로 충분(위 Task 7에서 통과). recordDisclosure fail-closed는 usage-imports 컨트롤러 테스트가 커버.

**Step 4: codex 적대적 리뷰**(codex-adversarial-review / 사전 PR 게이트)

Run: `node scripts/adversarial-review.mjs --kind code --scope working-tree`
발견은 **사람이 triage** 후 반영(자동 적용 금지). 특히 확인 포인트:
- fail-closed 배치가 쿼터 뒤·`run()` 앞이 맞는지(전송 전 기록 보장).
- `exactOptionalPropertyTypes`: `ip`/`opts` 조건부 스프레드 누락 없는지.
- `onConflictDoNothing` target이 `uq_user_consent`와 정확히 일치하는지.
- 스텁 8곳 누락 없이 컴파일되는지.

**Step 5: 최종 커밋(리뷰 반영분 있으면)**
```bash
git add -A && git commit -m "fix(consents): 적대적 리뷰 반영"   # 반영분 있을 때만
```

---

## 완료 기준 (Definition of Done)

- [ ] `user_consents` 테이블·마이그레이션 생성, `bun run db:generate` 산출물 커밋.
- [ ] `consents` 모듈(config·schema·repo·service·controller) + 각 테스트 GREEN.
- [ ] `/v1/consents` GET/POST 라이브(openapi.json 반영).
- [ ] parse text·image가 LLM 전송 전 `llm_disclosure`를 **fail-closed** 기록(쿼터 뒤·run 앞), 실패 시 전송 중단.
- [ ] `bun run check` + `bun run test` 전체 PASS(무회귀).
- [ ] codex 적대적 리뷰 triage 완료.

## 스코프 밖(이 계획 out)

- 실 약관/처리방침 문서 내용(owner) · 백엔드 403 게이트 · parse별 전송 activity 로그 · 파기/열람 경로(PRD §43, 별도 슬라이스). FE 고지 UI·codex 엔진 봉인·`replicas:1` 롤아웃은 활성화 게이트의 후속 단계(배포 작업).

## PR

전 태스크 GREEN 후 `feat/consent-capture` → PR(제목 예: `feat(consents): PB-1 서버측 동의 캡처`). squash 머지. AI 마커 금지(레포 규칙).
