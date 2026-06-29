# trip-mate 기술 스택 (Tech Stack · ADR)

## 0. 문서 정보

| 항목 | 내용 |
|---|---|
| 문서명 | trip-mate 기술 스택 결정 문서 |
| 버전 | v1.1 (리뷰 반영: TWD 최소단위·이미지 보존 정책·계약/세션 보안 정리) |
| 작성일 | 2026-06-24 (v1.1: 2026-06-25) |
| 관련 문서 | `trip-mate-prd.md` (PRD v1.5) · `design.md` (디자인 시스템 v1.3) |
| 대상 | 해외여행 그룹 정산 모바일 웹 서비스 |
| 배포 환경 | 자체 홈랩 (`~/workspace/homelab`, k3s 단일 노드 GitOps) |

이 문서는 PRD가 강제하는 요구사항과 홈랩 플랫폼 제약에서 도출한 기술 선택과 그 근거를 기록한다. 앱 레포(`ukyi-app/trip-mate-api`·`ukyi-app/trip-mate-web`, 2 앱 레포 §8) 스캐폴딩의 기준 문서다.

---

## 1. 설계 원칙·제약

PRD와 홈랩에서 도출한 비협상 제약:

- **모바일 웹** 전용, 앱스토어 배포 없음 (PRD §0, §5.3) → 웹 프론트(모바일 우선), PWA는 후순위.
- **관계형 DB + 트랜잭션 + 무결성** — 정산 확정 스냅샷·낙관적 잠금·감사 로그 (PRD §11, §31) → PostgreSQL.
- **돈은 정수로 결정적 계산** — 통화 최소단위 정수, 부동소수점 금지, 불변식 강제 (PRD §18.2.1, §48) → 서버측 BigInt 연산.
- **자체 호스팅** — 홈랩 k3s GitOps 플랫폼에 온보딩.
- **메모리 원장 ≤ 9216Mi** (클러스터 전체, CI 강제) + **arm64 전용** → **경량 스택**이 강제된다.
- **TypeScript 풀스택**, **프론트/백엔드 분리** (사용자 결정).
- **AI는 비대화형(one-shot)** — Codex 기반, 대화형 챗봇 아님 (PRD §1.1, §22.4).
- 민감정보(카드번호·승인번호) 저장·전송 금지 (PRD §26.3, §22.4).

---

## 2. 아키텍처 개요

프론트엔드(정적 SPA)와 백엔드(API 서비스)를 분리 배포하고, 둘 다 홈랩 공유 Helm 차트의 kind에 매핑한다.

```
              ┌──────────────────────────────────────────────┐
   Internet ──┤ Cloudflare (DNS·WAF·rate-limit·TLS)           │
              │   └ cloudflared Tunnel (outbound only)        │
              └───────────────────┬──────────────────────────┘
                                  ▼  Traefik (Gateway API)
        ┌──────────────────────────────────────────────────────┐
        │  k3s (OrbStack VM · arm64)                            │
        │                                                      │
        │   static  ── trip-mate FE (Vite/React SPA)           │
        │   service ── trip-mate API (Bun + Hono)  ──┐         │
        │   (worker 미사용 — BullMQ는 service 인-프로세스) │     │
        │                                            ▼         │
        │   CNPG(Postgres16) · Valkey(cache) · SealedSecrets   │
        └──────────────────────────────────────────────────────┘
                          │                    │
                          ▼                    ▼
                  외부: Codex/LLM API · 환율 API · Resend(이메일)  /  이미지=홈랩 SSD(PVC)
```

차트 kind 매핑:

| kind | 구성요소 | 역할 |
|---|---|---|
| `static` | 프론트 SPA | 정적 자산 |
| `service` | 백엔드 API | 인증·정산계산·DB·AI·FX·이메일 |
| BullMQ 인-프로세스 (service 내) | AI 분석·이메일 재시도·**리마인더 반복잡(앱단위 cron)**·FX 캐시 워밍 | 별도 worker 워크로드 미사용(1레포1kind). 부하 커지면 분리. **Phase 2 전까지 비활성**, 활성화 시 반복잡 스케줄러 중복 등록 방지를 위해 `API replica=1 고정` 또는 `advisory-lock/leader election` 중 하나 + **idempotent repeatable job id** 적용 |

