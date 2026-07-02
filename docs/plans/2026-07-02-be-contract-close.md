# BE-contract-close 구현 계획

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 프론트 착수 전 백엔드 계약 표면 4가지(Idempotency-Key 계약 노출·DELETE /trips·초대 취소·어드민 양도)를 완결해 OpenAPI 계약을 안정화한다.

**Architecture:** 기존 계약우선 사슬(Zod → @hono/zod-openapi → openapi.json → FE Hey API)에 편입. 새 인프라·DB 마이그레이션 없이 trips/members/expenses/settlements 레퍼런스 패턴을 재사용한다. 동시성은 trip row `FOR UPDATE` + CAS WHERE(멤버십엔 version 없음), 에러는 AppError throw → problem+json.

**Tech Stack:** Bun · Hono + @hono/zod-openapi · Drizzle(postgres.js) · Zod v4 · vitest + testcontainers · oxlint/oxfmt.

설계 근거: `docs/plans/2026-07-02-be-contract-close-design.md`.

---

## 공통 규약 (모든 Task 준수)

- 배선은 `src/app.ts`의 `buildV1App(deps)` 안에서만. 새 `OpenAPIHono` 인스턴스 생성 금지.
- 라우트는 `app.openapi(createRoute({...}), handler)`. 모든 요청/응답 DTO는 `.openapi("Name")` 컴포넌트 등록.
- 에러는 `core/errors.ts`의 AppError 서브클래스 throw(`ForbiddenError`403·`NotFoundError`404·`ConflictError`409·`ValidationError`422). `c.json` 수동 에러 조립 금지. SQLSTATE(23505/23503/23514)는 서비스에서 도메인 에러로 변환.
- 권한: DELETE·양도·취소는 `middleware:[auth, requireTripMember(memberLookup,'admin')]` + `security:[{cookieAuth:[]}]`.
- 동시성: `trip_members`에 version 없음 → trip row `FOR UPDATE` + CAS WHERE(전이조건 전부 WHERE에 포함, read-then-write 금지).
- 라우트/DTO 변경 후 반드시 `bun run gen:openapi`로 `openapi.json` 재생성·커밋(CI `openapi-drift`가 `git diff --exit-code`로 강제).
- 각 커밋 전 `bun run check`(oxlint+oxfmt+tsc) 통과. 실패 시 `bun run fmt` 후 재실행.
- 커밋: 한국어 `type(scope): 설명`(type ∈ feat/fix/refactor/docs/style/test/chore), AI 마커 금지.
- 실행 위치: 워크트리 `.worktrees/be-contract-close`(브랜치 `feat/be-contract-close`). 모든 경로는 워크트리 루트 기준 상대경로.

---

## 구현 순서 (총 20 Task)

1. **① Idempotency-Key 계약 노출** (Task 1–4) — 순수 계약 변경, 최저위험 워밍업
2. **② DELETE /trips/{tripId}** (Task 5–9) — 자기완결, cascade 다이아몬드 통합테스트가 핵심
3. **③ 초대 취소 + 재초대 revive-upsert** (Task 10–14) — `invite_expired` 최초 writer, 회귀 스윕 동반
4. **④ 어드민 양도** (Task 15–18) — 최고 복잡도, 강등선행 원자 swap
5. **⑤ 문서 갱신 · 최종 검증** (Task 19–20)

---

## ① Idempotency-Key 계약 노출 (Task 1–4)

### Task 1: `idempotencyKeyHeader` 공용 헤더 헬퍼 추가 (http.ts)

**Files:**
- Modify: `src/core/http.ts:1-1` (import 확인) 및 파일 말미에 export 추가
- Test: `src/core/http.test.ts:1-3` (import 확장), 새 `describe` 블록 추가

멱등 미들웨어가 배선된 5개 라우트에만 노출할 헤더 파라미터 스키마를 공용 헬퍼로 정의한다. `required`/`.min(1)`/배열형 금지 — required면 헤더 없는 요청이 422로 떨어져 기존 no-op을 파괴하고, 배열형은 zValidator에 `safeParseAsync`가 없어 런타임 크래시가 난다.

**Step 1: 실패하는 단위 테스트 작성**
`src/core/http.test.ts`의 최상단 import를 확장하고 파일 끝에 새 describe를 추가한다.

import 라인 교체:
```ts
import { problemSchema, errorResponses, idempotencyKeyHeader } from "./http.ts";
```

파일 끝(마지막 `});` 뒤)에 추가:
```ts
describe("idempotencyKeyHeader 헤더 파라미터", () => {
  it("헤더 없음(no-op 보존)·정상 키·경계값 통과, 200자 초과 거부", () => {
    // required 아님 → 헤더 미제공 요청도 유효(기존 no-op 보존)
    expect(idempotencyKeyHeader.safeParse({}).success).toBe(true);
    expect(idempotencyKeyHeader.safeParse({ "Idempotency-Key": "k-1" }).success).toBe(true);
    expect(idempotencyKeyHeader.safeParse({ "Idempotency-Key": "a".repeat(200) }).success).toBe(
      true,
    );
    expect(idempotencyKeyHeader.safeParse({ "Idempotency-Key": "a".repeat(201) }).success).toBe(
      false,
    );
  });
});
```

**Step 2: 실패 확인**
```bash
bun run test src/core/http.test.ts
```
Expected: FAIL — `idempotencyKeyHeader`가 `./http.ts`에서 export되지 않아 import가 `undefined`가 되고, `.safeParse` 호출에서 `TypeError: Cannot read properties of undefined (reading 'safeParse')`로 새 테스트가 실패한다.

**Step 3: 최소 구현**
`src/core/http.ts` 파일 끝(마지막 `problemFromZod` 함수 뒤)에 헬퍼를 추가한다. `z`는 이미 파일 1번 줄에서 import되어 있다.
```ts
/** 멱등 미들웨어 배선 라우트에만 노출하는 Idempotency-Key 헤더 파라미터(api-contract §4).
 *  .optional()+.max(200)만 사용 — required면 헤더 없는 요청이 422로 기존 no-op을 파괴하고,
 *  배열형은 zValidator에 safeParseAsync 부재로 런타임 크래시가 난다. */
export const idempotencyKeyHeader = z.object({
  "Idempotency-Key": z
    .string()
    .max(200)
    .optional()
    .openapi({
      param: { name: "Idempotency-Key", in: "header" },
      description: "재시도 안전 멱등 키(≤200자). 동일 키 재요청은 저장된 응답을 replay한다.",
      example: "3f1c8b2e-9a44-4c1e-8b0e-2d5f7c6a1b90",
    }),
});
```

**Step 4: 통과 확인**
```bash
bun run test src/core/http.test.ts
```
Expected: PASS — 4개 단언 모두 통과(기존 problem+json 테스트 3건도 그대로 PASS).

**Step 5: 커밋**
```bash
bun run fmt && bun run check
git add src/core/http.ts src/core/http.test.ts
git commit -m "feat(http): Idempotency-Key 헤더 OpenAPI 파라미터 공용 헬퍼 추가"
```

### Task 2: 지출 생성 라우트에 헤더 파라미터 배선 + doc 단언 (expenses)

**Files:**
- Modify: `src/modules/expenses/expenses.controller.ts:8` (import), `:75-78` (POST 생성 라우트 `request`)
- Test: `src/expenses-doc.test.ts:21-59` (`describe` 내 `it` 추가)

**Step 1: 실패하는 doc 단언 추가**
`src/expenses-doc.test.ts`의 `describe("expenses OpenAPI 계약", ...)` 블록 안(마지막 `it` 뒤, 닫는 `});` 앞)에 추가한다.
```ts
  it("생성 라우트에 Idempotency-Key 헤더 파라미터(optional·maxLength 200)", () => {
    type Param = { name: string; in: string; required?: boolean; schema?: { maxLength?: number } };
    const post = (doc().paths as Record<string, { post?: { parameters?: Param[] } }>)[
      "/v1/trips/{tripId}/expenses"
    ]?.post;
    const p = (post?.parameters ?? []).find(
      (x) => x.name === "Idempotency-Key" && x.in === "header",
    );
    expect(p).toBeDefined();
    expect(p!.required).toBe(false);
    expect(p!.schema?.maxLength).toBe(200);
  });
```

**Step 2: 실패 확인**
```bash
bun run test src/expenses-doc.test.ts
```
Expected: FAIL — POST `/trips/{tripId}/expenses` createRoute의 `request`에 `headers`가 없어 `Idempotency-Key` 파라미터가 스펙에 없으므로 `p`가 `undefined` → `expect(p).toBeDefined()`에서 실패.

**Step 3: 최소 구현**
import 라인 교체 (`src/modules/expenses/expenses.controller.ts:8`):
```ts
import { errorResponses, idempotencyKeyHeader } from "../../core/http.ts";
```
POST 생성 라우트의 `request` 블록(`:75-78`)에 `headers`를 추가:
```ts
      request: {
        params: z.object({ tripId: z.string().uuid() }),
        headers: idempotencyKeyHeader,
        body: jsonBody(createExpenseSchema),
      },
```

**Step 4: 통과 확인**
```bash
bun run test src/expenses-doc.test.ts
```
Expected: PASS — 신규 단언 통과(기존 경로·스키마 단언 4건도 PASS).

**Step 5: 커밋**
openapi.json 재생성은 Task 4에서 일괄 처리한다(doc 테스트는 `getOpenAPI31Document`가 생성한 인메모리 스펙을 검증하므로 파일 없이 통과).
```bash
bun run fmt && bun run check
git add src/modules/expenses/expenses.controller.ts src/expenses-doc.test.ts
git commit -m "feat(expenses): 지출 생성 라우트에 Idempotency-Key 헤더 파라미터 노출"
```

### Task 3: 정산 멱등 4개 라우트에 헤더 파라미터 배선 + doc 단언 (settlements)

**Files:**
- Modify: `src/modules/settlements/settlements.controller.ts:9` (import), `:81-84`(finalize), `:103`(unlock), `:119`(mark-paid), `:134`(mark-unpaid) 각 `request`
- Test: `src/settlement-doc.test.ts:21-46` (`describe` 내 `it` 추가)

**Step 1: 실패하는 doc 단언 추가**
`src/settlement-doc.test.ts`의 `describe("settlement OpenAPI 계약", ...)` 블록 안(마지막 `it` 뒤, 닫는 `});` 앞)에 추가한다.
```ts
  it("멱등 4개 라우트에 Idempotency-Key 헤더 파라미터(optional·maxLength 200)", () => {
    type Param = { name: string; in: string; required?: boolean; schema?: { maxLength?: number } };
    const d = doc();
    const targets = [
      "/v1/trips/{tripId}/settlement/finalize",
      "/v1/trips/{tripId}/settlement/unlock",
      "/v1/trips/{tripId}/settlement/transfers/{transferId}/mark-paid",
      "/v1/trips/{tripId}/settlement/transfers/{transferId}/mark-unpaid",
    ];
    for (const path of targets) {
      const post = (d.paths as Record<string, { post?: { parameters?: Param[] } }>)[path]?.post;
      const p = (post?.parameters ?? []).find(
        (x) => x.name === "Idempotency-Key" && x.in === "header",
      );
      expect(p, path).toBeDefined();
      expect(p!.required, path).toBe(false);
      expect(p!.schema?.maxLength, path).toBe(200);
    }
  });
```

**Step 2: 실패 확인**
```bash
bun run test src/settlement-doc.test.ts
```
Expected: FAIL — finalize/unlock/mark-paid/mark-unpaid 4개 createRoute의 `request`에 `headers`가 없어 `Idempotency-Key` 파라미터가 스펙에 없으므로 첫 경로(finalize)에서 `expect(p, path).toBeDefined()` 실패.

**Step 3: 최소 구현**
import 라인 교체 (`src/modules/settlements/settlements.controller.ts:9`):
```ts
import { errorResponses, idempotencyKeyHeader } from "../../core/http.ts";
```
finalize `request`(`:81-84`):
```ts
      request: {
        params: z.object({ tripId: z.string().uuid() }),
        headers: idempotencyKeyHeader,
        body: jsonBody(finalizeRequestSchema),
      },
```
unlock `request`(`:103`):
```ts
      request: {
        params: z.object({ tripId: z.string().uuid() }),
        headers: idempotencyKeyHeader,
      },
```
mark-paid `request`(`:119`):
```ts
      request: {
        params: z.object({ tripId: z.string().uuid(), transferId: z.string().uuid() }),
        headers: idempotencyKeyHeader,
      },
```
mark-unpaid `request`(`:134`):
```ts
      request: {
        params: z.object({ tripId: z.string().uuid(), transferId: z.string().uuid() }),
        headers: idempotencyKeyHeader,
      },
```

