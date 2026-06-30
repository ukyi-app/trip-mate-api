# trip-mate-api

여행 비용 분담·정산 백엔드 API. 멤버가 trip을 만들고, 멤버를 초대하고, 지출을 기록(다통화 → 환율 환산)하고, 정산을 확정·송금까지 처리한다.

## 스택

Bun · Hono + [@hono/zod-openapi](https://github.com/honojs/middleware)(Zod v4) · Drizzle ORM(Postgres) · Better Auth(세션·Google OAuth) · ioredis(Valkey) · decimal.js · vitest + testcontainers.

**설계 원칙:** contract-first OpenAPI · functional core / imperative shell · port+adapter(DIP) · 낙관적 동시성(version CAS) · RFC 9457 problem+json · strict TS.

## 개발

```bash
bun install
cp .env.example .env          # 앱 키(BETTER_AUTH_SECRET·BETTER_AUTH_URL·WEB_ORIGINS)
# 로컬 오버라이드는 .env.local: TRIP_MATE_DATABASE_URL·TRIP_MATE_REDIS_URL·BETTER_AUTH_URL=http://localhost:8080·USE_SECURE_COOKIES=false
bun run dev                   # 부팅 시 self-migrate 후 :8080(PORT)

bun run check                 # oxlint + oxfmt + tsc
bun run test                  # vitest(testcontainers: PG16·redis:7 — Docker 필요)
bun run gen:openapi           # openapi.json 재생성(무-IO)
```

## API 계약

`/v1` 하위로 trips·members/invites·expenses(+FX)·settlement 라우트를 제공한다. 인증은 `/api/auth/*`(Better Auth, cookie 세션).

OpenAPI 스펙은 [`openapi.json`](./openapi.json)(레포 SSOT)이며, 앱이 `GET /v1/openapi.json`으로 직접 서빙한다(계약 호스팅 기본). CI(`.github/workflows/ci.yml`)가 drift를 막는다. 생성·소비·발행 옵션은 **[docs/contract-consumption.md](./docs/contract-consumption.md)** 참조.

## 배포

homelab(k3s GitOps)에 배포한다. 이미지 `ghcr.io/ukyi-app/trip-mate-api`(linux/arm64, `release.yaml` → GHCR), 부팅 시 self-migrate, `/health`·`/ready` probe, port 8080. DB/캐시는 conn 핸들(`TRIP_MATE_*`)·앱 시크릿은 SealedSecret(`bun run secret:seal`)로 주입. 전체 절차는 **[docs/deployment-homelab.md](./docs/deployment-homelab.md)**.

## 도메인(주요 슬라이스)

`docs/plans/`에 슬라이스별 설계·구현 계획. trips·members/invites·expenses/FX·settlement 핵심 도메인 구현 완료.

## 아키텍처

`src/core/`(http·openapi·errors·guards·csrf·idempotency·money) · `src/modules/<도메인>/`(schema·repo·service·controller) · `src/db/schema/`(Drizzle) · `src/app.ts`(buildV1App) · `src/main.ts`(컴포지션 루트).