---

## 3. 핵심: 단일 타입 사슬

DB 스키마 하나가 검증·API 계약·프론트 타입·쿼리 훅까지 한 줄기로 흐른다. 손으로 타입을 맞출 지점이 없다. 단, 타입 사슬은 SSOT지만 **노출 경계는 라우트별 DTO(pick/omit)로 좁혀** 내부 컬럼(version·audit 등)이 API에 새지 않게 한다 (architecture §3).

```
Drizzle 스키마
   ─ drizzle-zod →        Zod 스키마
      ─ @hono/zod-openapi → OpenAPI 스펙 (+ 서버 입력검증 + Swagger)
         ─ Hey API →        프론트 TS 타입 + Fetch SDK + TanStack Query 훅 (+ 선택: Zod 응답검증)
```

- 입력 검증(PRD §45)·API 계약·프론트 타입이 **하나의 SSOT**에서 파생된다.
- 정산처럼 돈-민감 응답은 끝단까지 타입·런타임 검증이 보장된다.

---

## 4. 프론트엔드 (`static`)

| 레이어 | 선택 | 비고 |
|---|---|---|
| 빌드/런타임 | Vite + React + TypeScript | SPA 정적 자산 |
| 스타일 | **Tailwind CSS v4** (CSS-first `@theme`) | 접근성(PRD §34.3)·반응형. tailwind-merge v3(v4 지원)+extendTailwindMerge |
| 컴포넌트(동작·a11y) | **Base UI** (헤드리스, WCAG 2.2) | 다이얼로그·콤보박스 등 ARIA/키보드, Tailwind로 직접 스타일 |
| 변형 관리 | **CVA** + tailwind-merge + clsx | size·intent·state variant 타입세이프 |
| 애니메이션 | **Motion** (motion.dev) | 마이크로 인터랙션, LazyMotion·reduced-motion |
| delight 효과 | **React Bits** | 랜딩/온보딩 한정 — 핵심(돈) 화면 배제 |
| 스켈레톤 로딩 | **boneyard** (`boneyard-js`) | 실제 UI 빌드타임 추출 → 픽셀퍼펙트 본 JSON(zero-layout-shift), 런타임 ~7.5KB. Vite 플러그인/CLI(headless 스냅샷), `.dark` 다크모드. 상세 `design.md` §6.10 |
| 폰트 | **Pretendard** | 한글 UI, 금액은 tabular figures |
| 라우팅 | **TanStack Router** | 완전 타입세이프, TanStack Query와 짝 |
| 서버 상태 | **TanStack Query** | 캐싱·재요청·낙관적 업데이트 |
| API 클라이언트 | **Hey API** (`@hey-api/openapi-ts`) | Fetch client + TanStack Query 플러그인, OpenAPI 스펙에서 생성 |
| 검증 | Zod | OpenAPI 계약에서 생성 (Hey API Zod 플러그인으로 응답 검증 옵션) — FE는 서버 Zod를 직접 import하지 않음 |
| 구조 | Feature-Sliced Design | 슬라이스 기반 모듈화 |
| 디자인 시스템 | 친근 미니멀 · Trust Blue #3B82F6 | 상세는 `design.md` |

UX 관련 PRD 요구 반영 지점:
- 정산 화면 기본은 정산통화 표 강조, 현지통화는 접기/탭 (PRD §18.1).
- 전역 오류·빈상태·로딩 표준 (PRD §34.5).
- WCAG 2.1 AA (PRD §34.3) — 시맨틱 마크업·aria-live·키보드·대비.

---

## 5. 백엔드 (`service`)

| 레이어 | 선택 | 비고 |
|---|---|---|
| 런타임 | **Bun** | 홈랩 Bun 툴링·arm64·메모리 예산과 정합 |
| 프레임워크 | **Hono** | 초경량 HTTP |
| API 계약 | **`@hono/zod-openapi`** | Zod 스키마 → OpenAPI 스펙 + 런타임 검증 + Swagger UI |
| ORM | **Drizzle** + drizzle-kit(마이그레이션) + drizzle-zod(스키마→Zod) | SQL-first·경량·명시적 |
| 인증 | **Better Auth** | Google OAuth, Postgres 어댑터, 세션 |
| 정산 엔진 | 자체 모듈 (BigInt 정수, 결정적) | PRD §18.2~18.4 불변식 |