**Step 4: 통과 확인**
```bash
bun run test src/settlement-doc.test.ts
```
Expected: PASS — 4개 경로 루프 단언 통과(기존 경로·스키마 단언 3건도 PASS).

**Step 5: 커밋**
```bash
bun run fmt && bun run check
git add src/modules/settlements/settlements.controller.ts src/settlement-doc.test.ts
git commit -m "feat(settlements): 정산 멱등 4개 라우트에 Idempotency-Key 헤더 파라미터 노출"
```

### Task 4: openapi.json 재생성 및 계약 커밋

**Files:**
- Modify: `openapi.json` (생성 산출물, `bun run gen:openapi`로 재생성)

앞의 3개 Task는 라우트 config를 변경했으므로 커밋된 `openapi.json`이 코드와 drift 상태다. CI `openapi-drift` 잡이 `git diff --exit-code openapi.json`으로 강제하므로 여기서 스펙을 재생성해 일치시킨다.

**Step 1: 드리프트(실패) 확인**
```bash
bun run gen:openapi
git diff --exit-code openapi.json
```
Expected: FAIL(비영) — 5개 라우트에 `Idempotency-Key` 헤더 파라미터가 추가되어 `git diff --exit-code`가 exit code 1로 종료(스펙과 코드 불일치를 재현).

**Step 2: 재생성된 스펙 내용 검증**
```bash
node -e "const d=require('./openapi.json'); const t=['/v1/trips/{tripId}/expenses','/v1/trips/{tripId}/settlement/finalize','/v1/trips/{tripId}/settlement/unlock','/v1/trips/{tripId}/settlement/transfers/{transferId}/mark-paid','/v1/trips/{tripId}/settlement/transfers/{transferId}/mark-unpaid']; const bad=t.filter(p=>!(d.paths[p].post.parameters||[]).some(x=>x.name==='Idempotency-Key'&&x.in==='header'&&x.required===false&&x.schema.maxLength===200)); if(bad.length){console.error('MISSING',bad);process.exit(1)} console.log('OK 5/5')"
```
Expected: PASS — `OK 5/5` 출력(5개 라우트 모두 `name==='Idempotency-Key' && in==='header' && required===false && schema.maxLength===200` 만족).

**Step 3: 전체 doc 테스트 통과 확인**
```bash
bun run test src/expenses-doc.test.ts src/settlement-doc.test.ts src/openapi-doc.test.ts
```
Expected: PASS — 헤더 파라미터 추가로 기존 경로/스키마 스냅 단언이 깨지지 않음.

**Step 4: 커밋(드리프트 해소)**
```bash
bun run check
git add openapi.json
git commit -m "chore(openapi): Idempotency-Key 헤더 반영 openapi.json 재생성"
git diff --exit-code openapi.json
```
Expected: 마지막 `git diff --exit-code`가 exit 0 — 커밋 후 코드와 `openapi.json`이 일치해 CI `openapi-drift` 통과 상태.

## ② DELETE /trips/{tripId} — 어드민 방 전체 삭제 (Task 5–9)

### Task 5: TripRepo.delete — trip row FOR UPDATE 후 hard-delete (repo 통합테스트)

**Files:**
- Modify: `src/modules/trips/trips.repo.ts:19-24` (TripRepo 인터페이스), `src/modules/trips/trips.repo.ts:26-55` (DrizzleTripRepo 구현)
- Test: `src/modules/trips/trips.repo.test.ts:25-40` (describe 블록에 it 추가)

repo가 자식 cascade를 유발하는 단일 `DELETE FROM trips`를 수행하되, 삭제 전 `SELECT ... FOR UPDATE`로 trip row를 잠가 finalize/expense-create·동시 양도 경로와 직렬화한다. **(F5) 잠금 하에서 호출자(`callerMembershipId`)가 여전히 활성 admin(`role='admin' AND status='joined'`)인지 in-tx 재검증**한다 — 미들웨어 통과 후 동시 양도로 강등됐을 수 있어 TOCTOU를 차단해야 하기 때문. **(F7) tx는 안전 불변식** — `repo.delete`는 tx 미제공 시 **내부에서 트랜잭션을 열어** FOR UPDATE→재검증→DELETE의 원자성을 강제한다(옵션 `this.db` fallback로 락이 statement 종료 시 조기 해제되지 않도록). 반환은 `"deleted" | "not_found" | "forbidden"`. trips에는 version/deleted_at이 없으므로 CAS 없이 잠금·재검증 결과로 판정한다.

**Step 1: 실패하는 테스트 작성**

`src/modules/trips/trips.repo.test.ts` 상단 import에 `mkMember`(helpers)와 `randomUUID`(`node:crypto`)를 추가하고, `describe("DrizzleTripRepo", …)` 블록 안, 기존 `it("update title", …)` 뒤에 추가(F7: repo가 내부 tx를 열므로 호출부에서 outer tx 불필요):

```ts
  it("delete → 'deleted'(admin 재검증 통과·내부 tx FOR UPDATE), findById null", async () => {
    const u = await mkUser(ctx.sql);
    const repo = new DrizzleTripRepo(ctx.db);
    const trip = await repo.create(input(), u);
    const adminMid = await mkMember(ctx.sql, trip.id, { userId: u, role: "admin", status: "joined" });
    expect(await repo.delete(trip.id, adminMid)).toBe("deleted");
    expect(await repo.findById(trip.id)).toBeNull();
  });
  it("delete: 없는 tripId → 'not_found'", async () => {
    const repo = new DrizzleTripRepo(ctx.db);
    expect(await repo.delete("00000000-0000-0000-0000-000000000000", randomUUID())).toBe("not_found");
  });
  it("delete: 호출자가 admin 아님(강등/비활성) → 'forbidden'(삭제 안 됨) [F5]", async () => {
    const u = await mkUser(ctx.sql);
    const repo = new DrizzleTripRepo(ctx.db);
    const trip = await repo.create(input(), u);
    const memberMid = await mkMember(ctx.sql, trip.id, { userId: u, role: "member", status: "joined" });
    expect(await repo.delete(trip.id, memberMid)).toBe("forbidden");
    expect(await repo.findById(trip.id)).not.toBeNull(); // 삭제되지 않음
  });
```

**Step 2: 실패 확인**

```bash
bun run test src/modules/trips/trips.repo.test.ts
```

Expected: FAIL — `repo.delete is not a function` (인터페이스/구현에 `delete` 미존재).

**Step 3: 최소 구현**

`src/modules/trips/trips.repo.ts`의 `TripRepo` 인터페이스에 시그니처 추가(line 23 `update(...)` 뒤). (`trips`·`tripMembers`·`and`·`eq`는 이 파일에 이미 import되어 있음):

```ts
  update(id: string, patch: UpdateTrip): Promise<TripResponse | null>;
  // (F5) 삭제는 호출자 admin 재검증까지 원자로 — 반환: "deleted" | "not_found" | "forbidden".
  delete(
    tripId: string,
    callerMembershipId: string,
    tx?: unknown,
  ): Promise<"deleted" | "not_found" | "forbidden">;
```

`DrizzleTripRepo`의 `update` 메서드(line 54) 뒤, 클래스 닫는 `}` 앞에 추가:

```ts
  // 어드민 방 전체 삭제(무가드): trip row FOR UPDATE로 finalize/expense-create·동시 양도와 직렬화.
  // (F5) 미들웨어 통과 후 강등/비활성됐을 수 있으므로 잠금 하에서 호출자 admin 여부를 재검증(TOCTOU 차단).
  // (F7) tx 미제공 시 내부에서 트랜잭션을 열어 FOR UPDATE→DELETE 원자성 강제(락 조기 해제 방지).
  // 자식(members/expenses/…)은 FK onDelete cascade로 자동 정리. trips에 version/deleted_at 없음.
  async delete(
    tripId: string,
    callerMembershipId: string,
    tx?: unknown,
  ): Promise<"deleted" | "not_found" | "forbidden"> {
    const run = async (
      exec: PostgresJsDatabase<T>,
    ): Promise<"deleted" | "not_found" | "forbidden"> => {
      const locked = await exec
        .select({ id: trips.id })
        .from(trips)
        .where(eq(trips.id, tripId))
        .for("update");
      if (locked.length === 0) return "not_found";
      const admin = await exec
        .select({ id: tripMembers.id })
        .from(tripMembers)
        .where(
          and(
            eq(tripMembers.trip_id, tripId),
            eq(tripMembers.id, callerMembershipId),
            eq(tripMembers.role, "admin"),
            eq(tripMembers.status, "joined"),
          ),
        );
      if (admin.length === 0) return "forbidden";
      await exec.delete(trips).where(eq(trips.id, tripId));
      return "deleted";
    };
    // tx 있으면 그 위에서, 없으면 내부 tx로(F7: 항상 원자 — 옵션 fallback로 락이 조기 해제되지 않게).
    return tx ? run(tx as PostgresJsDatabase<T>) : this.db.transaction(run);
  }
```

**Step 4: 통과 확인**

```bash
bun run test src/modules/trips/trips.repo.test.ts
bun run check
```

Expected: PASS — 세 it 모두 통과(deleted·not_found·forbidden), oxlint/oxfmt/tsc 통과.

**Step 5: 커밋**

```bash
git add src/modules/trips/trips.repo.ts src/modules/trips/trips.repo.test.ts
git commit -m "feat(trips): TripRepo.delete 추가 — trip row FOR UPDATE 후 hard-delete(cascade)"
```

---

### Task 6: TripsService.deleteTrip — db.transaction 원자 삭제 + 404

**Files:**
- Modify: `src/modules/trips/trips.service.ts:5` (import), `src/modules/trips/trips.service.ts:44-60` (메서드 추가)
- Test: `src/modules/trips/trips.service.test.ts:32-62` (describe 블록에 it 추가)

서비스가 `db.transaction`으로 tx를 열고 `repo.delete(id, tx)` 호출 → FOR UPDATE+DELETE가 단일 tx에서 원자 수행. 잠금 결과 false면 `NotFoundError(404)`. 응답은 `{ id, deleted: true }`.

**Step 1: 실패하는 테스트 작성**

`src/modules/trips/trips.service.test.ts`의 `describe("TripsService", …)` 블록 마지막 it 뒤에 추가(상단 import에 `{ ForbiddenError, NotFoundError }`(errors)·`mkMember`(helpers)·`randomUUID`(`node:crypto`) 추가):

```ts
  it("deleteTrip → {id, deleted:true}, 이후 listTrips 비어있음", async () => {
    const u = await mkUser(ctx.sql);
    const s = svc();
    const trip = await s.createTrip(input(), actor(u));
    const [{ id: mid }] = await ctx.sql<
      { id: string }[]
    >`select id from trip_members where trip_id=${trip.id} and user_id=${u}`;
    const res = await s.deleteTrip(trip.id, mid);
    expect(res).toEqual({ id: trip.id, deleted: true });
    expect(await s.listTrips(u)).toHaveLength(0); // 멤버십도 cascade 제거
  });
  it("deleteTrip: 없는 tripId → NotFoundError(404)", async () => {
    const s = svc();
    await expect(
      s.deleteTrip("00000000-0000-0000-0000-000000000000", randomUUID()),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
  it("deleteTrip: 호출자가 admin 아님 → ForbiddenError(403)·삭제 안 됨 [F5]", async () => {
    const u = await mkUser(ctx.sql);
    const s = svc();
    const trip = await s.createTrip(input(), actor(u));
    const otherMid = await mkMember(ctx.sql, trip.id, {
      userId: await mkUser(ctx.sql),
      role: "member",
      status: "joined",
    });
    await expect(s.deleteTrip(trip.id, otherMid)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await s.getTrip(trip.id)).toBeTruthy(); // 존재 유지
  });
```

**Step 2: 실패 확인**

```bash
bun run test src/modules/trips/trips.service.test.ts
```

Expected: FAIL — `s.deleteTrip is not a function`.

**Step 3: 최소 구현**

`src/modules/trips/trips.service.ts` line 2 errors import에 `ForbiddenError` 추가, line 5 schema import에 `DeleteTripResult` 추가:

```ts
import { ForbiddenError, NotFoundError, ValidationError } from "../../core/errors.ts";
import type { CreateTrip, DeleteTripResult, TripResponse, UpdateTrip } from "./trips.schema.ts";
```

`updateTrip` 메서드(line 60 닫는 `}`) 뒤, 클래스 닫는 `}` 앞에 추가:

```ts
  /** 어드민 방 전체 삭제(무가드): 미들웨어 requireTripMember('admin')가 1차 게이팅, repo가 (내부 tx) trip 락 하 admin 재검증(F5·F7, TOCTOU 차단).
   *  finalized/paid여도 즉시 삭제, 자식은 FK cascade. repo.delete가 자체 tx를 열므로 서비스는 tx 관리 불필요. */
  async deleteTrip(tripId: string, callerMembershipId: string): Promise<DeleteTripResult> {
    const outcome = await this.repo.delete(tripId, callerMembershipId);
    if (outcome === "not_found") throw new NotFoundError("trip not found");
    if (outcome === "forbidden")
      throw new ForbiddenError("no longer an active admin of this trip", { tripId });
    return { id: tripId, deleted: true };
  }
```

