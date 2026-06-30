# trip-mate-api

여행 비용 분담·정산 백엔드 API. 이 문서는 **앱이 어떻게 구성되어 있고 어떤 기술로 만들어졌는지**를 설명한다(도메인 기능 상세는 `docs/plans/` 참조).

---

## 기술 스택

| 레이어 | 기술 |
|---|---|
| 런타임 | **Bun** (TypeScript 직접 실행, 번들·테스트 러너 내장) |
| 웹 프레임워크 | **Hono** + **@hono/zod-openapi** (Zod v4) — contract-first 라우팅 |
| 검증/스키마 | **Zod v4** (요청·응답·env 단일 스키마 소스) |
| DB | **PostgreSQL** + **Drizzle ORM** (postgres-js 드라이버, snake_case) |
| 마이그레이션 | **drizzle-kit**(생성) + **drizzle-orm migrator**(부팅 시 런타임 적용) |
| 인증 | **Better Auth** (쿠키 세션 · Google OAuth · `__Host-` 쿠키) |
| 캐시/세션 | **ioredis** → Valkey/Redis (세션 secondaryStorage · FX 캐시) |
| 금액 계산 | **decimal.js** (부동소수점 금지 — 정수 minor unit + 십진 환율) |
| 외부 연동 | **ofetch** (FX 환율 provider) |
| 로깅 | **pino** |
| 설정 | **@t3-oss/env-core** + Zod (부팅 시 env 검증·실패 시 기동 중단) |
| 테스트 | **vitest** + **testcontainers**(실 PG·Redis) + **fast-check**(속성 기반) |
| 린트/포맷 | **oxlint** + **oxfmt** · **lefthook**(pre-commit/push 게이트) |
| 타입 | **strict TS** (`noUncheckedIndexedAccess`·`exactOptionalPropertyTypes`·`verbatimModuleSyntax`) |
| 컨테이너/배포 | **Docker**(oven/bun alpine, arm64) → **GHCR** → **homelab k3s**(ArgoCD GitOps) |

## 설계 원칙

- **Contract-first OpenAPI** — `openapi.json`이 SSOT, 앱이 `GET /v1/openapi.json`으로 직접 서빙, CI가 drift 차단
- **Functional core / imperative shell** — 비즈니스 규칙은 순수 함수(`service`·`domain`), I/O는 얇은 껍데기(`controller`·`repo`)
- **Port + Adapter (DIP)** — repo·cache·FX provider를 인터페이스(포트)로 두고 어댑터 주입
- **Composition root** — `main.ts` 한 곳에서만 DI·IO·싱글톤 구성(모듈엔 top-level IO 없음 → 테스트는 fake 주입)
- **낙관적 동시성** — `version` CAS로 갱신 충돌 감지
- **RFC 9457 problem+json** — 모든 에러를 표준 포맷으로(루트 onError에서 매핑)
- **DB-durable 멱등성** — `INSERT … ON CONFLICT` single-flight(Redis 비의존)
- **부팅 self-migrate** — 기동 시 멱등 마이그레이션 후 서빙(배포 차트에 별도 Job 없음)

## 프로젝트 구조