### 5.1 돈·정산 구현 규칙 (PRD §18, §48)

- 금액은 DB에 **`BIGINT` 최소단위 정수**로 저장. 통화별 최소단위는 **PRD §48 부록 표를 SSOT**로 따른다 (KRW/JPY/VND/TWD=1, USD/EUR/THB/GBP/CHF=0.01). TWD는 ISO 4217상 소수 2자리지만 서비스 최소단위=1(정수)로 취급한다 (PRD §48).
- 계산은 **TS BigInt**로 수행, 부동소수점 금지.
- 분배: `floor` 후 잔여를 참여자 `member_id` 오름차순 1단위씩, `Σ(부담액)==지출액` 불변식 (PRD §18.2.2).
- 송금 최소화: 정렬 결정성(금액 desc, 동률 시 member_id asc)으로 동일 입력→동일 송금 리스트 (PRD §18.4) → 확정 스냅샷 재현 보장.
- 정산 확정은 단일 트랜잭션 + `version`(낙관적 잠금)으로 동시 수정 충돌 차단 (PRD §31.6).

### 5.2 인증·권한 (PRD §7~§11)

- 전역 사용자 식별자: `google_account_id`(안정), email은 join 매칭 전용.
- 여행방 내 식별자: `trip_members.id` (지출·정산·권한 1차 키).
- 이메일 정규화: 소문자+공백 제거 + Gmail 점/+ 제거 (PRD §8.5).
- 접근 제어는 멤버십(`user_id`) 기준. 미들웨어에서 trip 멤버십·role 검사.
- 세션 쿠키: `HttpOnly`+`Secure`+`SameSite`, 교차 서브도메인은 Better Auth `trustedOrigins` + 쿠키 `Domain=.ukyi.app`. CORS는 web origin 명시 allowlist(+`Allow-Credentials`, 와일드카드 금지), 상태변경 요청은 CSRF 방어. Google `email_verified=true` 이메일만 초대 매칭에 사용 (PRD §34.4).
- 초대 토큰: `crypto.randomBytes` 무작위 생성, DB에는 **해시 저장**, 만료일 보유, 재발송·취소 시 이전 토큰 폐기. 토큰은 접근 안내용 포인터일 뿐 권한이 아니다 (PRD §8.3).

### 5.3 AI·외부 호출 (PRD §22.4)

- AI 분석은 **서버측 비대화형(one-shot)** 호출. 텍스트 입력은 Codex 기반.
- 텍스트 전송 전 카드번호·승인번호 클라이언트 마스킹. 이미지는 외부 AI 제공자에 **학습 미사용·미보존 전송**하되, **자체 스토리지에는 보존**(§43 접근통제·보존기간·삭제 규칙, PRD §22.4).
- 사용자·여행방당 레이트리밋(Valkey) + 환율 캐싱.
- 이미지 OCR(영수증/카드 캡처, PRD §24.2·§25)은 비전 경로로 Phase 3에서 확정.

---

### 라이브러리

**공통 (FE·BE)**
- **type-fest** — TS 유틸 타입(런타임 0)
- **es-toolkit** — lodash 대체(빠름·tree-shake)
- **@total-typescript/ts-reset** — TS 기본값 개선(전역 import)
- **@t3-oss/env-core** — 타입드 env 검증(Zod)
- **ofetch** — 외부 API(환율·AI) 호출(재시도·타임아웃·인터셉터, 주로 BE)
- **date-fns v4** (+`@date-fns/tz`) — 날짜·타임존(환율 date-unit·표시·현지 TZ 날짜 판정)