**Step 4: 통과 확인**

```bash
bun run test src/modules/trips/trips.service.test.ts
bun run check
```

Expected: PASS — 세 it 통과(성공·404·403[F5]). (`DeleteTripResult`는 Task 7에서 정의되기 전이면 tsc 실패 → Task 7와 함께 도입되므로, 본 태스크는 Task 7의 스키마 추가를 선행 병합하거나 동일 브랜치에서 이어 진행한다. 순서상 Step 3에서 `trips.schema.ts`에 `DeleteTripResult`를 먼저 추가할 것.)

> 주의: `DeleteTripResult` 타입은 `trips.schema.ts`에 존재해야 tsc 통과한다. 아래 스니펫을 본 태스크 Step 3 시작 시 함께 추가한다(라우트/DTO 확정은 Task 7):
>
> `src/modules/trips/trips.schema.ts` line 60(`updateTripSchema` `.openapi(...)`) 뒤, type export(line 61) 앞에 추가:
> ```ts
> // 삭제 결과 DTO — {id, deleted:true}. FE codegen SSOT(openapi.json).
> export const deleteTripResponseSchema = z
>   .object({ id: z.string().uuid(), deleted: z.literal(true) })
>   .openapi("DeleteTripResult");
> ```
> 그리고 type export 블록(line 61-63)에 추가:
> ```ts
> export type DeleteTripResult = z.infer<typeof deleteTripResponseSchema>;
> ```

**Step 5: 커밋**

```bash
git add src/modules/trips/trips.service.ts src/modules/trips/trips.service.test.ts src/modules/trips/trips.schema.ts
git commit -m "feat(trips): TripsService.deleteTrip 추가 — tx 원자 삭제·미존재 404"
```

---

### Task 7: DELETE /trips/{tripId} 라우트(admin 가드) + openapi-doc 단언 + CORS 확인

**Files:**
- Modify: `src/modules/trips/trips.controller.ts:9` (import), `src/modules/trips/trips.controller.ts:74-92` (DELETE 라우트 추가)
- Modify(확인만): `src/app.ts:42` (CORS allowMethods — DELETE 이미 존재)
- Test: `src/modules/trips/trips.controller.test.ts:51-102` (it 추가), `src/openapi-doc.test.ts:25-49` (it 추가)

라우트는 `app.openapi(createRoute({...}), handler)`, 미들웨어 `[auth, requireTripMember(deps.memberLookup, "admin")]`, 응답 `...ok(deleteTripResponseSchema)`, `...errorResponses(403, 404)`. `Task 6 Step 3`에서 `deleteTripResponseSchema`/`DeleteTripResult`는 이미 `trips.schema.ts`에 존재.

**재시도 계약(F1 반영):** DELETE는 무가드·멱등 미적용이다. 삭제 성공 후 admin 멤버십이 cascade 제거되므로 같은 admin의 lost-response 재시도는 `requireTripMember(admin)`에서 **403**으로 떨어진다(서비스의 404에 도달하지 못함). 이는 불가역 삭제의 **수용된 재시도 계약**이며 Step 1에서 테스트로 고정한다. (Idempotency-Key는 사용자 결정에 따라 추가하지 않음.)

**In-tx authz 재검증(F5 반영):** 핸들러는 `c.get("membership").id`를 `deleteTrip(tripId, callerMembershipId)`에 넘기고, service→repo가 trip 락 하에서 호출자 admin 여부를 재검증한다. 미들웨어 통과 후 동시 양도로 강등된 호출자는 **403(ForbiddenError)**으로 삭제가 차단된다(TOCTOU 차단; repo/service 레벨 검증은 Task 5·6의 forbidden 케이스).

**Step 1: 실패하는 테스트 작성**

(a) `src/modules/trips/trips.controller.test.ts` — 상단 import에 `mkMember` 추가(`import { startDb, mkUser, mkMember, type Ctx } from "../../../tests/db/helpers.ts";`), `describe("trips 라우트", …)` 마지막 it 뒤에 추가:

```ts
  const del = (app: ReturnType<typeof appFor>, id: string) =>
    app.request(`/trips/${id}`, { method: "DELETE" });

  it("어드민 DELETE → 200 {id, deleted:true}, 이후 목록 비어있음", async () => {
    const u = await mkUser(ctx.sql);
    const app = appFor(u);
    const id = ((await (await post(app, body())).json()) as { id: string }).id;
    const res = await del(app, id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, deleted: true });
    expect(((await (await app.request("/trips")).json()) as unknown[]).length).toBe(0);
  });
  it("비멤버 DELETE → 403", async () => {
    const u1 = await mkUser(ctx.sql);
    const u2 = await mkUser(ctx.sql);
    const id = ((await (await post(appFor(u1), body())).json()) as { id: string }).id;
    expect((await del(appFor(u2), id)).status).toBe(403);
  });
  it("일반 멤버 DELETE → 403 (admin 가드)", async () => {
    const u1 = await mkUser(ctx.sql);
    const u2 = await mkUser(ctx.sql);
    const id = ((await (await post(appFor(u1), body())).json()) as { id: string }).id;
    await mkMember(ctx.sql, id, { userId: u2, role: "member", status: "joined" });
    expect((await del(appFor(u2), id)).status).toBe(403);
  });
  it("삭제 성공 후 같은 admin 재시도 → 403 (멤버십 cascade 제거로 admin 가드 우선, 404 아님)", async () => {
    const u = await mkUser(ctx.sql);
    const app = appFor(u);
    const id = ((await (await post(app, body())).json()) as { id: string }).id;
    expect((await del(app, id)).status).toBe(200);
    // 재시도: 삭제로 admin 멤버십이 cascade 제거됨 → requireTripMember(admin)가 먼저 403(deleteTrip이 404 낼 기회 없음).
    // 무가드·멱등 미적용 결정 하에서 이 403이 불가역 삭제의 수용된 재시도 계약이다(F1 반영).
    expect((await del(app, id)).status).toBe(403);
  });
```

(b) `src/openapi-doc.test.ts` — `describe("OpenAPI 스펙 계약", …)` 마지막 it 뒤에 추가:

```ts
  it("DELETE /v1/trips/{tripId} 등록 + DeleteTripResult 스키마(방 삭제 계약)", () => {
    const d = doc();
    const p = (d.paths ?? {})["/v1/trips/{tripId}"] as Record<string, unknown> | undefined;
    expect(p?.delete).toBeDefined();
    expect(d.components?.schemas?.DeleteTripResult).toBeDefined();
  });
```

**Step 2: 실패 확인**

```bash
bun run test src/modules/trips/trips.controller.test.ts src/openapi-doc.test.ts
```

Expected: FAIL — controller 테스트: DELETE 라우트 미등록 → Hono no-match 404(≠200/403); openapi-doc: `p?.delete` undefined.

**Step 3: 최소 구현**

`src/modules/trips/trips.controller.ts` line 9 import에 `deleteTripResponseSchema` 추가:

```ts
import {
  tripResponseSchema,
  createTripSchema,
  updateTripSchema,
  deleteTripResponseSchema,
} from "./trips.schema.ts";
```

`registerTripRoutes`의 PATCH 라우트(line 91 닫는 `);`) 뒤, 함수 닫는 `}`(line 92) 앞에 추가:

```ts
  app.openapi(
    createRoute({
      method: "delete",
      path: "/trips/{tripId}",
      security: [{ cookieAuth: [] }],
      middleware: [auth, requireTripMember(deps.memberLookup, "admin")],
      request: { params: z.object({ tripId: z.string().uuid() }) },
      responses: { ...ok(deleteTripResponseSchema), ...errorResponses(403, 404) },
    }),
    async (c) =>
      c.json(
        await deps.tripsService.deleteTrip(c.req.valid("param").tripId, c.get("membership").id),
        200,
      ),
  );
```

CORS 확인: `src/app.ts:42` `allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]` — `DELETE` 이미 포함되어 preflight 허용됨. **수정 불요.** (없었다면 이 배열에 `"DELETE"`를 추가하는 것이 스텝이었음.) 확인:

```bash
grep -n "allowMethods" src/app.ts
```

Expected: `"DELETE"` 포함 라인 출력 → 변경 없음.

**Step 4: 통과 확인**

```bash
bun run test src/modules/trips/trips.controller.test.ts src/openapi-doc.test.ts
bun run check
```

Expected: PASS — controller 4 it(200/403/403/재시도403), openapi-doc DELETE·DeleteTripResult 단언 통과.

**Step 5: 커밋**

```bash
git add src/modules/trips/trips.controller.ts src/modules/trips/trips.controller.test.ts src/openapi-doc.test.ts
git commit -m "feat(trips): DELETE /trips/{tripId} 라우트 추가 — admin 가드·200 {id,deleted}"
```

---

### Task 8: cascade 다이아몬드 통합테스트 — 복합 FK(NO ACTION) 무위반 검증

**Files:**
- Test(Create): `tests/db/trip-cascade.test.ts`

trip 삭제 시 자식이 전량 정리되고 FK 위반(23503)이 없음을 testcontainers로 실증한다. 다이아몬드: `expenses`는 `trip_id`(단일컬럼, onDelete cascade)로 삭제되지만 `(trip_id, paid_by_member_id)`·`(trip_id, settlement_currency)` 등 **복합 FK는 NO ACTION**이고, `expense_participants`/`settlement_transfers`/`settlement_transfer_events`의 멤버 복합 FK도 NO ACTION이다. PostgreSQL은 NO ACTION 검사를 statement 종료 시 수행하므로, cascade 폐포 내 참조·피참조 행이 함께 제거되면 위반이 발생하지 않음 — 이 성질이 곧 검증 대상(누군가 복합 FK를 RESTRICT로 바꾸면 23503으로 red).

이 태스크는 스키마 회귀 가드로, 프로덕션 코드 변경 없이 테스트만 추가한다(Task 5의 `repo.delete`에 의존).

**Step 1: 테스트 작성**

`tests/db/trip-cascade.test.ts` 신규:

```ts
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
      ((await ctx.sql.unsafe(`select count(*)::int as n from ${t} where trip_id = $1`, [trip])) as {
        n: number;
      }[])[0]!.n;
    for (const t of CHILD_TABLES) expect(await count(t), t).toBe(0);
    // (F3) settlement_currency_totals는 trip_id가 없어 캡처한 settlement_id로 검증
    const cur = await ctx.sql<
      { n: number }[]
    >`select count(*)::int as n from settlement_currency_totals where settlement_id=${settlement}`;
    expect(cur[0]!.n, "settlement_currency_totals").toBe(0);
    const trow = await ctx.sql<{ n: number }[]>`select count(*)::int as n from trips where id=${trip}`;
    expect(trow[0]!.n).toBe(0);
  });
});
```

**Step 2: 실행 확인**

```bash
bun run test tests/db/trip-cascade.test.ts
```

Expected: PASS — 삭제가 23503 없이 완료, 9개 자식 테이블(settlement_member_summaries 포함) + settlement_currency_totals(settlement_id 검증) + trips 잔존 0. (복합 FK 중 하나라도 RESTRICT/cascade-비호환으로 바뀌면 `repo.delete`가 `23503`으로 throw → 테스트 red. 이 회귀 감지가 본 태스크의 목적.)

**Step 3: 정적 검사**

```bash
bun run check
```

Expected: PASS — oxlint/oxfmt/tsc 통과.

**Step 4: 커밋**

```bash
git add tests/db/trip-cascade.test.ts
git commit -m "test(trips): trip 삭제 cascade 다이아몬드 통합테스트 — 복합 FK NO ACTION 무위반 검증"
```

---

### Task 9: openapi.json 재생성·커밋(계약 드리프트 방지)

**Files:**
- Modify: `openapi.json` (gen:openapi 산출물)

라우트/DTO 변경(DELETE 오퍼레이션 + `DeleteTripResult` 스키마)을 반영해 계약 파일을 재생성한다. CI `openapi-drift`가 `git diff`로 강제하므로 반드시 커밋.

**Step 1: 재생성**

```bash
bun run gen:openapi
```

Expected: `openapi.json written: N paths` 출력, `openapi.json`에 `"/v1/trips/{tripId}"`의 `delete` 오퍼레이션과 `components.schemas.DeleteTripResult`가 추가됨.

**Step 2: 드리프트 확인**

```bash
git --no-pager diff --stat openapi.json
grep -c "DeleteTripResult" openapi.json
```

Expected: `openapi.json` 변경분 존재, `DeleteTripResult` 매치 ≥1(스키마 등록 + 라우트 응답 참조).

