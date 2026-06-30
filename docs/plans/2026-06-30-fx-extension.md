# FX 확장 구현 계획 (card_billed·preview·편집재계산·trip_default)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** expenses 도메인의 FX 기능 완성 — card_billed·`:preview`·편집재계산·trip_default 승격 + `resolveExpenseFx` 공통 헬퍼.

**Architecture:** functional core / imperative shell. fx-integration의 expenses 모듈·resolveFx·compute.ts를 확장. **새 마이그레이션 불요**(FX 컬럼·`fx_by_source` CHECK·trip_fx_defaults 기존재).

**Tech Stack:** Bun · Hono+@hono/zod-openapi(Zod v4) · Drizzle · decimal.js · vitest+testcontainers(PG16).

**설계 근거:** `docs/plans/2026-06-30-fx-extension-design.md`

**전제(검증됨):**
- `resolveFx(input: FxInput, deps: FxDeps): Promise<FxResult>`. `FxResult = FxResolved | {needsManual:true}`, `isResolved`. `FxResolved{settlement_amount(Minor), exchange_rate, exchange_rate_date, exchange_rate_source, exchange_rate_provider, exchange_rate_table_date, exchange_rate_fetched_at, fallbackWarning}`.
- `splitExpense(amount: Minor, members: readonly MemberId[]): Map<MemberId, Minor>` — `compute.ts:19`(균등분할).
- expenses: `settlement_amount_source`('converted'|'card_billed')·`fx_by_source` CHECK(`(converted AND exchange_rate NOT NULL AND exchange_rate_source NOT NULL) OR (card_billed AND exchange_rate_source NULL)`)·`exchange_rate_date` NOT NULL·`version`·FX 컬럼.
- `DrizzleTripDefaults.upsertRate(tripId, base, settlement, rate)`·`getRate(...)` 기존재. trip_fx_defaults: `fx_default_rate_pos`(rate>0)·`base_currency`/`settlement_currency` FK→currencies.
- expenses.service createExpense: assertTripOpen→exponent→resolveFx→repo.create. ExpenseSnapshot.settlement_amount_source 현재 'converted' 하드코딩·FX 컬럼 non-null. updateExpense 현재 메타+참여자만.
- money: `minor(bigint)`·`money(amount,currency)`·brand 타입.

**strict-TS:** [[trip-mate-api-strict-ts-gotchas]]·[[trip-mate-api-zod-openapi-gotchas]].

> **공통 커밋:** 새 .ts 후 `bun run fmt && bun run check`(`&&` 체인). 한국어·AI마커 금지·`<type>(<scope>): 설명`.

---

## Task 0: DTO 확장

**Files:** Modify `src/modules/expenses/expenses.schema.ts` · `expenses.schema.test.ts`

**Step 1: 실패 테스트 추가**(기존 test에)

```ts
it("card_billed: card_billed_settlement_amount 허용·manualRate와 상호배타", () => {
  expect(createExpenseSchema.safeParse({ ...validCreate(), card_billed_settlement_amount: "350000" }).success).toBe(true);
  expect(createExpenseSchema.safeParse({ ...validCreate(), card_billed_settlement_amount: "350000", manualRate: "9" }).success).toBe(false); // 상호배타
});
it("update에 FX 영향 필드(local_amount·currency·spent_at) 추가됨", () => {
  expect("local_amount" in updateExpenseSchema._def.schema?.shape || "local_amount" in updateExpenseSchema.shape).toBe(true);
});
it("preview 응답: 해결 변형 + needs_manual 변형(settlement_amount·source null) 둘 다 허용", () => {
  expect(previewResponseSchema.safeParse({ needs_manual: false, settlement_amount: "0", settlement_currency: "KRW", exchange_rate: null, exchange_rate_source: null, settlement_amount_source: "converted", fallbackWarning: false, per_member: [] }).success).toBe(true);
  expect(previewResponseSchema.safeParse({ needs_manual: true, settlement_amount: null, settlement_currency: "KRW", exchange_rate: null, exchange_rate_source: null, settlement_amount_source: null, fallbackWarning: false, per_member: [] }).success).toBe(true);
});
```
> ⚠️ updateExpenseSchema가 `.refine` 없이 순수 ZodObject면 `.shape` 직접 접근. (refine 추가 시 `_def.schema.shape`.) 구현에 맞춰 단순화.