**FE 전용**
- **nanoid** — 클라이언트 생성 id(멱등성 키·낙관적 임시 id). DB PK는 uuid(BE)
- **TanStack Form** — 폼(타입안전·기본 제어 → Base UI 정합, standard-schema/Zod v4)
- **zustand** — 전역 UI 상태(필요 시만)
- **커스텀 ErrorBoundary** — 직접 구현(class) + React 19 root `onCaughtError` 로깅
- **Storybook** — base 컴포넌트 개발·문서(Vite 빌더)
- **browser-image-compression** — 영수증/카드 업로드 전 클라이언트 압축(§26.1)
- **@tanstack/react-virtual** — 지출 목록 가상화(300건 §34.2)
- **boneyard** (`boneyard-js`) — 스켈레톤 로딩 본 자동생성(빌드타임 headless 스냅샷→정적 JSON, ~7.5KB). dev/Storybook(Vite) 대상 스냅샷, 생성물 `bones/registry`는 **커밋**(content-hash 증분) → prod Vite 빌드(arm64·headless 없음)는 import만. `design.md` §6.10
- **vite-plugin-pwa** — PWA 셸·설치 (웹푸시 Phase 2; iOS는 홈화면 설치 후 가능)
- **날짜 선택** — 단일=native `<input type="date">`(모바일 OS 피커), 여행 기간 범위=**React Aria** RangeCalendar(`react-aria-components` + `@internationalized/date`, a11y·TZ 강점)
- **dev 도구** (dev-only) — **code-inspector**(클릭→에디터 소스 점프, Vite 플러그인) · **@tanstack/react-router-devtools** · **@tanstack/react-query-devtools** · React DevTools(확장)

**BE 전용**
- **testcontainers** — 통합 테스트용 Postgres
- **react-email** + **resend** — 트랜잭션 이메일 템플릿·발송(§41)
- **drizzle-seed** + **@faker-js/faker** — 개발/테스트 시드
- **web-push** (Phase 2) — VAPID 웹푸시 발송
- **BullMQ** (Phase 2, Valkey 큐 + **api 인-프로세스 워커**) — AI 분석·이메일 재시도·**리마인더 반복잡(앱단위 cron)**
- 토큰 생성 — Node/Bun `crypto`(uuid·randomBytes), nanoid 미사용

**개발/품질 (양쪽)**
- **vitest**(단위/통합) · **lefthook**(git 훅: oxlint/oxfmt/tsc) · oxlint + oxfmt(§architecture §10.6)

---

## 6. 데이터·인프라 (홈랩 재사용)

PRD 요구의 대부분이 홈랩에 이미 존재한다. 새로 만들지 않고 바인딩한다.

| 필요 (PRD) | 홈랩 자산 | 바인딩 |
|---|---|---|
| 관계형 DB + 백업 (§11/§46) | CloudNativePG (PG16 + PgBouncer + barman→R2) | `create-database` |
| 캐시/레이트리밋/세션 (§14/§22.4) | Valkey (Redis 호환) | `create-cache` |
| 영수증/카드 이미지 (영구 보관) | **홈랩 로컬 SSD** (PVC, local-path) | ⚠️ App Platform 볼륨 미지원 → **Phase 3 이미지 기능 착수 전 선행조건**(별도 chart/StatefulSet 또는 플랫폼 볼륨 지원, 백업·at-rest 암호화, RPO/RTO)으로 **PRD §36 Phase 3 선행조건 체크리스트에서 게이트**한다. 단일노드=백업 별도. **인증 엔드포인트 서빙**(공개 URL 금지). aws4fetch/R2 미사용. PRD §22.4/§42/§43 보존·접근통제 반영됨 |
| 공개 노출 + TLS + WAF (§34.4) | Cloudflare Tunnel + Traefik(Gateway API) + cert-manager | HTTPRoute (`*.ukyi.app`) |
| 시크릿 (OAuth/AI/이메일 키) | SOPS + SealedSecrets | `*.sealed.yaml` |
| 모니터링/로깅/알람 (§46) | VictoriaMetrics/Logs + Grafana + Alertmanager | 메트릭·로그 적재 |
| 배포/롤백 (§46) | ArgoCD GitOps (selfHeal) | `apps/trip-mate/deploy/prod` |

---

## 7. 외부 의존

| 의존 | 용도 | 비고 |
|---|---|---|
| Codex / LLM API | AI 비대화형 입력 (텍스트) | 서버측 호출, 레이트리밋 |
| **Open Exchange Rates** (일 단위·historical) | 정산통화 환산 | 9통화 커버(TWD·VND 포함)·무료 1,000/월·USD base(고정밀 교차). Valkey 캐시(`fx:usdtable:{date}`) + last_known fallback (PRD §14.3). secondary: currencyapi.com |
| **Resend** (무료 티어) | 트랜잭션 이메일 (초대·정산 알림, §41) | 3,000/월·100/일, 도메인 1개. ukyi.app + Cloudflare로 검증 |
| (fallback) Brevo | 이메일 | 일 100통 한도 초과 시 무비용 전환(300/일) |