**Step 3: 최종 통과 확인**

```bash
bun run test src/openapi-doc.test.ts
bun run check
```

Expected: PASS — 계약 서빙/스키마 단언 통과.

**Step 4: 커밋**

```bash
git add openapi.json
git commit -m "docs(trips): openapi.json 재생성 — DELETE /trips/{tripId}·DeleteTripResult 반영"
```

## ③ 초대 취소 + 재초대 revive-upsert (Task 10–14)

### Task 10: repo.revokeInvite + findMemberById (원자 취소 UPDATE·tripId 스코핑)

**Files:**
- Modify: `src/modules/members/members.repo.ts:41-62` (MemberRepo 인터페이스에 `revokeInvite`·`findMemberById` 추가)
- Modify: `src/modules/members/members.repo.ts:79-248` (DrizzleMemberRepo 구현 추가)
- Test: `src/modules/members/members.repo.test.ts` (describe 블록 추가)

**Step 1: 실패하는 테스트 작성** — `members.repo.test.ts` 하단(마지막 `});` = 파일 끝 `DrizzleMemberRepo` describe 닫힘 뒤)에 새 describe 추가:

```ts
describe("DrizzleMemberRepo.revokeInvite", () => {
  it("pending invite 취소 → invite_expired·토큰 null화(1행), 재취소 0행", async () => {
    const u = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const repo = new DrizzleMemberRepo(ctx.db);
    const { hash } = generateInviteToken();
    await repo.createInvite({
      tripId: trip,
      email: "rev@example.com",
      hash,
      expiresAt: future(),
      displayName: "R",
    });
    const row = await repo.findByTokenHash(hash);
    const revoked = await repo.revokeInvite(trip, row!.id);
    expect(revoked?.status).toBe("invite_expired");
    expect(await repo.findByTokenHash(hash)).toBeNull(); // 토큰 null화 → 조회 불가(uq_invite_token partial에서도 제거)
    expect(await repo.revokeInvite(trip, row!.id)).toBeNull(); // 재취소 0행(비-pending)
    expect((await repo.findMemberById(trip, row!.id))?.status).toBe("invite_expired");
  });

  it("교차-trip 취소 시도 → 0행(tripId 스코핑), 원본 불변", async () => {
    const u = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const other = await mkTrip(ctx.sql, await mkUser(ctx.sql));
    const repo = new DrizzleMemberRepo(ctx.db);
    const { hash } = generateInviteToken();
    await repo.createInvite({
      tripId: trip,
      email: "scope@example.com",
      hash,
      expiresAt: future(),
      displayName: "S",
    });
    const row = await repo.findByTokenHash(hash);
    expect(await repo.revokeInvite(other, row!.id)).toBeNull(); // 다른 trip → 0행
    expect((await repo.findMemberById(trip, row!.id))?.status).toBe("invited"); // 원본 invited 불변
  });
});
```

**Step 2: 실패 확인** — `bun run test src/modules/members/members.repo.test.ts`
Expected: **FAIL** — `repo.revokeInvite`·`repo.findMemberById`가 존재하지 않아 타입/런타임 오류(`TypeError: repo.revokeInvite is not a function`).

**Step 3: 최소 구현** — `members.repo.ts`의 `MemberRepo` 인터페이스에 `rotateInviteToken` 선언 바로 아래(52행 다음)에 추가:

```ts
  /** pending(invited) 초대 취소 — 단일 원자 UPDATE로 invite_expired 전이·토큰 null화. tripId 스코핑, 0행=비-pending/타-trip. */
  revokeInvite(tripId: string, inviteId: string): Promise<MemberRow | null>;
  /** (tripId, memberId) 단건 조회 — revoke 0행 시 상태 분기(멱등/409/404)용. */
  findMemberById(tripId: string, memberId: string): Promise<MemberRow | null>;
```

그리고 `DrizzleMemberRepo`에서 `rotateInviteToken` 메서드(129-147행) 바로 뒤에 구현 추가:

```ts
  /** 초대 취소: 단일 원자 UPDATE(status='invite_expired', 토큰 null화). trip_id·id·status='invited' 가드로 tripId 스코핑·멱등성 확보. 0행=비-pending/타-trip. */
  async revokeInvite(tripId: string, inviteId: string): Promise<MemberRow | null> {
    const rows = await this.db
      .update(tripMembers)
      .set({
        status: "invite_expired",
        invite_token_hash: null,
        invite_token_expires_at: null,
      })
      .where(
        and(
          eq(tripMembers.trip_id, tripId),
          eq(tripMembers.id, inviteId),
          eq(tripMembers.status, "invited"),
        ),
      )
      .returning(COLS);
    return rows[0] ?? null;
  }

  async findMemberById(tripId: string, memberId: string): Promise<MemberRow | null> {
    const rows = await this.db
      .select(COLS)
      .from(tripMembers)
      .where(and(eq(tripMembers.trip_id, tripId), eq(tripMembers.id, memberId)));
    return rows[0] ?? null;
  }
```

**Step 4: 통과 확인** — `bun run test src/modules/members/members.repo.test.ts`
Expected: **PASS** — 신규 2 케이스 포함 전체 green.

**Step 5: 커밋**

```bash
git add src/modules/members/members.repo.ts src/modules/members/members.repo.test.ts
bun run check
git commit -m "feat(members): 초대 취소 repo revokeInvite·findMemberById 추가"
```

(커밋 전 `bun run check`(oxlint+oxfmt+tsc) 통과 필수. 실패 시 `bun run fmt` 후 재실행.)

### Task 11: service.revokeInvite (멱등 no-op·409·404 분기)

**Files:**
- Modify: `src/modules/members/members.service.ts:1` (NotFoundError import 추가)
- Modify: `src/modules/members/members.service.ts:61-69` (`resendInvite` 뒤에 `revokeInvite` 추가)
- Test: `src/modules/members/members.service.test.ts:1-6` (import 보강) 및 신규 describe

**Step 1: 실패하는 테스트 작성** — `members.service.test.ts`의 import 6행을 교체:

```ts
import { ForbiddenError, ConflictError, NotFoundError } from "../../core/errors.ts";
import { randomUUID } from "node:crypto";
```

그리고 `MembersService.resendInvite` describe 블록 뒤에 추가:

```ts
describe("MembersService.revokeInvite", () => {
  it("pending 초대 취소 → invite_expired 반환", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const s = svc();
    const cmd = await s.createInvite(trip, "revoke@example.com", "R");
    const row = await s.revokeInvite(trip, cmd.inviteId);
    expect(row.status).toBe("invite_expired");
  });

  it("이미 취소된 초대 재취소 → 멱등 no-op(현 상태 반환, throw 없음)", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const s = svc();
    const cmd = await s.createInvite(trip, "idem-rev@example.com", "R");
    await s.revokeInvite(trip, cmd.inviteId);
    const again = await s.revokeInvite(trip, cmd.inviteId);
    expect(again.status).toBe("invite_expired");
  });

  it("이미 joined된 멤버 취소 시도 → ConflictError(409)", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const me = await mkUser(ctx.sql);
    const s = svc();
    const cmd = await s.createInvite(trip, "joined@example.com", "J");
    await s.acceptInvite(cmd.token, actor(me, "joined@example.com"));
    await expect(s.revokeInvite(trip, cmd.inviteId)).rejects.toThrow(ConflictError);
  });

  it("존재하지 않는 초대 취소 → NotFoundError(404)", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const s = svc();
    await expect(s.revokeInvite(trip, randomUUID())).rejects.toThrow(NotFoundError);
  });
});
```

**Step 2: 실패 확인** — `bun run test src/modules/members/members.service.test.ts`
Expected: **FAIL** — `deps.service.revokeInvite`(=`MembersService.revokeInvite`) 미구현 → `TypeError: s.revokeInvite is not a function`.

**Step 3: 최소 구현** — `members.service.ts` 1행 import에 `NotFoundError` 추가:

```ts
import { ConflictError, ForbiddenError, NotFoundError } from "../../core/errors.ts";
```

그리고 `resendInvite`(63-69행) 뒤에 메서드 추가:

```ts
  /** 초대 취소: 원자 UPDATE(invited→invite_expired). 0행이면 현재 행으로 분기 —
   *  이미 invite_expired면 멱등 no-op(200, 현 상태 반환), 부재면 404, 그 외(joined 등)면 취소불가 409. */
  async revokeInvite(tripId: string, inviteId: string): Promise<MemberRow> {
    const revoked = await this.repo.revokeInvite(tripId, inviteId);
    if (revoked) return revoked;
    const current = await this.repo.findMemberById(tripId, inviteId);
    if (!current) throw new NotFoundError("invite not found", { tripId, inviteId });
    if (current.status === "invite_expired") return current; // 재취소 멱등 no-op
    throw new ConflictError("invite is not pending (already accepted or removed)", {
      tripId,
      inviteId,
      status: current.status,
    });
  }
```

**Step 4: 통과 확인** — `bun run test src/modules/members/members.service.test.ts`
Expected: **PASS** — revoke 4 케이스 + 기존 accept/create/resend 케이스 전부 green.

**Step 5: 커밋**

```bash
git add src/modules/members/members.service.ts src/modules/members/members.service.test.ts
bun run check
git commit -m "feat(members): service.revokeInvite 멱등 취소·409·404 분기"
```

### Task 12: createInvite revive-upsert (취소·만료 이메일 재초대)

**Files:**
- Modify: `src/modules/members/members.repo.ts:42` (인터페이스 `createInvite` 반환형 `MemberRow | null`)
- Modify: `src/modules/members/members.repo.ts:83-99` (createInvite → INSERT ... ON CONFLICT DO UPDATE)
- Modify: `src/modules/members/members.service.ts:41-60` (try/catch 제거, null→409)
- Test: `src/modules/members/members.service.test.ts` (신규 revive 케이스; `hashToken` import는 5행에 이미 존재)

**Step 1: 실패하는 테스트 작성** — `members.service.test.ts`의 `MembersService.createInvite 중복 (finding #3 pass4)` describe 안에 케이스 추가:

```ts
  it("취소된 이메일 재초대 → 동일 행 revive(23505 없음)·새 토큰 유효", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const me = await mkUser(ctx.sql);
    const s = svc();
    const first = await s.createInvite(trip, "revive@example.com", "First");
    const invite = await new DrizzleMemberRepo(ctx.db).findByTokenHash(hashToken(first.token));
    await s.revokeInvite(trip, invite!.id);
    const second = await s.createInvite(trip, "revive@example.com", "Second");
    expect(second.inviteId).toBe(invite!.id); // 재INSERT 아님 — 동일 행 revive(FULL uq_member_email 회피)
    const r = await s.acceptInvite(second.token, actor(me, "revive@example.com"));
    expect(r.status).toBe("joined");
  });

  it("시간만료 초대(invited+토큰만료) 재초대 → 동일 행 revive(23505 없음)·새 토큰 유효 [F2]", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const me = await mkUser(ctx.sql);
    const s = svc();
    const first = await s.createInvite(trip, "expired@example.com", "Old");
    const invite = await new DrizzleMemberRepo(ctx.db).findByTokenHash(hashToken(first.token));
    // 시간만료 재현: status는 'invited' 그대로 두고 토큰 만료만 과거로(시간만료는 status를 바꾸지 않는 실제 동작).
    await ctx.sql`update trip_members set invite_token_expires_at = now() - interval '1 minute' where id = ${invite!.id}`;
    const second = await s.createInvite(trip, "expired@example.com", "New");
    expect(second.inviteId).toBe(invite!.id); // 재INSERT 아님 — 시간만료 invited 행 revive
    const r = await s.acceptInvite(second.token, actor(me, "expired@example.com"));
    expect(r.status).toBe("joined");
  });
```

**Step 2: 실패 확인** — `bun run test src/modules/members/members.service.test.ts`
Expected: **FAIL** — 현행 `createInvite`는 재INSERT → FULL `uq_member_email`(trip_id, normalized_invited_email) 위반으로 23505를 catch해 `ConflictError` throw. 두 번째 `createInvite`에서 rejects → assertion 실패.

**Step 3: 최소 구현** — `members.repo.ts` 인터페이스 42행 교체:

```ts
  createInvite(i: CreateInviteInput): Promise<MemberRow | null>;
```

그리고 `DrizzleMemberRepo.createInvite`(83-99행) 전체 교체:

