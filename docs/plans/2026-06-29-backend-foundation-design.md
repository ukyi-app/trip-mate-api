# trip-mate 백엔드 기반 슬라이스 구현 설계

- 작성일: 2026-06-29
- 대상: 신규 `trip-mate-api` 레포 — 구현 착수 첫 슬라이스
- 기반: `docs/trip-mate-prd.md`(PRD v1.5) · `docs/architecture.md`(v1.2) · `docs/tech-stack.md`(v1.1) · `docs/design.md`(v1.3) · plans 5종(DB·정산엔진·FX·API계약·인증, 전부 Codex 적대적 리뷰 hardening 완료)
- 성격: 9개 설계 문서는 이미 망라적으로 hardening됨 → 본 문서는 **"무엇을 어떤 순서·범위·레포 전략으로 구현할지"**(implementation sequencing)를 확정한다. 새 기술 설계가 아니라 기존 SSOT를 구현으로 옮기는 첫 슬라이스의 경계·순서·검증을 정의한다.

## 1. 확정된 전제 결정 (사용자 승인)

### 1.1 레포 전략 — 엄격 폴리레포
architecture §2의 "1 앱 레포 = 1 이미지 = 1 워크로드" 제약을 충실히 따른다.

| 레포 | 역할 | 비고 |
|---|---|---|
| `~/workspace/trip-mate-api` (신규) | **백엔드** (Bun + Hono + Drizzle) | 본 슬라이스 대상 |
| `~/workspace/trip-mate` (이 레포, docs 보유) | **프론트엔드** (Vite + React + FSD) + docs 홈 | web 구현은 후속 |

- 계약 우선(contract-first)이므로 **백엔드가 먼저**다. web은 api가 생성하는 OpenAPI 아티팩트(R2)에만 의존하므로 이후 슬라이스.
- **설계 문서(본 문서 포함)는 `trip-mate` docs 홈에 남는다.** 백엔드 **구현 plan**은 코드와 colocate하기 위해 `trip-mate-api/docs/plans/`에 둔다(hardened-planning 워크트리·실행 세션은 신규 `trip-mate-api` 기준 운용).
- `design.md`(UI/UX 디자인 시스템)는 프론트 전용 → 백엔드 레포에 복사하지 않는다. 나머지(PRD·architecture·tech-stack + plans 5종)는 백엔드에도 복사한다(§3.1).

### 1.2 첫 plan 범위 — 기반 슬라이스
`scaffold + DB 스키마 + 순수 정산엔진(TDD)`. 외부 의존(FX·인증 런타임)이 0이고, 가장 자기완결적이며, 하드닝된 코어(스키마·엔진)를 먼저 굳힌다. FX·인증·API 라우트·OpenAPI 생성·프론트엔드는 **후속 plan**.

## 2. 접근법 결정

설계 문서가 이미 SSOT로 고정되어 "무엇을"은 정해져 있고, 실질 선택지는 **빌드 순서와 DB 검증 깊이**였다.

| 안 | 내용 | 결정 |
|---|---|---|
| **A (채택)** | 의존성 순서(scaffold→타입→스키마→엔진) + 하드닝된 DB 불변식 핵심을 testcontainers로 집중 검증 | ✅ DB 5-pass 하드닝의 성과를 cheap하게 회귀 방지로 묶음 |
| B (린) | 동일하되 DB 통합테스트는 후속 plan으로 이관(이번엔 마이그레이션 적용 + 엔진 테스트만) | 기각 — 하드닝된 불변식이 미검증으로 남음 |

## 3. 기반 슬라이스 설계

### 3.0 산출물 (Definition of Done)
클론 후 `bun install && bun run check && bun run test`가 green인 `trip-mate-api` 레포.
- `check` = `oxlint` + `oxfmt --check` + `tsc --noEmit`
- `test` = vitest (엔진 property 테스트 + DB 제약 통합 테스트)
- `drizzle-kit` 마이그레이션이 깨끗한 PostgreSQL 16에 클린 적용
- HTTP는 `/health`만. **FX·인증 런타임·도메인 라우트·OpenAPI 생성은 없음.**