**Step 3: 구현** — `expenses.schema.ts`

```ts
// create: card_billed 추가 + 상호배타 refine
export const createExpenseSchema = z
  .object({
    /* ...기존... */
    card_billed_settlement_amount: minorString.optional(), // 존재 시 card_billed 모드(카드 청구액=정산액)
  })
  .refine((d) => !(d.card_billed_settlement_amount !== undefined && d.manualRate !== undefined), { message: "card_billed and manualRate are mutually exclusive", path: ["card_billed_settlement_amount"] })
  .openapi("CreateExpense");

// update: FX 영향 필드 추가(편집재계산)
export const updateExpenseSchema = z
  .object({
    version: z.number().int(),
    title: z.string().min(1).max(200).optional(),
    payment_method: z.enum(PAYMENT).optional(),
    category: z.enum(CATEGORY).optional(),
    memo: z.string().max(1000).nullable().optional(),
    participant_member_ids: z.array(z.string().uuid()).min(1).refine((a) => new Set(a).size === a.length, { message: "duplicate participant" }).optional(),
    expense_settlement_state: z.enum(STATE).optional(),
    local_amount: minorString.optional(),
    local_currency: z.string().length(3).optional(),
    spent_at: z.iso.datetime().optional(),
    manualRate: z.string().regex(/^\d+(\.\d+)?$/).max(24).optional(),
    card_billed_settlement_amount: minorString.optional(),
  })
  .refine((d) => !(d.card_billed_settlement_amount !== undefined && d.manualRate !== undefined), { message: "card_billed and manualRate mutually exclusive", path: ["card_billed_settlement_amount"] })
  .openapi("UpdateExpense");

// preview 응답
// needs_manual=true면 settlement_amount·source·per_member는 미정 → nullable/빈배열(finding #1 pass1).
export const previewResponseSchema = z
  .object({
    needs_manual: z.boolean(),
    settlement_amount: z.string().regex(/^\d+$/).nullable(),
    settlement_currency: z.string(),
    exchange_rate: z.string().nullable(),
    exchange_rate_source: z.enum(["identity", "manual", "auto", "last_known", "trip_default"]).nullable(),
    settlement_amount_source: z.enum(["converted", "card_billed"]).nullable(),
    fallbackWarning: z.boolean(),
    per_member: z.array(z.object({ member_id: z.string().uuid(), share: z.string().regex(/^\d+$/) })),
  })
  .openapi("ExpensePreview");

// trip_default 설정 요청
export const fxDefaultRequestSchema = z
  .object({ base_currency: z.string().length(3), settlement_currency: z.string().length(3), rate: z.string().regex(/^\d+(\.\d+)?$/).max(24) })
  .openapi("SetTripFxDefault");

export type UpdateExpense = z.infer<typeof updateExpenseSchema>;
export type PreviewResponse = z.infer<typeof previewResponseSchema>;
```
> `createExpenseSchema`가 `.refine`로 ZodEffects가 되면 `valid("json")` 추론·`.shape`는 fx-integration 패턴 확인(refine된 createTripSchema 선례 있음). preview 요청 스키마는 createExpenseSchema 재사용(card_billed_settlement_amount 포함).

**Step 5: Commit** — `feat(expenses): card_billed·preview·편집재계산·trip_default DTO 확장`

---

## Task 1: resolveExpenseFx 추출 + card_billed create

**Files:** Modify `src/modules/expenses/expenses.service.ts` · `expenses.repo.ts`(ExpenseSnapshot) · `expenses.service.test.ts`

**Step 1: 실패 테스트**

```ts
it("card_billed: settlement_amount=입력값·source=card_billed·rate null", async () => {
  const { trip, memberId } = await setup("KRW");
  const exp = await svc().createExpense(trip, input(memberId, { local_currency: "JPY", card_billed_settlement_amount: "350000" }), { memberId });
  expect(exp.settlement_amount).toBe(350000n);
  expect(exp.settlement_amount_source).toBe("card_billed");
  expect(exp.exchange_rate_source).toBeNull();
});
```