```ts
  /** 초대 생성(revive-upsert): 신규는 INSERT, 같은 (trip_id, 정규화 이메일)이 invite_expired(취소) 또는 시간만료(invited+토큰 만료)면 재INSERT 대신 revive(status=invited·새 hash/expires·name/email 갱신).
   *  FULL uq_member_email이 재INSERT를 23505로 막으므로 ON CONFLICT DO UPDATE로 원자 처리. setWhere가 false(활성 invited/joined/deactivated)면 0행 → service가 409로 매핑. */
  async createInvite(i: CreateInviteInput): Promise<MemberRow | null> {
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
      .onConflictDoUpdate({
        target: [tripMembers.trip_id, tripMembers.normalized_invited_email], // = uq_member_email
        set: {
          invited_email: i.email,
          invite_token_hash: i.hash,
          invite_token_expires_at: i.expiresAt,
          display_name: i.displayName,
          status: "invited",
        },
        // F2 반영: 취소(invite_expired) + 시간만료(status='invited'이나 토큰 만료 — 시간만료는 status를 바꾸지 않으므로 이 조건 필수) 둘 다 revive.
        setWhere: sql`${tripMembers.status} = 'invite_expired' OR (${tripMembers.status} = 'invited' AND ${tripMembers.invite_token_expires_at} <= now())`,
      })
      .returning(COLS);
    return rows[0] ?? null; // 0행 = 활성 초대/멤버 이미 존재(revive 불가)
  }
```

이어서 `members.service.ts`의 `createInvite`(42-60행) 교체 — try/catch 제거, null→409:

```ts
  /** 초대 생성 → **delivery command 반환**(token 항상 반환). repo가 revive-upsert(취소/만료 재초대) 처리, 0행(활성 초대/멤버)만 409. 실 발송은 caller. */
  async createInvite(tripId: string, email: string, displayName: string): Promise<InviteCommand> {
    const { token, hash } = generateInviteToken();
    const row = await this.repo.createInvite({
      tripId,
      email,
      hash,
      expiresAt: this.expiry(),
      displayName,
    });
    // 0행 = uq_member_email 충돌이나 revive 대상(invite_expired) 아님 → 이미 초대/멤버(409).
    if (!row) throw new ConflictError("already invited or a member of this trip", { tripId });
    return { token, link: `/invite/${token}`, inviteId: row.id };
  }
```

(주: `isUniqueViolation`는 `acceptInvite`에서 계속 사용하므로 유지. 기존 "중복 초대/이미 멤버 → ConflictError" 케이스는 setWhere=false → 0행 → 동일하게 409로 유지.)

**Step 4: 통과 확인** — `bun run test src/modules/members/members.service.test.ts src/modules/members/members.repo.test.ts`
Expected: **PASS** — 취소 재초대 + **시간만료 재초대(F2)** 케이스 + 기존 중복/멤버 409 케이스 + repo 전체 green(반환형 변경이 기존 무-사용 호출과 정합).

**Step 5: 커밋**

```bash
git add src/modules/members/members.repo.ts src/modules/members/members.service.ts src/modules/members/members.service.test.ts
bun run check
git commit -m "feat(members): createInvite revive-upsert로 취소·만료 이메일 재초대 지원"
```

### Task 13: 취소 라우트 + InviteRevoked DTO + route/openapi-doc 테스트 + gen:openapi 재생성

**Files:**
- Modify: `src/modules/members/members.schema.ts:23-25` (`inviteRevokedSchema` 추가)
- Modify: `src/modules/members/members.controller.ts:9-14` (import 보강), `:92-109` 뒤(resend 라우트 뒤)에 revoke 라우트 추가
- Test: `src/modules/members/members.routes.test.ts` (revoke 케이스), `src/openapi-doc.test.ts` (라우트/스키마 단언)
- Modify: `openapi.json` (gen:openapi 재생성)

**Step 1: 실패하는 테스트 작성** — `members.routes.test.ts`의 `members/invites 라우트` describe 안에 추가:

```ts
  it("admin 초대 취소 → 200 invite_expired, 재취소 멱등 200", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const s = svc();
    await s.ensureCreatorMembership(trip, admin, "Admin", "admin@example.com");
    const cmd = await s.createInvite(trip, "revrt@example.com", "R");
    const app = appFor(admin, "admin@example.com");
    const res = await app.request(`/trips/${trip}/invites/${cmd.inviteId}/revoke`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("invite_expired");
    const again = await app.request(`/trips/${trip}/invites/${cmd.inviteId}/revoke`, {
      method: "POST",
    });
    expect(again.status).toBe(200); // 멱등 no-op
  });

  it("비-admin 취소 → 403", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const memberU = await mkUser(ctx.sql);
    const s = svc();
    await s.ensureCreatorMembership(trip, admin, "Admin", "admin@example.com");
    const cmd = await s.createInvite(trip, "target@example.com", "T");
    const { token } = await s.createInvite(trip, "m2@example.com", "M");
    await s.acceptInvite(token, { id: memberU, email: "m2@example.com" });
    const res = await appFor(memberU, "m2@example.com").request(
      `/trips/${trip}/invites/${cmd.inviteId}/revoke`,
      { method: "POST" },
    );
    expect(res.status).toBe(403);
  });

  it("존재하지 않는 초대 취소 → 404", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const s = svc();
    await s.ensureCreatorMembership(trip, admin, "Admin", "admin@example.com");
    const res = await appFor(admin, "admin@example.com").request(
      `/trips/${trip}/invites/00000000-0000-4000-8000-000000000000/revoke`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });
```

그리고 `openapi-doc.test.ts`의 첫 `it`(핵심 경로 등록) 뒤에 추가:

```ts
  it("초대 취소 라우트 등록(/invites/{inviteId}/revoke) + InviteRevoked 스키마(finding: invite_expired writer)", () => {
    const d = doc();
    const paths = Object.keys(d.paths ?? {});
    expect(paths.some((p) => p.includes("/invites/{inviteId}/revoke"))).toBe(true);
    expect(d.components?.schemas?.InviteRevoked).toBeDefined();
  });
```

**Step 2: 실패 확인** — `bun run test src/modules/members/members.routes.test.ts src/openapi-doc.test.ts`
Expected: **FAIL** — revoke 라우트 미등록: `POST /trips/{tripId}/invites/{inviteId}/revoke`가 404(라우트 부재)로 떨어지고, `InviteRevoked` 스키마 컴포넌트 미존재 → `toBeDefined` 실패.

**Step 3: 최소 구현** — `members.schema.ts` 하단(`acceptResponseSchema` 뒤)에 추가:

```ts
export const inviteRevokedSchema = z
  .object({
    id: z.string(),
    status: z.enum(["invited", "joined", "deactivated", "invite_expired"]),
  })
  .openapi("InviteRevoked");
```

`members.controller.ts`의 schema import(9-14행)에 `inviteRevokedSchema` 추가:

```ts
import {
  memberResponseSchema,
  createInviteSchema,
  updateMemberSchema,
  acceptResponseSchema,
  inviteRevokedSchema,
} from "./members.schema.ts";
```

재발송(resend) 라우트(93-109행) 등록 뒤에 revoke 라우트 추가:

```ts
  // 초대 취소(admin) — /revoke 세그먼트, tripId 스코핑. invited→invite_expired 전이, 재취소 멱등 200.
  app.openapi(
    createRoute({
      method: "post",
      path: "/trips/{tripId}/invites/{inviteId}/revoke",
      security: [{ cookieAuth: [] }],
      middleware: [auth, admin],
      request: {
        params: z.object({ tripId: z.string().uuid(), inviteId: z.string().uuid() }),
      },
      responses: { ...ok(inviteRevokedSchema), ...errorResponses(403, 404, 409) },
    }),
    async (c) => {
      const { tripId, inviteId } = c.req.valid("param");
      const row = await deps.service.revokeInvite(tripId, inviteId);
      return c.json(
        {
          id: row.id,
          status: row.status as "invited" | "joined" | "deactivated" | "invite_expired",
        },
        200,
      );
    },
  );
```

**Step 4: 통과 확인** — `bun run test src/modules/members/members.routes.test.ts src/openapi-doc.test.ts`
Expected: **PASS** — revoke 200/멱등/403/404 + doc 라우트·`InviteRevoked` 단언 green.

**Step 5: openapi.json 재생성 + 커밋** — 라우트/DTO 변경이므로 SSOT 재생성(CI openapi-drift가 git diff로 강제):

```bash
bun run gen:openapi
git add src/modules/members/members.schema.ts src/modules/members/members.controller.ts src/modules/members/members.routes.test.ts src/openapi-doc.test.ts openapi.json
bun run check
git commit -m "feat(members): 초대 취소 라우트·InviteRevoked DTO·openapi 재생성"
```

(`git diff --exit-code openapi.json` 이 clean해야 CI openapi-drift 통과 — 커밋에 openapi.json 포함 필수.)

### Task 14: invite_expired 소비경로 회귀 점검 (멤버목록 응답·PATCH 전이 가드)

**Files:**
- Test: `src/modules/members/members.routes.test.ts` (회귀 케이스 2건 추가)

invite_expired의 최초 writer가 revoke이므로, 이 상태를 소비하는 기존 경로들이 회귀하지 않는지 검증한다: (1) 멤버 목록 응답(`memberResponseSchema` enum이 invite_expired 수용) (2) `updateMember` 전이 가드(user_id null인 invite_expired 행을 PATCH로 joined 위조 차단).

**Step 1: 실패하는(회귀 감지) 테스트 작성** — `members.routes.test.ts` describe 안에 추가:

```ts
  it("취소된 초대는 멤버 목록에 invite_expired로 노출(응답 스키마 정합, 500 아님)", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const s = svc();
    await s.ensureCreatorMembership(trip, admin, "Admin", "admin@example.com");
    const cmd = await s.createInvite(trip, "listed@example.com", "L");
    await s.revokeInvite(trip, cmd.inviteId);
    const res = await appFor(admin, "admin@example.com").request(`/trips/${trip}/members`);
    expect(res.status).toBe(200); // memberResponseSchema enum이 invite_expired 수용 → serialize 성공
    const rows = (await res.json()) as { id: string; status: string }[];
    expect(rows.find((r) => r.id === cmd.inviteId)?.status).toBe("invite_expired");
  });

  it("invite_expired 행을 PATCH로 joined 위조 시도 → 거부(user_id null·전이 가드)", async () => {
    const admin = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, admin);
    const s = svc();
    await s.ensureCreatorMembership(trip, admin, "Admin", "admin@example.com");
    const cmd = await s.createInvite(trip, "guard@example.com", "G");
    await s.revokeInvite(trip, cmd.inviteId);
    const res = await appFor(admin, "admin@example.com").request(
      `/trips/${trip}/members/${cmd.inviteId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "joined" }),
      },
    );
    expect(res.status).not.toBe(200);
    expect([403, 404, 409, 422]).toContain(res.status); // updateMember: isNotNull(user_id)+status∈{joined,deactivated} 가드 0행 → 409
  });
```

**Step 2: 실패 확인** — `bun run test src/modules/members/members.routes.test.ts`
Expected: **PASS**(회귀 없음 확인 태스크) — 기대대로 통과해야 한다. 만약 목록이 500이거나 PATCH가 200이면 소비경로 회귀이므로 **FAIL**(그 경우 원인 수정). 정상 구현에서는 두 케이스 모두 green.

**Step 3: 최소 구현** — 신규 프로덕션 코드 불필요(회귀 방어 테스트). Task 10-13 구현으로 이미 충족.

**Step 4: 통과 확인** — `bun run test src/modules/members/members.routes.test.ts`
Expected: **PASS** — 회귀 케이스 2건 포함 전체 green.

**Step 5: 커밋**

```bash
git add src/modules/members/members.routes.test.ts
bun run check
git commit -m "test(members): invite_expired 소비경로(목록·PATCH 가드) 회귀"
```

## ④ 어드민 양도 (Task 15–18)

### Task 15: repo.transferAdmin — trip row FOR UPDATE + 강등선행 CAS 2문

**Files:**
- Modify: `src/modules/members/members.repo.ts:1` (import에 `ne` 추가), `src/modules/members/members.repo.ts:3-5` (`trips` 스키마 import 추가), `src/modules/members/members.repo.ts:18` (`TransferAdminOutcome` 타입 추가), `src/modules/members/members.repo.ts:56-57` (`MemberRepo` 인터페이스에 메서드 추가), `src/modules/members/members.repo.ts:247` (`DrizzleMemberRepo`에 구현 추가)
- Test: `src/modules/members/members.repo.test.ts:2-4` (import 보강), `src/modules/members/members.repo.test.ts:153` (describe 블록 추가)

**Step 1: 실패하는 테스트 작성**
`members.repo.test.ts` 상단 import를 보강한다(기존 `import { DrizzleMemberRepo }` 유지).

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { startDb, mkUser, mkTrip, mkMember, type Ctx } from "../../../tests/db/helpers.ts";
import { DrizzleMemberRepo } from "./members.repo.ts";
import { generateInviteToken, normalizeEmail } from "./domain/invite-token.ts";
```

파일 끝 `describe("DrizzleMemberRepo", …)` 블록 뒤에 추가한다.

