# trip-mate 코드 아키텍처 (architecture.md)

## 0. 문서 정보

| 항목 | 내용 |
|---|---|
| 문서명 | trip-mate 프론트엔드·백엔드 코드 아키텍처 |
| 버전 | v1.2 (DB 설계 hardening 반영: same-trip composite FK·동시성 lock·통화/스냅샷 정규화) |
| 작성일 | 2026-06-25 |
| 관련 문서 | `trip-mate-prd.md`(PRD v1.5) · `tech-stack.md`(v1.1) · `design.md`(v1.2) · `docs/plans/2026-06-25-trip-mate-db-design.md`(DB 스키마 SSOT) |
| 범위 | 폴리레포(2 앱 레포)·계약 사슬·BE 모듈/DI/데이터/인가/에러·FE FSD/라우팅/상태 |

이 문서는 "코드를 어떻게 조직하나"를 정의한다. tech-stack(무엇으로)·design(어떻게 보이나)에 이은 구현 청사진이며, 앱 레포(`ukyi-app/trip-mate-api`·`ukyi-app/trip-mate-web`, 2 앱 레포 §2) 스캐폴딩의 기준이다.

---

## 1. 아키텍처 원칙

1. **계약이 단일 진실원(SSOT)** — Zod 스키마 하나가 검증·OpenAPI·FE 타입·쿼리 훅까지 파생한다.
2. **마법 최소** — 데코레이터·reflect-metadata·런타임 DI 컨테이너 없이, 명시적·타입추론 우선.
3. **순수한 돈** — 정산 계산은 IO 없는 순수 함수(BigInt 정수), 결정적·단위테스트 가능 (PRD §18).
4. **경량** — Bun + Hono + Drizzle. 메모리 원장 ≤9216Mi·arm64 제약 준수.
5. **FE/BE 분리** — 코드 비공유, OpenAPI 스펙 아티팩트로만 연결.
6. **응집 우선(Pages-First)** — FSD v2.1, 재사용이 실제로 생길 때만 하위 레이어로 추출.

---

## 2. 저장소 구조 (폴리레포 — 2 앱 레포)

홈랩 App Platform은 **"1 앱 레포 = 1 이미지 = 1 워크로드"**다(`.app-config.yml`의 `kind` 단수, `reusable-app-build.yaml`이 레포당 이미지 1개 빌드). 따라서 FE/BE를 **별도 앱 레포**로 둔다. 계약을 OpenAPI 스펙 아티팩트로 잡아 **FE가 BE 코드를 import하지 않으므로** 분리해도 타입안전 손실이 없다.

```
ukyi-app/trip-mate-api/      # kind: service (Bun + Hono)
├─ .app-config.yml           # kind: service · db · redis · route · migrate
├─ Dockerfile                # arm64, 단일 이미지
├─ openapi.json              # gen:openapi 산출 → R2 publish
├─ tsconfig.json             # ⚠️ 데코레이터 플래그 OFF, ES2022 (extends 함정 회피 위해 직접 설정)
└─ src/ …

ukyi-app/trip-mate-web/      # kind: static (Vite 정적, static.server: sws)
├─ .app-config.yml           # kind: static · route(public)
├─ Dockerfile                # arm64, 정적 빌드
├─ tsconfig.json
└─ src/ …
```

- **계약은 코드 공유가 아니라 OpenAPI 스펙 아티팩트**: api가 `openapi.json` 생성 → web이 Hey API로 코드젠. web은 api 코드를 import하지 않는다.
- 홈랩 배포: 각 레포 → GHCR 이미지 1개 → `apps/trip-mate-api/deploy/prod`(service)·`apps/trip-mate-web/deploy/prod`(static) 온보딩.
- 로컬 개발: 두 레포를 각각 클론. web은 `.env`의 API URL로 api를 가리킨다(개발은 로컬 api 또는 dev 배포).

---

## 3. 계약 사슬 (Contract Chain)

```
Drizzle 스키마
  ─ drizzle-zod →     Zod(v4) 스키마
     ─ @hono/zod-openapi → OpenAPI 스펙 (+ 런타임 검증 + Swagger)
        ─ Hey API →    FE TS 타입 + Fetch SDK + TanStack Query 훅 (+ 선택 Zod 응답검증)
```