```
src/
├─ main.ts            컴포지션 루트 — DI·부팅 self-migrate·서버(:8080)
├─ app.ts             buildV1App — /v1 라우트 조립(CORS·CSRF·에러필터·security)
├─ core/              프레임워크 비종속 인프라
│  ├─ openapi.ts       OpenAPIHono 팩토리(422 defaultHook)
│  ├─ errors.ts        AppError 계층 + problem+json onError
│  ├─ guards.ts        requireAuth 등 인증/인가 미들웨어
│  ├─ csrf.ts          Origin·Sec-Fetch-Site 기반 CSRF
│  ├─ host-cookie.ts   __Host- 쿠키 정규화
│  ├─ idempotency.ts   DB-durable 멱등 미들웨어(single-flight·sweeper)
│  ├─ money.ts         decimal 기반 금액 유틸
│  ├─ http.ts          problem+json 헬퍼
│  ├─ config.ts        env 검증(@t3-oss/env-core)
│  └─ composition.ts   createCore(db·logger·config·URL 해석)
├─ modules/<도메인>/  auth · trips · members · expenses · fx · settlements
│  ├─ *.schema.ts      zod 요청/응답 스키마(openapi 등록)
│  ├─ *.repo.ts        포트 + Drizzle 어댑터
│  ├─ *.service.ts     함수형 코어(규칙·트랜잭션 조율)
│  ├─ *.controller.ts  Hono 라우트(imperative shell)
│  └─ domain/          순수 도메인 계산(분배·정산 그래프 등)
└─ db/
   ├─ schema/          Drizzle 테이블·관계·enum
   ├─ migrations/      drizzle-kit 생성 SQL(부팅 시 적용)
   ├─ migrate.ts       런타임 마이그레이터(self-migrate)
   ├─ seed/            currencies 시드
   └─ client.ts        postgres-js 커넥션
```

**모듈 패턴**: 각 도메인은 `schema → controller → service → repo` 흐름. `controller`는 검증·인증만 하고 `service`(순수)에 위임, `service`는 `repo` 포트로 영속화. 같은 모양이 6개 도메인에 반복돼 예측 가능.

## 데이터 계층

- **Drizzle ORM** 스키마(`src/db/schema/`): trips·members·expenses·settlements·fx·currencies·idempotency + Better Auth 테이블, 관계·enum 분리
- **마이그레이션**: `drizzle-kit generate`로 SQL 생성(레포 커밋) → 앱이 **부팅 시 `migrate.ts`로 멱등 적용**(직결 URL 사용; 풀러는 DDL 비호환)
- 금액은 정수(minor unit) bigint, 환율은 `numeric` 십진 문자열 + decimal.js로 cross-rate 계산

## 품질·테스트

- **통합 우선**: vitest + **testcontainers**로 실제 Postgres·Redis를 띄워 repo·controller·미들웨어를 검증(목 최소화)
- **속성 기반**: fast-check로 분배·정산 계산의 불변식 검증
- **게이트**: `bun run check`(oxlint + oxfmt + tsc) · lefthook이 commit/push 전 자동 실행 · CI(`.github/workflows/ci.yml`)가 check·test·openapi-drift 수행

## 개발

```bash
bun install
cp .env.example .env          # 앱 키(BETTER_AUTH_SECRET·BETTER_AUTH_URL·WEB_ORIGINS)
# 로컬 오버라이드는 .env.local: TRIP_MATE_DATABASE_URL·TRIP_MATE_REDIS_URL·BETTER_AUTH_URL=http://localhost:8080·USE_SECURE_COOKIES=false
bun run dev                   # 부팅 시 self-migrate 후 :8080(PORT)

bun run check                 # oxlint + oxfmt + tsc
bun run test                  # vitest(testcontainers: PG·Redis — Docker 필요)
bun run gen:openapi           # openapi.json 재생성(무-IO)
```

## API 계약

`/v1` 하위로 trips·members/invites·expenses(+FX)·settlement 라우트, 인증은 `/api/auth/*`(Better Auth 쿠키 세션). 스펙은 [`openapi.json`](./openapi.json)(SSOT)이며 앱이 `GET /v1/openapi.json`으로 서빙한다. 생성·소비·발행 옵션은 **[docs/contract-consumption.md](./docs/contract-consumption.md)**.

## 배포

homelab(k3s GitOps)에 배포. 이미지 `ghcr.io/ukyi-app/trip-mate-api`(linux/arm64, `release.yaml` → GHCR), 부팅 self-migrate, `/health`·`/ready` probe, port 8080, PSA restricted(non-root·read-only rootfs). DB/캐시는 conn 핸들(`TRIP_MATE_*`)·앱 시크릿은 SealedSecret(`bun run secret:seal`)로 주입. 전체 절차는 **[docs/deployment-homelab.md](./docs/deployment-homelab.md)**.