```ts
describe("DrizzleMemberRepo.transferAdmin (④ 어드민 양도)", () => {
  it("joined admin→member 강등 + joined bound member→admin 승격, 활성 어드민 1명 유지", async () => {
    const u1 = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u1);
    const fromId = await mkMember(ctx.sql, trip, { userId: u1, role: "admin", status: "joined" });
    const u2 = await mkUser(ctx.sql);
    const toId = await mkMember(ctx.sql, trip, { userId: u2, role: "member", status: "joined" });
    const repo = new DrizzleMemberRepo(ctx.db);

    const res = await repo.transferAdmin(trip, fromId, toId);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.member.id).toBe(toId);
      expect(res.member.role).toBe("admin");
    }
    expect((await repo.findMembership(trip, u1))?.role).toBe("member");
    expect((await repo.findMembership(trip, u2))?.role).toBe("admin");
    // 정확히 1명 → 강등이 승격보다 먼저 커밋됨을 증명(역순이면 uq_one_admin 23505로 tx 전체 실패).
    expect(await repo.countActiveAdmins(trip)).toBe(1);
  });

  it("대상이 invited(user_id null) → target_ineligible, 원자 롤백(강등 미반영)", async () => {
    const u1 = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u1);
    const fromId = await mkMember(ctx.sql, trip, { userId: u1, role: "admin", status: "joined" });
    const invitedId = await mkMember(ctx.sql, trip, { email: "pending@e.com" }); // user_id null, status invited
    const repo = new DrizzleMemberRepo(ctx.db);

    const res = await repo.transferAdmin(trip, fromId, invitedId);

    expect(res).toEqual({ ok: false, reason: "target_ineligible" });
    expect((await repo.findMembership(trip, u1))?.role).toBe("admin"); // 강등 롤백
  });

  it("대상 부재(존재하지 않는 id) → target_missing", async () => {
    const u1 = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u1);
    const fromId = await mkMember(ctx.sql, trip, { userId: u1, role: "admin", status: "joined" });
    const repo = new DrizzleMemberRepo(ctx.db);

    const res = await repo.transferAdmin(trip, fromId, randomUUID());

    expect(res).toEqual({ ok: false, reason: "target_missing" });
  });

  it("호출자가 admin 아님 → not_admin(쓰기 없음)", async () => {
    const u1 = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u1);
    const notAdmin = await mkMember(ctx.sql, trip, { userId: u1, role: "member", status: "joined" });
    const u2 = await mkUser(ctx.sql);
    const toId = await mkMember(ctx.sql, trip, { userId: u2, role: "member", status: "joined" });
    const repo = new DrizzleMemberRepo(ctx.db);

    const res = await repo.transferAdmin(trip, notAdmin, toId);

    expect(res).toEqual({ ok: false, reason: "not_admin" });
  });
});
```

**Step 2: 실패 확인**
```
bun run test src/modules/members/members.repo.test.ts
```
Expected: FAIL — `repo.transferAdmin is not a function` (TypeError). `transferAdmin`가 아직 `DrizzleMemberRepo`에 없다.

**Step 3: 최소 구현**
`members.repo.ts` 1행 import에 `ne` 추가.

```ts
import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
```

5행 `import { ConflictError } …` 아래에 `trips` 스키마 import 추가.

```ts
import { trips } from "../../db/schema/trips.ts";
```

18행 `MemberUpdate` 인터페이스 아래에 결과 타입 추가.

```ts
/** 어드민 양도 결과. 실패는 서비스가 HTTP 에러로 매핑(not_admin→409, target_missing→404, target_ineligible→409). */
export type TransferAdminOutcome =
  | { ok: true; member: MemberPublic }
  | { ok: false; reason: "not_admin" | "target_missing" | "target_ineligible" };
```

`MemberRepo` 인터페이스(57행 `countActiveAdmins` 뒤)에 시그니처 추가.

```ts
  /** 어드민 원자 양도 — trip row FOR UPDATE 하 강등 선행→승격 후행(uq_one_admin non-deferrable, 역순 시 순간 2 admin 위반). */
  transferAdmin(
    tripId: string,
    fromMemberId: string,
    toMemberId: string,
  ): Promise<TransferAdminOutcome>;
```

`DrizzleMemberRepo` 클래스 끝(247행 `ensureCreatorMembership` 반환 뒤, 클래스 닫는 `}` 앞)에 구현 추가.

```ts
  /** ④ 어드민 양도: 단일 tx + trip row FOR UPDATE(동일 trip 동시 양도 직렬화, trip_members엔 version 없음).
   *  적격성은 잠금 하 read로 판정(실패 시 무-쓰기 → 커밋해도 무해), 쓰기는 강등→승격 순서 강제 + CAS WHERE로
   *  TOCTOU 제거. CAS 0행은 잠금 하 재검증 실패(경쟁)이므로 throw → 강등 롤백(원자성). */
  async transferAdmin(
    tripId: string,
    fromMemberId: string,
    toMemberId: string,
  ): Promise<TransferAdminOutcome> {
    return this.db.transaction(async (tx) => {
      await tx.select({ id: trips.id }).from(trips).where(eq(trips.id, tripId)).for("update");

      const [from] = await tx
        .select({ role: tripMembers.role, status: tripMembers.status })
        .from(tripMembers)
        .where(and(eq(tripMembers.trip_id, tripId), eq(tripMembers.id, fromMemberId)));
      if (!from || from.role !== "admin" || from.status !== "joined")
        return { ok: false, reason: "not_admin" };

      const [to] = await tx
        .select({
          role: tripMembers.role,
          status: tripMembers.status,
          user_id: tripMembers.user_id,
        })
        .from(tripMembers)
        .where(and(eq(tripMembers.trip_id, tripId), eq(tripMembers.id, toMemberId)));
      if (!to) return { ok: false, reason: "target_missing" };
      if (
        to.status !== "joined" ||
        to.user_id === null ||
        to.role !== "member" ||
        toMemberId === fromMemberId
      )
        return { ok: false, reason: "target_ineligible" };

      // (1) 강등 선행 — CAS WHERE(role='admin' AND status='joined')
      const demoted = await tx
        .update(tripMembers)
        .set({ role: "member" })
        .where(
          and(
            eq(tripMembers.trip_id, tripId),
            eq(tripMembers.id, fromMemberId),
            eq(tripMembers.role, "admin"),
            eq(tripMembers.status, "joined"),
          ),
        )
        .returning({ id: tripMembers.id });
      if (demoted.length === 0)
        throw new ConflictError("admin transfer race: caller no longer admin", {
          tripId,
          fromMemberId,
        });

      // (2) 승격 후행 — CAS WHERE(joined·bound·member·≠from)
      const promoted = await tx
        .update(tripMembers)
        .set({ role: "admin" })
        .where(
          and(
            eq(tripMembers.trip_id, tripId),
            eq(tripMembers.id, toMemberId),
            eq(tripMembers.status, "joined"),
            isNotNull(tripMembers.user_id),
            eq(tripMembers.role, "member"),
            ne(tripMembers.id, fromMemberId),
          ),
        )
        .returning(PUBLIC_COLS);
      if (promoted.length === 0)
        throw new ConflictError("admin transfer race: target no longer eligible", {
          tripId,
          toMemberId,
        });

      return { ok: true, member: promoted[0]! };
    });
  }
```

**Step 4: 통과 확인**
```
bun run test src/modules/members/members.repo.test.ts
```
Expected: PASS — 4개 케이스 모두 통과. 성공 케이스에서 `countActiveAdmins === 1`은 강등선행 순서를 검증.

**Step 5: 커밋**
```
bun run check
git add src/modules/members/members.repo.ts src/modules/members/members.repo.test.ts
git commit -m "feat(members): 어드민 양도 repo.transferAdmin — trip FOR UPDATE·강등선행 CAS 2문"
```

---

### Task 16: service.transferAdmin — from/to 매핑·403/404/409 분기

**Files:**
- Modify: `src/modules/members/members.service.ts:1` (import에 `NotFoundError` 추가), `src/modules/members/members.service.ts:136` (`transferAdmin` 메서드 추가)
- Test: `src/modules/members/members.service.test.ts:2` (import 보강), `src/modules/members/members.service.test.ts:6` (import 보강), `src/modules/members/members.service.test.ts:146` (describe 블록 추가)

**Step 1: 실패하는 테스트 작성**
`members.service.test.ts` import를 보강한다.

```ts
import { startDb, mkUser, mkTrip, mkMember, type Ctx } from "../../../tests/db/helpers.ts";
import { randomUUID } from "node:crypto";
```
```ts
import { ForbiddenError, ConflictError, NotFoundError } from "../../core/errors.ts";
```

파일 끝 `describe("MembersService.assertNotLastAdmin", …)` 뒤에 추가한다.

```ts
describe("MembersService.transferAdmin (④ 어드민 양도)", () => {
  it("성공 → 신 admin memberResponse 반환", async () => {
    const u1 = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u1);
    const fromId = await mkMember(ctx.sql, trip, { userId: u1, role: "admin", status: "joined" });
    const u2 = await mkUser(ctx.sql);
    const toId = await mkMember(ctx.sql, trip, { userId: u2, role: "member", status: "joined" });

    const m = await svc().transferAdmin(trip, fromId, toId);

    expect(m.id).toBe(toId);
    expect(m.role).toBe("admin");
  });

  it("호출자 비-admin(경쟁) → ConflictError", async () => {
    const u1 = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u1);
    const notAdmin = await mkMember(ctx.sql, trip, {
      userId: u1,
      role: "member",
      status: "joined",
    });
    const u2 = await mkUser(ctx.sql);
    const toId = await mkMember(ctx.sql, trip, { userId: u2, role: "member", status: "joined" });
    await expect(svc().transferAdmin(trip, notAdmin, toId)).rejects.toThrow(ConflictError);
  });

  it("대상 부재 → NotFoundError", async () => {
    const u1 = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u1);
    const fromId = await mkMember(ctx.sql, trip, { userId: u1, role: "admin", status: "joined" });
    await expect(svc().transferAdmin(trip, fromId, randomUUID())).rejects.toThrow(NotFoundError);
  });

  it("대상 부적격(invited) → ConflictError", async () => {
    const u1 = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u1);
    const fromId = await mkMember(ctx.sql, trip, { userId: u1, role: "admin", status: "joined" });
    const invitedId = await mkMember(ctx.sql, trip, { email: "p@e.com" });
    await expect(svc().transferAdmin(trip, fromId, invitedId)).rejects.toThrow(ConflictError);
  });
});
```

**Step 2: 실패 확인**
```
bun run test src/modules/members/members.service.test.ts
```
Expected: FAIL — `service.transferAdmin is not a function` (TypeError). `MembersService`에 메서드 부재.

**Step 3: 최소 구현**
`members.service.ts` 1행 import에 `NotFoundError` 추가.

```ts
import { ConflictError, ForbiddenError, NotFoundError } from "../../core/errors.ts";
```

`MembersService` 클래스 끝(136행 `assertNotLastAdmin` 뒤, 클래스 닫는 `}` 앞)에 추가.

```ts
  /** ④ 어드민 양도: from=호출자 membership.id(미들웨어가 admin 보장), to=경로 memberId.
   *  전체 원자성은 repo tx가 담당. repo 결과 discriminant를 HTTP 에러로 매핑. */
  async transferAdmin(
    tripId: string,
    fromMemberId: string,
    toMemberId: string,
  ): Promise<MemberPublic> {
    const res = await this.repo.transferAdmin(tripId, fromMemberId, toMemberId);
    if (res.ok) return res.member;
    switch (res.reason) {
      // 미들웨어가 요청 시점 admin을 보장 → 0행 강등은 동시 강등/비활성 경쟁(409).
      case "not_admin":
        throw new ConflictError("caller is no longer an active admin", { tripId, fromMemberId });
      case "target_missing":
        throw new NotFoundError("target member not found in this trip", { tripId, toMemberId });
      case "target_ineligible":
        throw new ConflictError("target must be a joined, account-bound member", {
          tripId,
          toMemberId,
        });
    }
  }
```

**Step 4: 통과 확인**
```
bun run test src/modules/members/members.service.test.ts
```
Expected: PASS — 성공/409(비-admin)/404(부재)/409(부적격) 4케이스 통과.

**Step 5: 커밋**
```
bun run check
git add src/modules/members/members.service.ts src/modules/members/members.service.test.ts
git commit -m "feat(members): service.transferAdmin — from/to 매핑·403/404/409 에러 분기"
```

---

### Task 17: transfer-admin 라우트 + openapi 재생성 + doc 단언

**Files:**
- Modify: `src/modules/members/members.controller.ts:90` (PATCH 라우트 뒤에 transfer-admin 라우트 추가)
- Modify: `openapi.json` (`bun run gen:openapi`로 재생성)
- Test: `src/modules/members/members.routes.test.ts:110` (describe 내 케이스 추가), `src/openapi-doc.test.ts:26-33` (경로 존재 단언 추가)