### 3.1 레포 부트스트랩 + 문서 복사
```
trip-mate-api/
├─ docs/                  # 복사: PRD·architecture·tech-stack + plans 5종 (design.md 제외)
│  └─ plans/              # ← 백엔드 구현 plan이 여기 위치 (코드와 colocate)
├─ src/
│  ├─ core/
│  │  ├─ config.ts        # Zod 검증 env (@t3-oss/env-core)
│  │  ├─ errors.ts        # AppError 계층 (+ SettlementInvariantError)
│  │  ├─ composition.ts   # createCore(): { db, logger, config } (skeleton)
│  │  └─ openapi.ts       # OpenAPIHono 인스턴스 (스텁 — 라우트는 후속)
│  ├─ modules/settlements/domain/compute.ts   # 순수 정산엔진 (+ types)
│  ├─ db/
│  │  ├─ schema/          # enums·currencies·auth-schema·trips·members·expenses·settlements·relations·index
│  │  ├─ migrations/      # drizzle-kit 생성물
│  │  ├─ seed/            # currencies seed (§48)
│  │  └─ client.ts        # Drizzle 클라이언트
│  └─ main.ts             # 컴포지션 루트 + Bun serve (health only)
├─ drizzle.config.ts · tsconfig.json · package.json
├─ .app-config.yml(kind: service) · Dockerfile(arm64)   # 스캐폴드만, 홈랩 온보딩은 별도
├─ lefthook.yml · .gitignore · .env.example · oxlint/oxfmt 설정
```
- 부트스트랩: `git init ~/workspace/trip-mate-api` → 위 레이아웃 → 문서 복사.

### 3.2 툴체인 (architecture §10.6)
- **tsconfig:** `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax` + `moduleResolution: bundler` + `allowImportingTsExtensions` + `noEmit` + `target ES2022`. **데코레이터 플래그 OFF**(§4.2 Bun 데코레이터 버그 회피).
- **린트/포맷:** oxlint(`filename-case` kebab + dot-suffix 허용) + oxfmt(버전 핀, 필요 시 Prettier 폴백).
- **테스트:** vitest + `testcontainers`(DB 통합) + `fast-check`(엔진 property).
- **git 훅:** lefthook (pre-commit: oxlint/oxfmt / pre-push: tsc/test).
- **스크립트:** `dev·check·lint·fmt·typecheck·test·db:generate·db:migrate·db:seed`. (`gen:openapi`는 후속)
- **import 확장자 필수**(우리 파일 `.ts`), 패키지는 예외. 생성물(migrations·auth-schema)은 규칙 제외.

### 3.3 DB 스키마 (Drizzle — SSOT = `2026-06-25-trip-mate-db-design.md` 그대로)
- `enums.ts`: 안정 `pgEnum` 9종(role·member_status·settlement_status·snapshot_status·payment_status·basis·settlement_amount_source·exchange_rate_source[**identity 포함, nullable**]·expense_settlement_state) + **text+CHECK** 4종(input_source·category·payment_method·change_type).
- `currencies.ts`: §48 룩업(code PK·iso_exponent·minor_unit·symbol) + **9통화 seed**(KRW/JPY/VND minor=0, **TWD minor=0**, USD/EUR/THB/GBP/CHF minor=2).
- `auth-schema.ts`: **Better Auth `cli generate`** 산출 — `user`/`account`/`session`/`verification`. FK 타깃 확보용. `user.id`=uuid(`generateId='uuid'`), `account` `unique(provider_id, account_id)`. **런타임 배선(라우트·초대로직)은 인증 plan.** (이 슬라이스는 schema만)
- `trips.ts`: `trips`(+timezone, `uq_trip_settlement_ccy`, `trip_dates` CHECK, `ix_trip_creator`).
- `members.ts`: `trip_members`(부분 유니크 5종: `uq_member_email`·`uq_member_user`·`uq_one_admin`(partial)·`uq_member_trip_id`·`uq_invite_token`(partial), `ix_member_user`).
- `expenses.ts`: `expenses`(`fx_by_source`·`refund_self` CHECK, same-trip composite FK 전부, 인덱스) + `expense_participants`(복합 PK, composite FK, `ix_part_member`) + `expense_audit_logs`(composite FK, append-only).
- `settlements.ts`: `settlements`(`uq_settlement_active`(partial)·`uq_settlement_version`·`uq_settlement_trip_id`, composite FK) + `settlement_currency_totals` + `settlement_transfers`(CHECK 3종·composite FK·`uq_transfer_pair`) + `settlement_member_summaries`(`uq_summary`·composite FK).
- `relations.ts`(drizzle relations 중앙화) · `index.ts`.
- **마이그레이션:** drizzle-kit generate. **composite FK 타깃 UNIQUE를 FK보다 먼저 생성**하는 순서 보장(필요 시 마이그레이션 수동 정렬).
- *DB로 강제 불가한 불변식(참여자≥1, Σ부담액==지출액, Σ순정산==0)은 이 슬라이스에서 **엔진**이 강제.*