> 홈랩에 이메일 발송 인프라가 없어 Resend가 **유일한 신규 외부 SaaS**다. 자체 SMTP는 주거망+터널 환경 deliverability 때문에 배제.

---

## 8. 배포 — 홈랩 App Platform 온보딩 (2 앱 레포)

홈랩 App Platform은 **"1 앱 레포 = 1 이미지 = 1 워크로드"**다(`.app-config.yml`의 `kind` 단수, `reusable-app-build.yaml`이 레포당 이미지 1개). 따라서 trip-mate는 **두 앱 레포**로 온보딩한다.

| 레포 | kind | 빌드 |
|---|---|---|
| `ukyi-app/trip-mate-api` | service | Bun + Hono → arm64 이미지 |
| `ukyi-app/trip-mate-web` | static | Vite 정적(static.server: sws) → arm64 이미지 |

각 레포 공통 온보딩:

1. `homelab-app-template`에서 레포 생성.
2. `.app-config.yml` 작성 (계약: `tools/app-config-schema.json`, `kind` 1종).
3. main push → `reusable-app-build.yaml`가 **arm64 이미지를 GHCR**에 push.
4. 홈랩에서 owner가 디스패처 실행: (api만) `create-database`·`create-cache`, 둘 다 `create-app`.
5. **배포 설정** `apps/trip-mate-api/deploy/prod/`·`apps/trip-mate-web/deploy/prod/`:
   - api: `service` values (Hono + BullMQ 인-프로세스 워커), SealedSecret(Google OAuth·Codex/LLM·Resend·환율 키), `.bindings.json`(db/cache)
   - web: `static` values + `route.public`
6. **공개 노출:** `infra/cloudflare/apps.json` `active:false` 등록 → Healthy 후 `activate-app`로 DNS.
7. **이미지 갱신:** `bump-poll.yaml`이 레포별 digest 핀 검증 후 autoDeploy.

### 8.1 계약 동기화 (2 레포)

```
trip-mate-api:  bun gen:openapi → openapi.json → R2 publish
                키: openapi/{env}/{api_commit_sha}.json + openapi/{env}/latest.json(가변 포인터)
trip-mate-web:  bun gen:api(Hey API) → R2의 openapi.json 소비 → src/shared/api
                소스: OPENAPI_SOURCE=url(CI/prod, R2 latest 기본) | file(로컬·api+web 동일 PR)
                + CI drift 체크: 핀된 스펙으로 재생성 결과 ≠ 커밋된 src/shared/api 이면 실패
```

- **스펙 버전 핀:** web 빌드는 `latest` 포인터 또는 특정 `{api_commit_sha}` 키를 핀해 재현 가능 빌드를 보장한다.
- **R2 장애:** 코드젠은 마지막 커밋된 `src/shared/api` 생성물로 폴백하며 일시 R2 오류로 빌드를 하드 실패시키지 않는다.
- **breaking change:** API가 신규 `{sha}` 키로 publish → web PR에서 핀을 갱신해 FE/BE를 함께 전환한다.

### 8.2 앱 레포 레이아웃

```
trip-mate-api/                 trip-mate-web/
├─ .app-config.yml             ├─ .app-config.yml
├─ Dockerfile (arm64)          ├─ Dockerfile (arm64, 정적→sws)
├─ openapi.json (→R2)          ├─ src/ (Feature-Sliced Design)
└─ src/                        │  └─ shared/api/ (Hey API 생성물)
   ├─ core/  modules/  db/     └─ …
   └─ main.ts
```

> FE/BE는 완전 분리 배포되며, OpenAPI 스펙(R2 아티팩트)으로만 계약 연결된다. 코드 공유 없음.

---

## 9. 결정 기록 (ADR 요약)