**재시도 계약(F4 반영):** transfer-admin은 멱등 미적용이다. 양도 성공 후 호출자가 member로 강등되므로 lost-response 재시도는 `requireTripMember(admin)`에서 **403**으로 떨어진다(service의 "자연 멱등 409"에 도달하지 못함 — 이전 초안의 표현을 정정). 이 403이 권한변경 작업의 **수용된 재시도 계약**이며 Step 1에서 테스트로 고정한다. (Idempotency-Key는 사용자 결정에 따라 추가하지 않음.)

**Step 1: 실패하는 테스트 작성**
`members.routes.test.ts`의 `describe("members/invites 라우트", …)` 안, 마지막 `it` 뒤에 추가한다(기존 `svc`/`appFor` 헬퍼 재사용).

```ts
  it("admin이 다른 joined 멤버에게 양도 → 200 + 신 admin", async () => {
    const adminU = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, adminU);
    const s = svc();
    await s.ensureCreatorMembership(trip, adminU, "Admin", "admin@example.com");
    const targetU = await mkUser(ctx.sql);
    const { token } = await s.createInvite(trip, "t@example.com", "T");
    const target = await s.acceptInvite(token, { id: targetU, email: "t@example.com" });
    const res = await appFor(adminU, "admin@example.com").request(
      `/trips/${trip}/members/${target.id}/transfer-admin`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe("admin");
  });
  it("비-admin 양도 시도 → 403", async () => {
    const adminU = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, adminU);
    const s = svc();
    await s.ensureCreatorMembership(trip, adminU, "Admin", "admin@example.com");
    const memberU = await mkUser(ctx.sql);
    const { token } = await s.createInvite(trip, "m@example.com", "M");
    const member = await s.acceptInvite(token, { id: memberU, email: "m@example.com" });
    const res = await appFor(memberU, "m@example.com").request(
      `/trips/${trip}/members/${member.id}/transfer-admin`,
      { method: "POST" },
    );
    expect(res.status).toBe(403);
  });
  it("대상이 invited(부적격) → 409", async () => {
    const adminU = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, adminU);
    const s = svc();
    await s.ensureCreatorMembership(trip, adminU, "Admin", "admin@example.com");
    const cmd = await s.createInvite(trip, "pending@example.com", "P");
    const res = await appFor(adminU, "admin@example.com").request(
      `/trips/${trip}/members/${cmd.inviteId}/transfer-admin`,
      { method: "POST" },
    );
    expect(res.status).toBe(409);
  });
  it("양도 성공 후 구 admin 재시도 → 403 (강등돼 admin 가드 우선, 거짓 성공/409 아님) [F4]", async () => {
    const adminU = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, adminU);
    const s = svc();
    await s.ensureCreatorMembership(trip, adminU, "Admin", "admin@example.com");
    const targetU = await mkUser(ctx.sql);
    const { token } = await s.createInvite(trip, "t2@example.com", "T2");
    const target = await s.acceptInvite(token, { id: targetU, email: "t2@example.com" });
    const path = `/trips/${trip}/members/${target.id}/transfer-admin`;
    expect((await appFor(adminU, "admin@example.com").request(path, { method: "POST" })).status).toBe(200);
    // 재시도: 양도로 구 admin이 member로 강등됨 → requireTripMember(admin)가 먼저 403(service 미도달).
    // 무가드·멱등 미적용 결정 하에서 이 403이 권한변경 작업의 수용된 재시도 계약이다(F4 반영).
    expect((await appFor(adminU, "admin@example.com").request(path, { method: "POST" })).status).toBe(403);
  });
```

`openapi-doc.test.ts`의 첫 `it("핵심 경로 등록…")` 안, 기존 `/resend` 단언 뒤에 추가한다.

```ts
    // ④ 어드민 양도 경로(FE codegen SSOT)
    expect(paths.some((p) => p.includes("/members/{memberId}/transfer-admin"))).toBe(true);
```

**Step 2: 실패 확인**
```
bun run test src/modules/members/members.routes.test.ts src/openapi-doc.test.ts
```
Expected: FAIL — 라우트 미등록. routes 테스트는 매칭 라우트 부재로 `expect(200).toBe` 대신 404 수신, doc 테스트는 `transfer-admin` 경로가 `paths`에 없어 `expect(false).toBe(true)`.

**Step 3: 최소 구현**
`members.controller.ts` PATCH 멤버 수정 라우트 블록(90행 닫는 `);`) 뒤에 추가한다.

```ts
  // 어드민 양도(admin) — 강등선행→승격 원자 tx. from=호출자 membership.id, to=경로 memberId.
  app.openapi(
    createRoute({
      method: "post",
      path: "/trips/{tripId}/members/{memberId}/transfer-admin",
      security: [{ cookieAuth: [] }],
      middleware: [auth, admin],
      request: {
        params: z.object({ tripId: z.string().uuid(), memberId: z.string().uuid() }),
      },
      responses: { ...ok(memberResponseSchema), ...errorResponses(403, 404, 409) },
    }),
    async (c) => {
      const { tripId, memberId } = c.req.valid("param");
      const membership = c.get("membership");
      const member = await deps.service.transferAdmin(tripId, membership.id, memberId);
      return c.json(member, 200);
    },
  );
```

라우트/DTO가 바뀌었으므로 openapi.json을 재생성한다.
```
bun run gen:openapi
```

**Step 4: 통과 확인**
```
bun run test src/modules/members/members.routes.test.ts src/openapi-doc.test.ts
```
Expected: PASS — 200(양도 성공)/403(비-admin)/409(부적격)/재시도403(구 admin, F4) + doc 경로 존재 단언 통과. `openapi.json`에 `/v1/trips/{tripId}/members/{memberId}/transfer-admin` 등록.

**Step 5: 커밋**
```
bun run check
git add src/modules/members/members.controller.ts src/modules/members/members.routes.test.ts src/openapi-doc.test.ts openapi.json
git commit -m "feat(members): transfer-admin 라우트 추가 + openapi.json 재생성·doc 단언"
```

---

### Task 18: 동시성 하드닝(F6) — updateMember 비활성을 trip 락 하 원자 last-admin 재검증 + 양도 경쟁

**Files:**
- Modify: `src/modules/members/members.repo.ts:54-55` (인터페이스 `updateMember` 반환형에 `"last_admin"` 추가), `src/modules/members/members.repo.ts:153-181` (비활성 전이를 trip 락 하 tx로)
- Modify: `src/modules/members/members.service.ts:76-87` (사전 `isLastActiveAdmin` 제거, repo 결과 매핑)
- Test: `src/modules/members/members.service.test.ts` (양도 vs 대상(B) 비활성 + 양도 vs 구 admin(A) 자기비활성 경쟁)

**배경(F6):** 현재 `service.updateMember`는 `isLastActiveAdmin`를 UPDATE **이전 별도 쿼리**로 실행하고 trip 락을 잡지 않는다. 따라서 양도로 B가 admin으로 승격된 뒤 `updateMember(B, deactivated)`가 stale 가드(B가 member일 때 평가)를 통과해 **활성 admin 0명**을 만들 수 있다(`uq_one_admin`은 2명은 막아도 0명은 못 막음). 비활성 전이를 trip FOR UPDATE 하 원자로 옮겨 양도의 승격과 직렬화하고 락 하에서 last-admin을 재검증한다.

**Step 1: 실패하는 race 테스트 작성**
`members.service.test.ts`의 `describe("MembersService.transferAdmin …")` 뒤에 추가한다(import는 Task 16에서 이미 보강됨; `DrizzleMemberRepo`는 상단 import됨).

```ts
describe("MembersService.transferAdmin 동시성 (④ · F6)", () => {
  // (F9·F11) 결정론적 증명: 외부 tx가 trip 락을 쥔 채 '양도 완료'(A 강등·B 승격)를 시뮬레이션 후 해제.
  // updateMember(B, deactivate)는 락 대기 후 **락 하 재검증**으로 B(이제 유일 admin) 비활성을 차단해야 함.
  // 미수정(락 미획득)=대기 안 함→red · stale 사전검사+락대기 구현=재검증 없이 B 비활성→0 admin→red · 수정=차단→green.
  it("[F6] 승격된 대상(B) 비활성은 락 하 재검증으로 차단 — 0 admin 방지", async () => {
    const u1 = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u1);
    const aId = await mkMember(ctx.sql, trip, { userId: u1, role: "admin", status: "joined" });
    const u2 = await mkUser(ctx.sql);
    const bId = await mkMember(ctx.sql, trip, { userId: u2, role: "member", status: "joined" });
    const s = svc();

    let outcome: "pending" | "resolved" | "rejected" = "pending";
    let pending!: Promise<unknown>;
    await ctx.sql.begin(async (tx) => {
      await tx`select id from trips where id = ${trip} for update`; // 양도가 trip 락을 쥔 상태를 모사
      pending = s
        .updateMember(trip, bId, { status: "deactivated" })
        .then(() => (outcome = "resolved"), () => (outcome = "rejected"));
      await new Promise((r) => setTimeout(r, 150));
      expect(outcome).toBe("pending"); // 수정=락 대기(미수정=락 미획득→즉시 완료→red)
      // 락 하에서 '양도 완료' 시뮬레이션: 강등 선행(A→member) 후 승격(B→admin) — uq_one_admin 안전.
      await tx`update trip_members set role = 'member' where trip_id = ${trip} and id = ${aId}`;
      await tx`update trip_members set role = 'admin' where trip_id = ${trip} and id = ${bId}`;
    }); // 커밋 → 락 해제 → updateMember가 락 획득·재검증
    await pending;
    // 락 하 재검증: B는 이제 유일 admin → 비활성 차단(ForbiddenError). 0 admin 방지.
    expect(outcome).toBe("rejected"); // stale 사전검사 구현이면 resolved(0 admin)→red
    expect(await new DrizzleMemberRepo(ctx.db).countActiveAdmins(trip)).toBe(1);
  });

  it("양도 vs 구 admin(A) 자기비활성 경쟁 → 활성 admin 정확히 1명, 500 없음", async () => {
    const u1 = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u1);
    const fromId = await mkMember(ctx.sql, trip, { userId: u1, role: "admin", status: "joined" });
    const u2 = await mkUser(ctx.sql);
    const toId = await mkMember(ctx.sql, trip, { userId: u2, role: "member", status: "joined" });
    const s = svc();
    const results = await Promise.allSettled([
      s.transferAdmin(trip, fromId, toId),
      s.updateMember(trip, fromId, { status: "deactivated" }),
    ]);
    const repo = new DrizzleMemberRepo(ctx.db);
    expect(await repo.countActiveAdmins(trip)).toBe(1);
    expect((await repo.findMembership(trip, u2))?.role).toBe("admin");
    for (const r of results) {
      if (r.status === "rejected") {
        expect((r.reason as { status?: number }).status).toBeGreaterThanOrEqual(400);
        expect((r.reason as { status?: number }).status).toBeLessThan(500);
      }
    }
  });
});
```

**Step 2: 실패 확인**
```
bun run test src/modules/members/members.service.test.ts
```
Expected: **FAIL** — (F9·F11 결정론적) 수정 전 `updateMember(deactivate)`는 trip 락을 안 잡아 즉시 완료(`outcome!=='pending'`) → `expect(outcome).toBe('pending')` 실패. 또한 '락 대기 + stale 사전검사' 구현이면 대기는 하나 재검증 없이 B를 비활성 → `outcome==='resolved'`(0 admin) → `expect(outcome).toBe('rejected')` 실패. 미수정·stale-bug 모두 red.

**Step 3: 최소 구현 — 비활성 전이를 trip 락 하 원자로**

(1) `members.repo.ts` 인터페이스(`updateMember` 시그니처, 54-55행) 반환형에 `"last_admin"` 추가:

```ts
  /** 멤버 수정 — status는 **user_id 바인딩된 joined↔deactivated만**. 비활성은 trip 락 하 last-admin 재검증(F6). 0행=불가/부재, "last_admin"=마지막 admin 비활성 차단. */
  updateMember(
    tripId: string,
    memberId: string,
    patch: MemberUpdate,
  ): Promise<MemberPublic | null | "last_admin">;
```

(2) `DrizzleMemberRepo.updateMember`(153-181행) 전체 교체 — 비활성 전이만 tx + trip FOR UPDATE + 락 하 last-admin 재검증(`trips` import는 Task 15에서 이미 추가됨):