### 3.4 도메인 타입 + 정산엔진 (architecture §10.3 + `2026-06-25-settlement-engine-design.md`, approve됨)
- **브랜디드 타입 / Money VO:** `TripId·MemberId·ExpenseId·CurrencyCode·Minor(bigint)` + `Money{amount,currency}` + `add()`(동일 통화 가드). Parse-don't-validate(경계에서 Zod 파싱 후 brand).
- **`compute.ts`(순수·결정적·BigInt):**
  - `splitExpense`: `floorDiv`(-∞ 직접 구현, BigInt 0방향 절삭 보정) + member_id asc 잔여 배분, `Σ분배==amount` 어서션.
  - 멤버 집계: `total_paid·total_share·net`, `Σnet==0` 어서션.
  - `minTransfers`: greedy(금액 desc·동률 id asc), ≤(n−1)건, 결정적.
  - 이중축: settlement(1통화) + local(통화별 독립 서브축).
  - 환불 미러링: 원지출 단위 누적 apportionment + 행별 누적 델타(검증: 음수·payer 일치·누적≤원액). **의미론·테스트는 지금 고정, 기능 노출은 Phase 3.**
  - 위반 시 `SettlementInvariantError`(core/errors.ts).

### 3.5 테스트 전략
- **엔진(fast-check property + 명시 케이스):** `Σshare==amount`·`Σnet==0`·셔플 결정성·`≤n−1`·`from≠to ∧ amount>0`·round-trip(transfer 적용 시 전원 0)·환불 미러링(전액/부분/다중분할 합성=원 정확 미러)·over-refund 거부·payer 불일치 거부·입력 닫힘. 명시 케이스: n=1·나눔/안나눔·음수(floor 보정)·동일결제자·결제자≠참여자·순환채무(A→B→C)·다통화 local. **합계오차 허용 = 0(PRD §35.4).**
- **DB(testcontainers PG16):** 마이그레이션 클린 적용 + 핵심 제약 거부 검증 — cross-trip composite FK 거부 · `uq_one_admin`(2번째 active admin 거부) · `fx_by_source`(converted에 rate 없으면 거부 / card_billed에 source 있으면 거부) · transfer CHECK(amount>0·from≠to·paid_consistency) · `uq_member_email`(중복 초대 거부) · currencies seed 존재.

### 3.6 이 plan 제외 (후속 plan)
FX 파이프라인 런타임 · Better Auth 런타임/라우트/초대 로직 · HTTP API 라우트+DTO · OpenAPI 생성+R2 publish · Hey API codegen · **프론트엔드 전체(trip-mate web)** · 홈랩 배포 온보딩(파일은 스캐폴드, 배포는 안 함) · version-bump/audit 트리거(서비스 레이어) · 환불 **기능** 노출(엔진 의미론만).

## 4. PRD/설계 추적
| 설계 SSOT | 본 슬라이스 반영 |
|---|---|
| DB 설계(composite FK·CHECK·부분유니크) | §3.3 Drizzle 스키마 + §3.5 제약 통합테스트 |
| 정산엔진(순수 BigInt·환불 미러링) | §3.4 compute.ts + §3.5 property 테스트 |
| architecture(수동 DI·수직 슬라이스·툴체인) | §3.1 레이아웃 + §3.2 툴체인 |
| tech-stack(Bun·Drizzle·vitest·테스트컨테이너) | §3.0 DoD + §3.2 |
| 인증 설계(Better Auth 스키마) | §3.3 auth-schema(스키마만, 런타임 후속) |

## 5. 다음 단계 (hardened-planning)
- 본 설계 확정(사용자 승인 완료) → (선택) Phase A.5 설계 리뷰 → Phase A.7 `trip-mate-api` 워크트리 격리 → Phase B `writing-plans`로 bite-sized TDD 구현 계획 작성(`trip-mate-api/docs/plans/`) → Phase C Codex 적대적 리뷰 → Phase D 확정·executing-plans 핸드오프.