| 결정 | 선택 | 기각 대안 | 핵심 근거 |
|---|---|---|---|
| 생태계 | TypeScript 풀스택 | Python+JS, JVM | 한 언어·타입 공유(계약 생성물)·MVP 속도 |
| 아키텍처 | FE/BE 분리 | Next.js 풀스택 단일 | 사용자 선호, 정적 FE + API 분리 배포가 차트 kind와 정합 |
| 백엔드 | Bun + Hono | NestJS+Node, Fastify+Node | 메모리 원장 ≤9216Mi·arm64·홈랩 Bun 툴링 정합 |
| API 계약 | OpenAPI 계약우선 | tRPC, GraphQL | 진짜 분리·문서·코드젠. GraphQL은 단일 클라이언트·mutation 중심·캐싱/레이트리밋/DoS 측면에서 오버엔지니어링 |
| ORM | Drizzle | Prisma, Kysely(주력) | 경량·Bun 네이티브·명시적 트랜잭션 + drizzle-zod 타입 사슬 |
| 인증 | Better Auth | Auth.js, Clerk/Supabase Auth | 자체호스팅·Postgres·Google OAuth |
| 프론트 라우팅 | TanStack Router | React Router | 완전 타입세이프, TanStack Query와 짝 |
| 프론트 API 클라이언트 | Hey API | openapi-typescript+openapi-fetch | TanStack Query 훅 자동생성으로 글루 코드 제거 |
| 이메일 | Resend(무료) | Brevo(주력), SES, SendGrid | TS DX·React Email·무료 영구 티어. Brevo는 fallback |
| 환율 API | Open Exchange Rates | Frankfurter(TWD/VND 미커버), Fixer·exchangerate.host(100/월), currencyapi.com(→secondary) | 9통화·historical·무료 1,000/월·일자당 1호출. 조사 `docs/plans/2026-06-25-fx-pipeline-design.md` |
| 인프라 | 홈랩 k3s GitOps | 클라우드(Vercel/Supabase) | 자체 호스팅 결정, 자산 대부분 기존재 |
| 계약 스펙 버전 | commit-sha 키 + latest 포인터(§8.1), breaking change는 신규 키 publish 후 web 핀 갱신 | 단일 latest 덮어쓰기 | 재현 가능 빌드·롤백·미배포 스펙 격리 |

복잡 정산 리포트 쿼리가 늘면 Drizzle을 유지한 채 해당 부분만 Kysely/raw SQL로 분리할 수 있다(공존 가능).

---

## 10. 보류·오픈 항목

- **이미지 OCR 경로**(비전 모델/OCR) — Phase 3에서 확정 (PRD §22.4).
- **AI 비용/비즈니스 모델** — MVP는 무료+레이트리밋, 추후 결정 (PRD §22.4, G11).
- **테스트 기본값** — Vitest(단위) + Playwright(E2E). 수용 기준은 PRD §35.4.
- **Resend 일 100통 한도** — 초기 충분, 초과 시 Brevo 전환.
- **(해결) 환율 API 벤더** — Open Exchange Rates(primary) + currencyapi.com(secondary). 9통화·무료 1,000/월·historical. 조사·파이프라인 `docs/plans/2026-06-25-fx-pipeline-design.md`. 착수 시 가격/한도·TWD/VND historical 1회 재확인.

---

## 11. PRD → 기술 추적

| PRD 요구 | 구현 기술 |
|---|---|
| 정수 정산·불변식 (§18, §48) | BigInt 정산 엔진 + `BIGINT` 컬럼 |
| 정산 스냅샷·확정 (§31) | Drizzle 트랜잭션 + `settlements`/`settlement_transfers` 테이블 + `version` |
| Google 인증·멤버십 (§7~§11) | Better Auth + 미들웨어 권한 검사 |
| 환율 4단계 우선순위·캐싱 (§14) | 환율 API + Valkey 캐시 + 스냅샷 동결 |
| AI 비대화형 입력 (§22) | Codex 서버측 호출 + 마스킹 + 레이트리밋 |
| 알림 이메일 (§41) | Resend + BullMQ(이메일 재시도·리마인더 반복잡) |
| 입력 검증 (§45) | Zod (@hono/zod-openapi) |
| 오류·빈상태 표준 (§34.5) | 프론트 전역 상태 처리 |
| 컴플라이언스·보존 (§42·§43) | SealedSecrets·이미지 보존/삭제·접근통제·익명화 |
| 운영·관측 (§46) | Victoria stack + ArgoCD + CNPG 백업 |