```ts
  /** 멤버 수정. status 변경은 user_id 바인딩된 joined↔deactivated만(위조 차단, finding #3 pass3).
   *  (F6) 비활성 전이는 trip 락 하 원자로 — 양도의 동시 승격과 직렬화해 last-admin 재검증이 stale하지 않게. */
  async updateMember(
    tripId: string,
    memberId: string,
    patch: MemberUpdate,
  ): Promise<MemberPublic | null | "last_admin"> {
    const set: { display_name?: string; status?: "joined" | "deactivated" } = {};
    if (patch.display_name !== undefined) set.display_name = patch.display_name;
    if (patch.status !== undefined) set.status = patch.status;
    if (Object.keys(set).length === 0) {
      const cur = await this.db
        .select(PUBLIC_COLS)
        .from(tripMembers)
        .where(and(eq(tripMembers.trip_id, tripId), eq(tripMembers.id, memberId)));
      return cur[0] ?? null;
    }
    // 비활성: trip 락 하 재검증(F6). 마지막 활성 admin이면 차단(0 admin 방지).
    if (patch.status === "deactivated") {
      return this.db.transaction(async (tx) => {
        await tx.select({ id: trips.id }).from(trips).where(eq(trips.id, tripId)).for("update");
        const admins = await tx
          .select({ id: tripMembers.id })
          .from(tripMembers)
          .where(
            and(
              eq(tripMembers.trip_id, tripId),
              eq(tripMembers.role, "admin"),
              eq(tripMembers.status, "joined"),
            ),
          );
        if (admins.length === 1 && admins[0]?.id === memberId) return "last_admin" as const;
        const rows = await tx
          .update(tripMembers)
          .set(set)
          .where(
            and(
              eq(tripMembers.trip_id, tripId),
              eq(tripMembers.id, memberId),
              isNotNull(tripMembers.user_id),
              inArray(tripMembers.status, ["joined", "deactivated"]),
            ),
          )
          .returning(PUBLIC_COLS);
        return rows[0] ?? null;
      });
    }
    // display_name·joined 전이는 단문(락 불요).
    const conds = [eq(tripMembers.trip_id, tripId), eq(tripMembers.id, memberId)];
    if (patch.status !== undefined) {
      conds.push(isNotNull(tripMembers.user_id));
      conds.push(inArray(tripMembers.status, ["joined", "deactivated"]));
    }
    const rows = await this.db
      .update(tripMembers)
      .set(set)
      .where(and(...conds))
      .returning(PUBLIC_COLS);
    return rows[0] ?? null;
  }
```

(3) `members.service.ts`의 `updateMember`(76-87행) 교체 — 사전 `isLastActiveAdmin` 제거, repo 결과 매핑:

```ts
  /** 멤버 수정(display_name·status). 비활성 시 마지막 어드민 가드(§9.5)는 repo가 trip 락 하 원자 재검증(F6). */
  async updateMember(tripId: string, memberId: string, patch: MemberUpdate): Promise<MemberPublic> {
    const row = await this.repo.updateMember(tripId, memberId, patch);
    if (row === "last_admin")
      throw new ForbiddenError("cannot deactivate the last admin", { tripId, memberId });
    if (!row)
      throw new ConflictError("member update not allowed (invalid transition or not found)", {
        tripId,
        memberId,
      });
    return row;
  }
```

(주: 기존 `repo.isLastActiveAdmin`는 다른 테스트가 참조하므로 유지 — `updateMember`는 더 이상 사전 호출하지 않는다. 기존 "마지막 admin 비활성 차단" 테스트는 동일 `ForbiddenError`로 계속 green.)

**Step 4: 통과 확인**
```
bun run test src/modules/members/members.service.test.ts src/modules/members/members.repo.test.ts
```
Expected: **PASS** — [F6] updateMember가 trip 락 대기(결정론적) 후 진행·`countActiveAdmins===1`, 구 admin 자기비활성 경쟁도 1명, 기존 비활성/전이 테스트 green.

**Step 5: 커밋**
```
bun run check
git add src/modules/members/members.repo.ts src/modules/members/members.service.ts src/modules/members/members.service.test.ts
git commit -m "fix(members): 멤버 비활성을 trip 락 하 원자 last-admin 재검증으로 강화 — 양도 경쟁 0 admin 방지"
```



---

## ⑤ 문서 갱신 및 최종 검증

### Task 19: 계약 설계 문서 갱신 (SSOT drift 해소)

**Files:**
- Modify: `docs/plans/2026-06-29-api-contract-design.md` (어드민 양도 PATCH 표기 → 전용 액션; Idempotency-Key "지출생성만" → 5개 라우트)

코드/api-routes를 SSOT로 확정하고, 이보다 오래된 계약 설계 문서 2건의 drift를 해소한다.

**Step 1: 어드민 양도 표기 갱신**

`docs/plans/2026-06-29-api-contract-design.md`에서 어드민 양도를 PATCH(멤버 role 수정)로 서술한 부분(≈16행)을 전용 트랜잭션 액션 `POST /trips/{tripId}/members/{memberId}/transfer-admin`(강등선행 원자 swap, `uq_one_admin` non-deferrable)으로 수정한다.

**Step 2: Idempotency-Key 대상 갱신**

같은 문서 §5/D3의 "지출 생성만 Idempotency-Key 지원" 문언을 "지출 생성 + 정산 finalize/unlock/mark-paid/mark-unpaid, 총 5개 라우트"로 수정한다.

**Step 3: 잔재 확인**

Run: `grep -n "transfer-admin\|Idempotency\|양도" docs/plans/2026-06-29-api-contract-design.md`
Expected: 갱신된 전용 액션 표기와 5개 라우트 서술만 존재(PATCH 양도·"지출생성만" 잔재 없음).

**Step 4: 커밋**

```bash
git add docs/plans/2026-06-29-api-contract-design.md
git commit -m "docs(contract): 어드민 양도 전용 액션·Idempotency-Key 5개 라우트로 계약 문서 갱신"
```

---

### Task 20: 최종 통합 검증

**Files:**
- (없음 — 검증 전용)

**Step 1: 전체 테스트 스위트**

Run: `bun run test`
Expected: PASS — 신규 케이스 포함 전체 green(testcontainers PG 통합테스트 포함 — Docker 필요).

**Step 2: 정적 검사 + 계약 drift 0**

Run: `bun run check && bun run gen:openapi && git diff --exit-code openapi.json`
Expected: oxlint/oxfmt/tsc 통과, 마지막 `git diff --exit-code`가 exit 0(`openapi.json`이 코드와 완전 일치 → CI `openapi-drift` 통과).

**Step 3: 커밋 상태 확인**

Run: `git status --short && git log --oneline feat/be-contract-close ^main`
Expected: 워킹트리 clean, 4기능 + 문서 갱신 커밋들이 `feat/be-contract-close` 브랜치에 존재.

---

## Adversarial review dispositions

codex 적대적 리뷰(`adversarial-review.mjs`, `--scope working-tree`) **4패스**. 3패스 캡 도달 후 사용자 승인으로 Pass 4 진행. 각 패스 launcher JSON은 `ok:true`·`planInDiff:true`로 검증됨.

**Pass 1** (`needs-attention`, 4):
- **F1** (high) Hard delete retry 계약 없음 — **Accepted(범위조정)**: "2회차 404" 주장 오류 정정 → 재시도 시 멤버십 cascade 제거로 admin 가드가 먼저 **403**; 재시도 403 테스트 추가. Idempotency-Key는 무가드/no-idem 결정 존중해 미추가.
- **F2** (high) 시간만료 초대 revive 안 됨 — **Accepted**: revive-upsert 술어를 `invite_expired OR (invited AND 토큰 만료)`로 확장 + 시간만료 재초대 테스트.
- **F3** (medium) cascade 테스트가 정산 스냅샷 자식 누락 — **Accepted**: `settlement_member_summaries`(trip_id)·`settlement_currency_totals`(settlement_id) 삽입·삭제 단언 추가.
- **F4** (medium) transfer-admin 재시도 거짓 403 — **Accepted(범위조정)**: "자연 멱등 409" 정정 → 재시도 403(강등돼 가드 우선) + 테스트. 멱등 미추가.

**Pass 2** (`needs-attention`, 2):
- **F5** (high) DELETE가 tx 밖 stale admin 미들웨어 의존(TOCTOU) — **Accepted**: `deleteTrip(tripId, callerMembershipId)`가 trip 락 하 admin 재검증, 강등된 호출자 403.
- **F6** (high) 양도 동시성 테스트가 대상 비활성 race 누락 — **Accepted**: `updateMember` 비활성 경로를 tx + trip `FOR UPDATE` 하 last-admin 재검증으로 강화(0 admin 방지).

**Pass 3** (`needs-attention`, 3):
- **F7** (high) delete 락 안전성이 선택(옵션 tx) — **Accepted**: `repo.delete`가 tx 미제공 시 내부 tx로 원자성 강제.
- **F8** (medium) cascade 테스트가 옛 delete 시그니처 호출 — **Accepted**: 신 시그니처 `repo.delete(trip, m1)` → `"deleted"`.
- **F9** (medium) F6 race 테스트 false-green 가능 — **Accepted**: 결정론적 trip-락 획득/재검증 테스트로 교체.

**Pass 4** (`needs-attention`, 2):
- **F10** (high) trip 삭제 롤백/복구 경로 없음 — **Accepted as known-limitation(설계 결정)**: 사용자가 informed 상태로 "무가드 hard-delete, cascade 데이터 소실을 어드민 권한으로 수용"을 명시 선택(결정 2·PRD §602 hard cascade). 재시도 계약은 F1/F5로 해소, 감사로그는 out-of-scope. 복구 경로 추가는 결정을 뒤집는 재설계이므로 미채택. 캡 초과 open-items 제시 후 사용자 informed 결정으로 **수용**.
- **F11** (high) F6 테스트가 승격된 대상 비활성 race 미커버 — **Accepted**: 승격 시뮬레이션 후 락 하 재검증 차단을 결정론적으로 검증하는 테스트로 교체(미수정·stale-bug 모두 red).

**최종 pass(Pass 4) verdict:** `needs-attention` / summary: "No ship: the plan still leaves an irreversible delete path without a recovery contract, and the F6 concurrency proof misses the exact race it claims to close." → F11 반영, F10은 사용자 informed 결정으로 known-limitation 수용하여 캡 초과 승인 하 finalize.

### Known limitations (수용됨)
- **DELETE /trips는 무가드 hard-delete**: finalized 정산·paid transfer 포함 전 자식이 FK cascade로 **영구 삭제**되며 soft-delete/복구/tombstone 없음. 어드민 권한 정책으로 의도적 수용(결정 2·PRD §602). 재시도는 403(멤버십 cascade 제거)로 안전하게 구분됨. 삭제 감사로그는 후속 슬라이스.

---

## Execution directives

- **Skill:** `executing-plans`로 **별도 세션·이 워크트리에서** 구현 (`~/workspace/trip-mate-api/.worktrees/be-contract-close`, 브랜치 `feat/be-contract-close`).
- **연속 실행:** 배치 사이에서 루틴 리뷰로 멈추지 말 것. 진짜 블로커에서만 중단 — 누락 의존성, 반복 실패하는 검증, 불명확/모순 지시, 치명적 계획 공백(executing-plans의 "When to Stop and Ask"). 그 외엔 전 Task(1–20) 완료까지 진행.
- **테스트 실행 환경:** 통합/DB 테스트는 **Docker(testcontainers PostgreSQL 16)** 필요. 실행 세션 시작 시 Docker 가용 확인. `bun run test`가 전체, 단일 파일은 `bun run test <경로>`.
- **커밋 — 아래 규칙을 직접 적용, `Skill(commit)` 호출 금지**(대화형 확인이 연속 실행을 깸):
  - **Language:** 커밋 메시지 **한국어**. **AI 마커 금지**(`🤖 Generated with`, `Co-Authored-By: Claude` 등 절대 포함 금지).
  - **Format:** `<type>(<scope>): 한국어 설명` (필요 시 `- 상세` 본문).
  - **Type — 다음만 사용:** `feat`·`fix`·`refactor`·`docs`·`style`·`test`·`chore`. `perf`/`build`/`ci` 등 금지.
  - **Grouping(우선순위):** ① 같은 기능/모듈 디렉토리 함께 ② 목적별 분리(refactor vs fix vs feature) ③ 서로 import/참조하는 파일 함께 ④ 변경 유형별 분리 — config·tests·docs·standalone style/CSS 각각 별도.
  - **Judgment:** 같은 dir+같은 목적 → 한 커밋; 다른 파일 없이는 무의미한 변경 → 같은 커밋; 독립 설명 가능한 변경 → 별도 커밋.
  - **Where:** 각 plan `Commit` 스텝에서 현재 feature-branch worktree에 직접 커밋(이미 `main` 밖이므로 새 브랜치 불요). 라우트/DTO 변경 커밋에는 반드시 재생성된 `openapi.json` 포함(CI `openapi-drift`).