빌드/CI (2 레포, R2로 스펙 동기화):
```
trip-mate-api:  bun run gen:openapi → openapi.json → R2 publish (스펙 버전 핀)
trip-mate-web:  bun run gen:api     → R2의 openapi.json 소비 → src/shared/api (Hey API)
CI:             web 코드젠을 핀된 스펙으로 재실행 → 커밋된 src/shared/api와 다르면 실패(drift). 키/소스 규칙 tech-stack §8.1
```

⚠️ **Zod v4 정합 필수**: `@hono/zod-openapi` v1.x는 Zod v4 전용. `drizzle-zod`·Hey API도 Zod v4 경로로 맞춘다. `OpenAPIHono`에서는 bare `get/post` 대신 **`openapi()` 메서드**를 사용한다(타입 함정 회피).

**DTO 노출 경계(과노출 차단):** `drizzle-zod` 결과는 출발점일 뿐 와이어 DTO가 아니다. 라우트별로 `createSelectSchema/createInsertSchema`를 `pick/omit/extend/refine`해 **(a) public 응답 · (b) create/update 입력 · (c) 내부 도메인** 3종으로 분리하고, `version`·`input_source`·`*_audit_logs`·`google_account_id` 등 내부/감사 컬럼은 응답·입력에서 omit한다.

---

## 4. 백엔드 아키텍처 (trip-mate-api)

### 4.1 레이어 & 모듈 (도메인 수직 슬라이스)

```
trip-mate-api/src/
├─ core/
│  ├─ composition.ts     # createCore(): { db, logger, config }
│  ├─ config.ts          # Zod 검증 env
│  ├─ errors.ts          # 도메인 에러 + onError (ExceptionFilter)
│  ├─ guards.ts          # requireAuth · requireTripMember (Guards = 미들웨어)
│  └─ openapi.ts         # OpenAPIHono 인스턴스 + doc
├─ modules/
│  ├─ trips/        { trips.module · trips.controller · trips.service · trips.repo · trips.schema }
│  ├─ members/      …
│  ├─ expenses/     …
│  ├─ settlements/  ( + domain/compute.ts 순수 정산엔진 §18 )
│  └─ auth/         ( Better Auth 배선 )
├─ db/              { schema/ · migrations/ · client.ts }
└─ main.ts          # 컴포지션 루트(AppModule) + Bun serve
```

레이어 방향: **controller(route) → service(use-case·트랜잭션) → repo(Drizzle) → domain(순수)**. 모듈은 자기 도메인 schema 슬라이스만 의존.

NestJS 개념 매핑: `@Module`→`*.module.ts`(팩토리 함수) · `@Injectable`→서비스/repo 클래스 · `@Controller`→`register(app)` 클래스 · Guard→미들웨어 · Pipe/DTO→Zod(zod-openapi) · ExceptionFilter→onError · ConfigModule→`core/config.ts`.

### 4.2 의존성 주입 — 수동 컴포지션 루트 (DI 라이브러리 없음)