**Step 3: 구현**
- `ExpenseSnapshot`(repo): `settlement_amount_source: "converted" | "card_billed"`; `exchange_rate: string | null`·`exchange_rate_source: ... | null`(이미 nullable 컬럼). create insert는 그대로(값이 null 허용).
- service: `resolveExpenseFx` private 추출 + createExpense card_billed 분기:

```ts
// exponent 조회 + date 파생 + resolveFx (create·preview·edit 공유)
private async resolveExpenseFx(i: { tripId: string; tz: string; settle: string; local_amount: string; local_currency: string; spent_at: string; manualRate?: string }): Promise<FxResult> {
  const cur = await this.db.select({ code: currencies.code, exp: currencies.minor_unit }).from(currencies).where(inArray(currencies.code, [i.local_currency, i.settle]));
  const expOf = new Map(cur.map((c) => [c.code, c.exp]));
  const localExp = expOf.get(i.local_currency);
  const settleExp = expOf.get(i.settle);
  if (localExp === undefined || settleExp === undefined) throw new ValidationError("unknown currency", { local: i.local_currency, settlement: i.settle });
  const fxInput: FxInput = { localMinor: minor(BigInt(i.local_amount)), localCurrency: i.local_currency as CurrencyCode, settlementCurrency: i.settle as CurrencyCode, date: localDate(i.spent_at, i.tz), localExp, settleExp, tripId: i.tripId, ...(i.manualRate !== undefined ? { manualRate: i.manualRate } : {}) };
  return resolveFx(fxInput, this.fxDeps);
}

async createExpense(tripId, input, actor) {
  const trip = await this.assertTripOpen(tripId);
  // card_billed 분기: FX 해석 우회
  if (input.card_billed_settlement_amount !== undefined) {
    return this.persist(tripId, trip, input, actor, { settlement_amount: BigInt(input.card_billed_settlement_amount), settlement_amount_source: "card_billed", exchange_rate: null, exchange_rate_source: null, exchange_rate_provider: null, exchange_rate_table_date: null, exchange_rate_fetched_at: null });
  }
  const fx = await this.resolveExpenseFx({ tripId, tz: trip.tz, settle: trip.settle, local_amount: input.local_amount, local_currency: input.local_currency, spent_at: input.spent_at, ...(input.manualRate !== undefined ? { manualRate: input.manualRate } : {}) });
  if (!isResolved(fx)) throw new FxUnresolvedError("exchange rate unresolved; provide manualRate", { tripId });
  return this.persist(tripId, trip, input, actor, { settlement_amount: fx.settlement_amount, settlement_amount_source: "converted", exchange_rate: fx.exchange_rate, exchange_rate_source: fx.exchange_rate_source, exchange_rate_provider: fx.exchange_rate_provider, exchange_rate_table_date: fx.exchange_rate_table_date, exchange_rate_fetched_at: fx.exchange_rate_fetched_at ? new Date(fx.exchange_rate_fetched_at) : null });
}
// persist: 기존 repo.create 호출부를 추출(snapshot 조립·findById). fx 부분만 파라미터로.
```
> `localDate`·`exchange_rate_date`는 card_billed도 파생(NOT NULL). card_billed의 `exchange_rate`는 null(CHECK는 source만 NULL 요구).

**Step 5: Commit** — `feat(expenses): resolveExpenseFx 추출·card_billed 생성(FX 우회 카드청구액)`

---

## Task 2: preview (미영속 미리보기)

**Files:** Modify `expenses.service.ts`(previewExpense)·`expenses.controller.ts`(라우트)·테스트

**Step 1: 실패 테스트**(controller, PG)