> **결정 근거(리서치+적대 검증):** typed-inject(토큰↔생성자 중복)·awilix(Cradle 수동유지·약한 타입)·tsyringe/HonestJS·needle-di를 검토. needle-di는 Stage3 데코레이터를 쓰는데 **Bun 표준 데코레이터에 미해결 크리티컬 버그**([bun#28010 상속 초기화 오매핑](https://github.com/oven-sh/bun/issues/28010)·[#30326 _init 공유](https://github.com/oven-sh/bun/issues/30326), 둘 다 OPEN)가 있어 레이어드+데코레이터 구조를 직격. 레거시 메타데이터 경로도 [#6326(extends 누락)](https://github.com/oven-sh/bun/issues/6326)·#27526 함정. → **데코레이터·메타데이터·컨테이너를 전부 배제**하고 수동 `new` 컴포지션이 6축(NestJS 구조·중복없는 DX·Bun안전·타입안전·계약사슬·프로덕션신뢰)을 동시에 충족.

```ts
// expenses.service.ts — @Injectable 대응. 의존성 = 생성자 1곳(중복 0, 토큰 0, 데코 0).
export class ExpenseService {
  constructor(
    private readonly db: DB,
    private readonly repo: ExpenseRepo,
    private readonly logger: Logger,
  ) {}
  async create(actor: Membership, dto: CreateExpenseDto) { /* 권한 §9.3 · tx · … */ }
}

// expenses.module.ts — @Module 대응. providers = new() 몇 줄.
export function createExpensesModule(core: Core) {
  const expenseRepo = new DrizzleExpenseRepo(core.db)        // 포트(ExpenseRepo) ← Drizzle 어댑터(§10.2)
  const expenseService = new ExpenseService(core.db, expenseRepo, core.logger)
  return {
    exports: { expenseRepo, expenseService },          // 다른 모듈이 쓸 것(=@Module exports)
    controllers: [new ExpenseController(expenseService)],
  }
}

// main.ts — AppModule. 의존 순서로 합성.
const core = createCore()
const expenses = createExpensesModule(core)
const settlements = createSettlementsModule(core, expenses.exports)   // 크로스모듈 의존 명시
const app = createApp()                                              // OpenAPIHono
;[expenses, settlements, /* … */].flatMap(m => m.controllers).forEach(c => c.register(app))
registerErrorFilter(app)
export default { port: 3000, fetch: app.fetch }                      // Bun serve
```

- **tsconfig:** `experimentalDecorators`·`emitDecoratorMetadata` **OFF**, `target ES2022`.
- **테스트:** `new ExpenseService(fakeDb, new InMemoryExpenseRepo(), logger)` — 컨테이너 없이 한 줄.

### 4.3 데이터 계층 (Drizzle, 도메인별 schema + relations)

```
db/schema/
├─ enums.ts        # pgEnum: role·member_status·settlement_status·snapshot_status·payment_status·expense_settlement_state·
│                  #         settlement_amount_source·exchange_rate_source·basis  (input_source·category·payment_method = text+CHECK)
├─ currencies.ts   # §48 룩업(code PK·minor_unit·symbol), 모든 *_currency가 FK 참조
├─ auth-schema.ts(Better Auth: user·account·session·verification) · trips.ts(+timezone) · members.ts
├─ expenses.ts     # expenses(+version,+deleted_at) · expense_participants(조인) · expense_audit_logs
├─ settlements.ts  # settlements · settlement_transfers · settlement_member_summaries · settlement_currency_totals
├─ relations.ts    # drizzle relations 중앙화
└─ index.ts
```

- 금액: `bigint(mode:'bigint')` 최소단위 정수(§18·§48) / 환율: `numeric(18,6)`(금액 아님) / PK: `uuid().defaultRandom()`(§34.4).
- repo는 클래스, 메서드는 트랜잭션 핸들(`tx`)을 인자로 받는다.
- `modules/*/*.schema`는 테이블→Zod 원본이 아니라 **라우트 DTO(응답/입력)**를 export하며, 테이블 전체 컬럼을 그대로 노출하지 않는다(§3 DTO 노출 경계).
- **same-trip 무결성:** 멤버/지출 참조는 단일 FK 대신 **composite FK** `(trip_id, *)→trip_members/expenses/settlements(trip_id, id)`로 cross-trip 참조를 DB가 차단. soft delete는 `deleted_at` + 부분 인덱스(`WHERE deleted_at IS NULL`).
- 상세 스키마·제약·인덱스·동시성은 **`docs/plans/2026-06-25-trip-mate-db-design.md`** 가 SSOT(Codex 적대적 리뷰 5-pass hardening 완료).

### 4.4 인가 (혼합 — defense in depth)

| 작업 | 미들웨어(coarse) | 서비스 가드(fine) |
|---|---|---|
| 여행방 조회 | requireAuth + requireTripMember | — |
| 지출 추가 | requireAuth + requireTripMember | — |
| 지출 수정/삭제 | requireAuth + requireTripMember | **작성자 \|\| 결제당사자 \|\| 어드민** (§9.3) |
| 정산 확정/잠금해제 | requireTripMember('admin') | 어드민 재확인 + 마지막 어드민 가드(§9.5) |
| 멤버 초대/비활성화 | requireTripMember('admin') | — |

미들웨어가 1차(인증·멤버십·role), service가 2차(리소스 소유·도메인 불변식). 위반은 `ForbiddenError` throw → onError.

### 4.5 에러 모델 (타입드 도메인 에러 + 중앙 onError)

```ts
AppError(code, status, meta)
 ├ NotFoundError(404) · ForbiddenError(403)
 ├ ConflictError(409)            // 낙관적 잠금 충돌·중복지출 (§31.6)
 ├ ValidationError(422)
 └ SettlementInvariantError      // Σ≠0 등 정산 불변식(§18.2.2) → 저장 차단
// app.onError → RFC 9457 problem+json { type,title,status,code,detail } + logger
// zod-openapi 검증 실패는 자동 422 / 도메인 에러만 onError 매핑 → OpenAPI 에러 스키마 → FE 타입
```

### 4.6 정산 확정 트랜잭션 흐름 (§31.6)

```ts
// SettlementService.finalize — 단일 트랜잭션 + 낙관적 잠금
async finalize(tripId: string, actor: Membership, seenVersions: Map<ExpenseId, number>) {
  assertAdmin(actor)                                          // §9.2  · seenVersions=확정 화면이 읽은 expense version 집합
  return this.db.transaction(async (tx) => {
    await this.tripRepo.assertSettlementOpen(tripId, tx)             // ① settlement_status=open CAS 가드
    const expenses = await this.expenseRepo.listForTripForUpdate(tripId, tx) // ② 포함 expenses row lock(SELECT … FOR UPDATE)
    assertNoVersionDrift(expenses, seenVersions)                     //    확정 화면이 읽은 version과 불일치 시 ConflictError(§31.6)
    const result = computeSettlement(expenses)                       // ③ 순수 BigInt(§18)
    if (result.imbalance !== 0n) throw new SettlementInvariantError() // §18.2.2
    const snap = await this.settlementRepo.saveSnapshot(result, tx)   // ④ 같은 tx에서 스냅샷 저장
    await this.tripRepo.setStatus(tripId, 'finalized', tx)           // ⑤ finalized 전환
    return snap                                               // 결정적 → 재현 가능(§31)
  })
}
```
- **동시성(§31.6, DB설계 §7):** finalize는 **trip row 원자 CAS-lock**(`UPDATE … WHERE settlement_status='open' RETURNING`)으로 직렬화 → 포함 expenses `FOR UPDATE` + 참여자 read + `version` 재검증(불일치 시 `ConflictError`) → 같은 tx에 스냅샷 저장. **지출·참여자 write path도 같은 trip row를 `FOR UPDATE`로 공유 잠금**한 뒤 `open` 확인(snapshot 밖 insert race 차단). 참여자 변경은 부모 `expenses.version`을 bump. 송금 완료 표시는 `active`+`finalized` 검증 + 같은 lock, actor=수취인/어드민(§4.4).
- **요청 스코프:** 트랜잭션은 서비스 메서드 내부에서 열고 `tx`를 repo에 명시 전달. 요청별 user/membership은 Hono `c.var`(미들웨어 set). → 요청 스코프 컨테이너 불필요.

### 4.7 인증 (Better Auth)

- Google OAuth, 쿠키 세션. `modules/auth`에 배선.
- 전역 식별자 `google_account_id`, email은 join 매칭 전용(§7.3). 정규화 §8.5.
- FE는 Hey API 클라이언트 `credentials:'include'`로 세션 전송.
- **쿠키/CORS/CSRF:** 세션 쿠키 `HttpOnly`+`Secure`+`SameSite`, 교차 서브도메인은 `Domain=.ukyi.app` + Better Auth `trustedOrigins`. CORS는 web origin 명시 allowlist(+`Allow-Credentials`, 와일드카드 금지), 상태변경 요청은 CSRF 방어. 설정값은 `core/config.ts`(개발 localhost/운영 도메인 분리)와 auth module 책임 (PRD §34.4 · tech-stack §5.2).
- Google `email_verified=true` 이메일만 초대 매칭에 사용. 초대 토큰은 무작위·DB 해시 저장·만료·재발송/취소 시 폐기, 권한이 아닌 안내용 포인터(§8.3).

### 4.8 설정/검증

- env는 `core/config.ts`에서 **Zod로 검증**(누락·타입 오류 시 부팅 실패). 시크릿은 SealedSecret 주입(§tech-stack §8).

---

## 5. 프론트엔드 아키텍처 (trip-mate-web)

### 5.1 FSD v2.1 (Pages-First, 느슨 적용)

```
trip-mate-web/src/
├─ app/        # Providers(QueryClient·Router·LazyMotion·Toast·BaseUI), 토큰/글로벌 CSS, View Transitions
├─ routes/     # TanStack Router 파일기반(얇은 어댑터) → pages import
├─ pages/      # FSD 페이지 슬라이스(ui/model/api): trip-list·trip-home·expense-add·settlement·…
├─ widgets/    # expense-list · settlement-summary · trip-header · bottom-nav
├─ features/   # add-expense · invite-member · finalize-settlement · mark-transfer-paid · auth (재사용 시 추출)
├─ entities/   # trip · member · expense · settlement · user (도메인 모델)
└─ shared/
   ├─ ui/      # 디자인 시스템(Base UI+CVA): Button·NumberInput·Sheet·AmountDisplay·CircleFlag … (→ design.md)
   ├─ api/     # Hey API 생성물 + base(auth·에러매핑)
   ├─ lib/     # 통화/날짜 포맷(§44/§48)·motion 프리셋·reduced-motion
   └─ config/  # env·route 상수·queryKeys
```

원칙: 페이지 전용 폼/상태/페치는 `pages/`에 둔다. **엔티티 4종(trip·member·expense·settlement)+user만 선추출**(cross-page 재사용 확실). features는 재사용이 실제로 생길 때.

- **FSD는 느슨하게 적용** — 레이어는 조직 가이드일 뿐 강제 규칙이 아니다. 슬라이스 격리/cross-import도 실용 우선.
- **느슨하되 최소 경계 4종은 유지**(코드리뷰 → 추후 lint): ① `shared`는 상위 레이어 import 금지(단방향), ② `entities`는 `features/widgets/pages` import 금지, ③ `pages` 간 직접 import 금지(공유 필요 시 `widgets/features/entities`로 하향), ④ 서버 API 호출은 `entities/*/api` 또는 page-local(§5.3)로 한정.
- **배럴(index.ts) 미사용** — 슬라이스 public API 대신 **대상 파일을 직접 import**한다(레이어별 path alias `@/shared`·`@/entities`…). 빌드/IDE 성능·tree-shaking 이점. 그래서 FSD 강제 린터(steiger)는 쓰지 않는다(§10.6).

### 5.2 라우팅 (TanStack Router 파일기반 ↔ FSD pages)

```ts
// routes/trips/$tripId/index.tsx — 얇은 어댑터(경로·loader·코드스플릿)
export const Route = createFileRoute('/trips/$tripId/')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(tripQuery(params.tripId)),
  component: TripHomePage,                                   // @/pages/trip-home
})
```
- `routes/`=라우트 정의(생성물 `routeTree.gen.ts`), `app/`=Router+Providers, `pages/`=FSD 슬라이스.
- `__root.tsx`에 셸(AppBar/BottomNav/Outlet) — design §6.3 "셸 고정·콘텐츠만 슬라이드"의 자리.

### 5.3 상태 & 데이터

- **서버 상태 = TanStack Query**(엔티티 `api/`에 query 훅, Hey API 클라이언트 사용). 낙관적 업데이트.
- 그 외 = **URL + 로컬 state 우선**. 전역 UI(시트/토스트)만 필요 시 경량 store.
- 로더에서 `ensureQueryData` 프리페치 → 화면 전환 시 깜빡임 최소.

### 5.4 컴포지션 패턴

- **boolean prop 남발 금지** → compound components + context.
- `<TripProvider>`가 현재 여행방·멤버를 context로 내려 prop drilling 제거.
- `AmountDisplay`는 데이터 주도(받을/보낼 자동, design §8), `ExpenseForm`/`SettlementTabs`는 compound.

### 5.5 디자인 시스템 · base 컴포넌트 레이어

- UI 토큰·컴포넌트·모션은 **`design.md`** 가 SSOT. 모션은 design §6(View Transitions·Motion·제스처).
- **base 컴포넌트 레이어**: `shared/ui/`에 Base UI 동작 + Tailwind v4 토큰을 CVA로 감싼 프리미티브(button·input·number-input·dialog·sheet·select·switch·tabs·toast·card·badge·avatar·amount-display·circle-flag…)를 둔다. **상위(entities/features/widgets/pages)는 base 컴포넌트를 조합만** 하고 프리미티브를 재구현하지 않는다.
- 작성 규약은 §10.7.

---

## 6. 횡단 관심사

| 영역 | 방식 |
|---|---|
| **테스트** | Vitest: 정산엔진 단위(§35.4 합계오차=0)·서비스(`new`+mock) / 통합: 테스트 Postgres / E2E: Playwright(web) |
| **로깅** | pino → stdout → Vector → VictoriaLogs (구조화) |
| **마이그레이션** | drizzle-kit generate/migrate. 배포 시 job/init에서 실행 |
| **관측성** | VictoriaMetrics/Logs + Grafana + Alertmanager (tech-stack §6) |
| **레이트리밋/캐시** | Valkey (환율·AI 호출·세션, §22.4) |

---

## 7. 배포 (홈랩 App Platform)

**2 앱 레포**(`trip-mate-api`=service[Hono + BullMQ 인-프로세스 워커], `trip-mate-web`=static) → 각각 arm64 GHCR → `apps/trip-mate-api/deploy/prod`·`apps/trip-mate-web/deploy/prod` 온보딩. api만 `create-database`·`create-cache`. 계약은 R2의 openapi.json. 상세 tech-stack §8.

---

## 8. 핵심 결정 기록 (ADR)

| 결정 | 선택 | 기각/사유 |
|---|---|---|
| FE 구조 | FSD v2.1 Pages-First | 조기 추출 회피 |
| FE 라우팅 | TanStack Router 파일기반(→pages) | 코드기반 |
| FE 상태 | TanStack Query + URL/로컬 | 전역 store 최소 |
| BE 구조 | Hono 도메인 수직 모듈(NestJS식) | 프레임워크(HonestJS pre-1.0) 미도입 |
| **BE DI** | **수동 컴포지션 루트(라이브러리 0)** | typed-inject(중복)·awilix(타입약함)·tsyringe/needle-di(**Bun 데코레이터 버그 #28010/#30326**) 전부 기각 |
| BE 데이터 | Drizzle 도메인별 schema+relations·bigint | — |
| BE 인가 | 혼합(미들웨어+서비스 가드) | — |
| BE 에러 | 타입드 도메인 에러 + onError(problem+json) | — |
| 계약 | OpenAPI 스펙 아티팩트(Zod v4) | Zod 패키지 공유(결합) |
| 저장소 | **폴리레포(2 앱 레포)** | 모노레포 — 홈랩 "1레포=1이미지"(kind 단수)와 충돌 |
| Repo 추상화 | 포트(interface)+Drizzle 어댑터 | 구체 클래스 — DIP·테스트·교체성 |
| 도메인 타입 | 브랜디드 타입/Money VO | 평이한 타입 — 통화·단위·id 혼동 차단 |
| 린트/포맷 | oxlint + oxfmt | Biome·ESLint+Prettier |
| FE 모듈 경계 | **배럴(index.ts) 미사용**, 직접 파일 import | 배럴(빌드/IDE 성능·tree-shaking 위해 배제) |
| FE 아키텍처 | **FSD 느슨 적용**(레이어=가이드, 단방향 import 최소경계는 리뷰로 유지 §5.1), steiger 미사용 | FSD 엄격·steiger(배럴/public API 강제와 충돌) |
| FE 컴포넌트 | base 컴포넌트 레이어(Base UI+CVA) + 상위 조합 | — |

---

## 9. PRD/design 추적

| 요구 | 구현 |
|---|---|
| 정수 정산·불변식 (§18·§48) | 순수 BigInt 엔진 + bigint 컬럼 + SettlementInvariantError |
| 정산 스냅샷·확정 (§31) | 단일 tx + settlements/transfers/summaries + 낙관적 잠금(version) |
| 식별·인가 (§7~§11) | Better Auth + 혼합 authz |
| 환율 4단계·캐싱 (§14) | 환율 API + Valkey + exchange_rate 동결 |
| 입력 검증 (§45) | Zod(@hono/zod-openapi) |
| 오류·빈상태 (§34.5) | onError(BE) + 전역 상태(FE) |
| 앱-필 모션 (design §6) | View Transitions + Motion + 제스처 (FE) |
| 컴플라이언스·보존 (§42·§43) | SealedSecrets·이미지 보존/삭제·접근통제·익명화 |

---

## 10. 코딩 컨벤션

### 10.1 SOLID 적용

| 원칙 | 적용 |
|---|---|
| SRP | Controller=HTTP 매핑만 · Service=유스케이스 1개 · Repo=데이터접근만 · Domain=순수계산. god 서비스 금지 |
| OCP | 입력방식(직접/AI/카드/영수증)·환율 출처를 strategy로 → 새 소스 추가 시 기존 미수정 |
| LSP | Repo 구현(Drizzle ↔ in-memory) 교체 가능 |
| ISP | aggregate별 작은 repo(ExpenseRepo·SettlementRepo…), god repo 금지 |
| DIP | service는 repo 인터페이스(포트)에 의존, Drizzle 어댑터 주입 |

### 10.2 Repository — 포트 + 어댑터 (DIP)

```ts
// expense.repo.ts — 포트
export interface ExpenseRepo {
  listForTrip(tripId: TripId, tx?: Txn): Promise<Expense[]>
  insert(e: NewExpense, tx: Txn): Promise<Expense>
}
// expense.repo.drizzle.ts — 어댑터 / expense.repo.memory.ts — 테스트 더블(InMemoryExpenseRepo)
export class DrizzleExpenseRepo implements ExpenseRepo {
  constructor(private readonly db: DB) {}
  listForTrip(tripId: TripId, tx: Txn = this.db) { /* … */ }
}
// service는 포트에 의존, 인자 순서는 (db, repo, logger)로 §4.2와 통일.
//   배선:   new ExpenseService(db, new DrizzleExpenseRepo(db), logger)
//   테스트: new ExpenseService(fakeDb, new InMemoryExpenseRepo(), logger)
```

### 10.3 도메인 타입 — 브랜디드 타입 / Money VO

```ts
type Brand<T, B> = T & { readonly __brand: B }
export type TripId = Brand<string, 'TripId'>
export type MemberId = Brand<string, 'MemberId'>
export type CurrencyCode = Brand<string, 'CurrencyCode'>   // ISO 4217, 검증 후 brand
export type Minor = Brand<bigint, 'Minor'>                  // 통화 최소단위 정수(§18·§48)
export interface Money { readonly amount: Minor; readonly currency: CurrencyCode }
export const add = (a: Money, b: Money): Money => {         // 같은 통화만 합산
  if (a.currency !== b.currency) throw new SettlementInvariantError()
  return { amount: (a.amount + b.amount) as Minor, currency: a.currency }
}
```
- 통화·단위·엔티티 id 혼동을 컴파일러가 차단. 정산 엔진은 Money/Minor로 동작.
- **Parse-don't-validate**: 경계에서 Zod로 파싱 후 brand → 내부는 신뢰 타입.

### 10.4 백엔드 패턴

- **Functional core / imperative shell** — 순수 도메인(정산·분배·환산) + IO는 가장자리(repo/api).
- **Use-case service** — 메서드=유스케이스, repo+domain+tx 오케스트레이션.
- **Strategy** — 입력 파서, 환율 4단계 체인(§14.3).
- **Typed errors + onError** (§4.5).

### 10.5 프론트엔드 패턴

- **Hooks-first** — 로직은 커스텀 훅(TanStack Query), 컴포넌트는 렌더 위주.
- **Compound + context** — boolean prop 남발 지양. 다형성은 Base UI `render` prop.
- **배럴(index.ts) 미사용** — 대상 파일 직접 import(§5.1). FSD는 느슨 적용.
- **서버상태는 TanStack Query만** — 로컬 state 복제 금지.
- **base 컴포넌트 조합** — shared/ui 프리미티브를 조합, 재구현 금지(§5.5·§10.7).

### 10.6 공통 TS & 툴체인

- tsconfig: `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax` + `moduleResolution: bundler` + `allowImportingTsExtensions` + `noEmit`. (데코레이터 플래그 OFF — §4.2)
- 불변성: `readonly`/`const` 우선, 순수 함수 선호.
- **파일·디렉토리명 kebab-case 강제 (양쪽)** — 이름은 kebab(`payment-method`·`trip-home`), 역할 suffix는 dot(`.controller`·`.service`·`.repo`·`.repo.drizzle`·`.schema`). 컴포넌트 `amount-display.tsx`. oxlint `filename-case`(kebab, dot-suffix 허용)로 강제, 디렉토리는 컨벤션+리뷰.
- **배럴(index.ts) 미사용** — 직접 파일 import. 레이어별 path alias로 경로 관리.
- **import 확장자 필수** — 상대·alias 모두 `.ts`/`.tsx` 명시(`@/shared/ui/button.tsx`). `allowImportingTsExtensions`+`noEmit`로 동작(Bun 실행·Vite 번들 OK). 패키지 import은 예외. 생성물(`*.gen.ts`·`shared/api/**`)은 규칙에서 제외. (본 문서의 다른 스니펫은 간결성을 위해 확장자 생략.)
- **린트/포맷: oxlint + oxfmt** (두 레포). ⚠️ oxfmt는 oxlint보다 신생 → 버전 핀, 필요시 Prettier 폴백.
- **steiger는 쓰지 않는다** — FSD 엄격(배럴·public API 강제)을 검사해 우리 "배럴 X·느슨 FSD"와 충돌. FSD 레이어는 코드리뷰/관례로 유지.
- CI: `oxlint` + `oxfmt --check` + `tsc --noEmit`.

### 10.7 컴포넌트 작성 규약 (FE)

- **1 컴포넌트 = 1 파일**(kebab), 그 파일을 직접 import(배럴 X). `@/shared/ui/button` = `button.tsx`.
- **변형은 CVA**(base + variants + size + defaultVariants), 클래스 병합 `cn()`(twMerge+clsx).
- **모든 base 컴포넌트는 Base UI `render` prop 지원(필수)** — Base UI 프리미티브 래핑은 `render` 포워딩, 커스텀(button 등)은 Base UI **`useRender`** 훅으로 동일 API 구현. asChild/Slot 대신 다형성·합성 일원화. `ref`는 useRender가 병합(forwardRef 불필요).
- **base 컴포넌트**(shared/ui)는 Base UI 동작 + Tailwind v4 `@theme` 시맨틱 토큰으로 스타일. 상위는 조합만.
- **boolean prop 남발 금지** → 명시적 variant + compound + context.
- 시맨틱 토큰만(`bg-brand`·`text-send`…), 하드코딩 색·arbitrary 값 금지.
- 로직은 훅(TanStack Query), 컴포넌트는 렌더 위주. a11y는 Base UI + focus ring.
- **내부 스크롤 컨테이너는 Base UI `ScrollArea`** (`shared/ui/scroll-area`) — 시트·다이얼로그·패널 내부 스크롤에 적용. ⚠️ 루트 모바일 뷰포트와 **홈/지출목록 등 PTR·가상화 대상 주 스크롤은 네이티브 유지**(momentum·pull-to-refresh, react-simple-pull-to-refresh + @tanstack/react-virtual 호환, design §6.4).

```tsx
// shared/ui/button.tsx — base 컴포넌트 (배럴 없음, Base UI render prop via useRender)
import { useRender } from '@base-ui-components/react/use-render'   // 패키지: 확장자 없음
import { mergeProps } from '@base-ui-components/react/merge-props'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/shared/lib/cn.ts'                            // 우리 파일: 확장자 필수

const button = cva('inline-flex items-center justify-center rounded-lg font-medium transition-colors ' +
  'focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:opacity-50', {
  variants: {
    intent: { primary: 'bg-brand text-white hover:bg-brand-hover', secondary: 'bg-surface-2 text-text',
              ghost: 'hover:bg-surface-2', destructive: 'bg-send text-white' },
    size: { sm: 'h-9 px-3 text-sm', md: 'h-11 px-4', lg: 'h-12 px-6 text-lg' },
    block: { true: 'w-full' },
  },
  defaultVariants: { intent: 'primary', size: 'md' },
})

// useRender.ComponentProps<'button'> = render + button 네이티브 props + ref
type ButtonProps = useRender.ComponentProps<'button'> & VariantProps<typeof button>

export function Button({ className, intent, size, block, render, ref, ...props }: ButtonProps) {
  return useRender({
    render: render ?? <button />,                                  // consumer가 render로 엘리먼트 교체
    ref,
    props: mergeProps<'button'>({ className: cn(button({ intent, size, block }), className) }, props),
  })
}
// 사용: <Button render={<a href="/x" />}>링크 버튼</Button>   // 동작·스타일 유지, 엘리먼트만 교체
```
> 정확한 `useRender`/`mergeProps` 시그니처·import 경로는 Base UI 설치 버전에 맞춰 확인(API가 버전별 미세 차이 가능).