```ts
it("preview: identity → settlement_amount·per_member 균등분할(미영속)", async () => {
  const { u, trip, memberId } = await setup();
  const res = await appFor(u).request(`/trips/${trip}/expenses/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(memberId)) });
  expect(res.status).toBe(200);
  const p = (await res.json()) as { per_member: unknown[]; settlement_amount: string };
  expect(p.per_member.length).toBe(1);
  // GET 목록은 여전히 0개(미영속)
  expect(((await (await appFor(u).request(`/trips/${trip}/expenses`)).json()) as unknown[]).length).toBe(0);
});
it("preview: 미지/타-trip member_id → 422(멤버십 검증, finding #2 pass2)", async () => {
  const { u, trip } = await setup();
  const outsiderMemberId = "11111111-1111-4111-8111-111111111111";
  const res = await appFor(u).request(`/trips/${trip}/expenses/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(outsiderMemberId)) });
  expect(res.status).toBe(422);
});
```

**Step 3: 구현**
- service.previewExpense(tripId, input): assertTripOpen(read) → **paid_by_member_id·participant_member_ids가 해당 trip의 멤버인지 검증**(미영속이라 composite FK 미실행 → 명시 검증, finding #2 pass2): `SELECT id FROM trip_members WHERE trip_id=? AND id IN (...)` 해 입력 member_id 집합이 전부 포함되는지 → 미지/타-trip이면 422 ValidationError → card_billed 또는 resolveExpenseFx → needsManual이면 `{ settlement_currency: trip.settle, needs_manual: true, settlement_amount: null, settlement_amount_source: null, exchange_rate: null, exchange_rate_source: null, fallbackWarning: false, per_member: [] }` → 아니면 splitExpense(settlement_amount, participants)로 per_member. 영속 없음.
- controller: `POST /trips/{tripId}/expenses/preview`, middleware [auth, member](멱등 없음), body=createExpenseSchema, 응답 previewResponseSchema.

**Step 5: Commit** — `feat(expenses): 지출 preview 라우트(FX·균등분할 미영속 미리보기)`

---

## Task 3: 편집재계산 (PATCH amount/currency/date)

**Files:** Modify `expenses.repo.ts`(updateMeta→updateExpense FX 지원)·`expenses.service.ts`(updateExpense 재계산)·테스트

**Step 1: 실패 테스트**

```ts
it("편집재계산: local_amount 변경 → settlement_amount 재계산(identity)", async () => {
  const { trip, memberId } = await setup("KRW");
  const exp = await svc().createExpense(trip, input(memberId), { memberId }); // KRW identity 37900
  const updated = await svc().updateExpense(trip, exp.id, { version: 0, local_amount: "50000" }, { memberId });
  expect(updated.settlement_amount).toBe(50000n); // identity 재계산
  expect(updated.local_amount).toBe(50000n); // local 원본도 갱신(finding #1 pass3)
  expect((await svc().getExpense(trip, exp.id)).local_amount).toBe(50000n); // 재로드 정합
});
it("source 전환(card_billed→converted) 시도 → 422", async () => {
  const { trip, memberId } = await setup("KRW");
  const exp = await svc().createExpense(trip, input(memberId, { local_currency: "JPY", card_billed_settlement_amount: "350000" }), { memberId });
  await expect(svc().updateExpense(trip, exp.id, { version: 0, local_amount: "1", manualRate: "9" }, { memberId })).rejects.toMatchObject({ status: 422 });
});
it("편집재계산 미해결(JPY·manual 없음·provider 없음) → 422·구행 보존(finding #2 pass1)", async () => {
  const { trip, memberId } = await setup("KRW");
  const exp = await svc().createExpense(trip, input(memberId), { memberId }); // KRW identity 37900
  await expect(svc().updateExpense(trip, exp.id, { version: 0, local_currency: "JPY", local_amount: "1000" }, { memberId })).rejects.toMatchObject({ status: 422 });
  expect((await svc().getExpense(trip, exp.id)).settlement_amount).toBe(37900n); // 구행 보존(미변경)
});
```

**Step 3: 구현**
- repo: `updateMeta` 시그니처에 optional FX 패치 추가(또는 `updateExpense(tripId, id, version, patch, fx?, actorMemberId)`). FX 재계산 시 CAS UPDATE의 set에 **변경된 local 입력(local_amount·local_currency·spent_at)도 함께** + 파생 settlement_amount·exchange_rate·**exchange_rate_date(새 spent_at·tz로 재파생)**·exchange_rate_source·provider·table_date·fetched_at·settlement_amount_source 포함(finding #1 pass3 — local 원본과 파생액 정합). card_billed 금액수정은 settlement_amount만. before/after audit·trip FOR UPDATE·tz 재검증 유지.
- service.updateExpense: FX 영향 필드(local_amount·local_currency·spent_at·card_billed_settlement_amount·manualRate) 변경 감지. 현재행 로드(source 확인) → ① source='converted' & FX필드 변경 → resolveExpenseFx(병합값) → **`!isResolved(fx)`면 CAS 실행 전 `FxUnresolvedError`(구행 보존·422, finding #2 pass1)** → 아니면 fx 패치. ② source='card_billed' & card_billed_settlement_amount 변경 → settlement_amount만. ③ **source 전환 시도(card_billed 행에 manualRate/converted 의도, 또는 converted 행에 card_billed_settlement_amount)** → 422. ④ FX필드 미변경 → 메타 전용.

**Step 5: Commit** — `feat(expenses): 편집재계산(PATCH amount/currency/date→resolveFx·source 유지·전환 거부)`

---

## Task 4: trip_default 승격 엔드포인트

**Files:** Modify `expenses.controller.ts`(또는 신규 작은 컨트롤러)·`app.ts`/`main.ts`(tripDefaults 주입)·테스트

**Step 1: 실패 테스트**(controller)

```ts
it("PUT fx-defaults(admin) → 이후 동일 통화쌍 expense가 trip_default fallback", async () => {
  const { u, trip } = await setup(); // u=admin
  const res = await appFor(u).request(`/trips/${trip}/fx-defaults`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_currency: "JPY", settlement_currency: "KRW", rate: "9.5" }) });
  expect([200, 204]).toContain(res.status);
  // (provider 없는 svc로) JPY expense → trip_default 9.5로 해석되어 생성 성공
});
it("비-admin PUT fx-defaults → 403", async () => { /* member u2 */ });
it("fx-defaults: 0·round-to-zero·oversize rate → 422(정규화 선차단, finding #3 pass1)", async () => {
  const { u, trip } = await setup();
  for (const rate of ["0", "0.00000000001", "99999999999"]) {
    const res = await appFor(u).request(`/trips/${trip}/fx-defaults`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_currency: "JPY", settlement_currency: "KRW", rate }) });
    expect(res.status).toBe(422);
  }
});
```

**Step 3: 구현**
- registerExpenseRoutes deps에 `tripDefaults: TripDefaultsPort` 추가(또는 별도 registerFxDefaultRoutes). `PUT /trips/{tripId}/fx-defaults`, middleware [auth, admin], body fxDefaultRequestSchema.
- **rate 정규화(finding #3 pass1):** `import { parsePositiveRate, normalizeRate } from "../fx/domain/convert.ts"`. 핸들러에서 `try { const norm = normalizeRate(parsePositiveRate(rate)).toFixed(10) } catch { throw new ValidationError("invalid rate (≤0 or out of range)") }`(≤0·round-to-zero·>10^10 → 422) → `deps.tripDefaults.upsertRate(tripId, base, settlement, norm)`(정규화 10dp 영속). 응답 200 `{ok:true}`.
- app.ts/main.ts: tripDefaults 인스턴스(DrizzleTripDefaults) 주입. (expenses의 fxDeps.tripDefaults 재사용 가능 — V1Deps에 tripDefaults 추가 또는 expensesService 경유.)
- **CORS(finding #1 pass2):** buildV1App `cors({ allowMethods })`에 **`"PUT"` 추가**(현재 GET/POST/PATCH/DELETE/OPTIONS) → 브라우저 credentialed PUT preflight 허용. `src/v1-security.test.ts`에 `/v1/trips/{id}/fx-defaults` OPTIONS preflight(`Access-Control-Request-Method: PUT`, 정확 Origin) → ACAO 단언.
> ⚠️ DB `fx_default_rate_pos`(rate>0)·`numeric(20,10)` 오버플로(23514/22003)는 정규화가 선차단하나, 방어로 그 SQLSTATE도 422 매핑.

**Step 5: Commit** — `feat(expenses): trip_default 환율 설정 엔드포인트(PUT fx-defaults, admin)`

---

## Task 5: 통합·계약 테스트

**Files:** Modify `src/openapi-doc.test.ts`/expenses-doc(preview·fx-defaults 경로)·전체 스위트

**Step 1~3:** doc 테스트에 `/expenses/preview`·`/fx-defaults` 경로·`ExpensePreview`/`SetTripFxDefault` 스키마 단언. gen:openapi 무-IO 확인.

**Step 4: 전체 스위트** — `bun run test`(기존 235 + 신규, 0 실패) + `bun run check` + `bun run gen:openapi && git diff --exit-code openapi.json`(drift).
> openapi.json은 SSOT 커밋이므로 **재생성·커밋**해야 drift CI 통과.

**Step 5: Commit** — `test(expenses): FX 확장 계약·통합 테스트 + openapi.json 갱신`

---

## Definition of Done
- [ ] card_billed 생성(청구액=정산액·source=card_billed·rate null)
- [ ] preview(FX·균등분할 미영속·needsManual 구조화)
- [ ] 편집재계산(converted 재해석·card_billed 금액수정·source 전환 422·tz 재검증)
- [ ] trip_default 엔드포인트(admin)·이후 fallback 동작
- [ ] gen:openapi 갱신·drift 없음·전체 스위트 0 실패

## Out of scope (후속)
card_billed↔converted source 전환 · 환불(음수) · 커서 페이지네이션.

---

## Adversarial review dispositions

Codex 적대적 리뷰(working-tree 모드) **3 passes(cap)**. **총 6건 finding 전부 Accept(전부 계획 반영).** high 추세 2→2→1(med 1·2·0), 매 pass 다른 영역(미해결 FX 응답/rate 정규화 → CORS/신뢰경계 → local 정합)으로 수렴. cap 3패스 후 **사용자 결정으로 확정**(미해결 없음). 확정 후 감사추적이며 재리뷰 대상 아님.

| pass | # | finding | sev | 결정 | 반영 |
|---|---|---|---|---|---|
| 1 | 1 | preview needs_manual이 스키마 불충족 | high | Accept | settlement_amount·source nullable·needs_manual 변형 테스트 |
| 1 | 2 | PATCH 재계산에 unresolved-FX no-write 없음 | high | Accept | !isResolved → CAS 전 422·구행 보존 테스트 |
| 1 | 3 | fx-defaults rate 정규화 없이 raw upsert | med | Accept | parsePositiveRate/normalizeRate 10dp·422·tiny/oversize 테스트 |
| 2 | 1 | PUT fx-defaults가 CORS preflight 차단 | med | Accept | allowMethods PUT·preflight 테스트 |
| 2 | 2 | preview 멤버십 검증 누락(false 200) | med | Accept | trip_members 검증·outsider 422 테스트 |
| 3 | 1 | PATCH가 local 필드 미영속(파생만) | high | Accept | CAS set에 local_amount/currency/spent_at·재파생 date·재로드 단언 |

**최종 pass3 `summary`:** "edit-recalculation can persist a recalculated settlement against stale local expense fields." → CAS set에 local 입력 포함으로 해소.

---

## Execution directives
- **Skill:** `executing-plans`로 **이 워크트리**(`~/workspace/trip-mate-api/.worktrees/fx-extension`, 브랜치 `feat/fx-extension`)에서 Task 0→5 구현.
- **연속 실행:** 진짜 블로커에서만 정지. Docker 필요(testcontainers PG16). expenses 모듈·resolveFx·compute.ts·trip-defaults는 기존재 — 확장만. **fx domain `parsePositiveRate`/`normalizeRate` 시그니처·createExpenseSchema refine 후 valid 추론·drizzle CAS set은 설치 타입/런타임 확인**하되 의미(card_billed FX 우회·preview 미영속+멤버검증·편집재계산 local 정합·rate 정규화·CORS PUT)는 고정. strict-TS는 [[trip-mate-api-strict-ts-gotchas]]·[[trip-mate-api-zod-openapi-gotchas]] 참조.
- **커밋 — 직접 적용, `Skill(commit)` 금지:** 한국어·**AI 마커 금지**·`<type>(<scope>): 설명`·type은 `feat`/`fix`/`refactor`/`docs`/`style`/`test`/`chore`만. 각 Task Commit 스텝에서 `feat/fx-extension` 워크트리에 직접. 새 .ts 후 `bun run fmt && bun run check`(`&&` 체인).
- **openapi.json:** SSOT 커밋이므로 라우트 추가 후 **`bun run gen:openapi` 재생성·커밋**(drift CI 통과). Task 5에서.
- **시작점:** Task 0(DTO)→5. SSOT 충돌 시 `api-contract-design` > 본 plan > `fx-extension-design` > `architecture` > PRD.
