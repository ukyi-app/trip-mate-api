# trip-mate-api — homelab(k3s GitOps) 배포 런북

대상 플랫폼: `ukyi/homelab`(k3s 단일노드, ArgoCD GitOps, 공유 Helm 차트 `platform/charts/app`). 분석 기준 `homelab` 레포 관례(AGENTS.md·app-config-schema·example-api).

> **경계(중요):** 실제 배포는 **owner가 homelab GitHub Actions 디스패처**(`create-database`/`create-cache`/`create-app`)로 실행하며 PR 머지 → ArgoCD 싱크다. homelab 레포 파일을 **직접 만들지 않는다**(apps/README fail-closed 게이트). 클러스터 런타임 검증(파드 기동·probe·DB 접속)은 클러스터 접근이 있는 owner가 수행한다. 본 문서는 그 절차와 **앱이 제공하는 계약**을 정리한다.

## A. 앱이 제공하는 계약(이 레포에서 구현 완료)

| 항목 | 값 | 근거 |
|---|---|---|
| 워크로드 | `kind: web`, 내부 전용(`public: false`) | `.app-config.yml` |
| 리슨 포트 | **8080**(`PORT` env, 기본 8080) | 차트 `ports.http: 8080` |
| probe | liveness `GET /health` · readiness `GET /ready` | `.app-config.yml` / `src/main.ts` |
| 마이그레이션 | **부팅 시 self-migrate**(drizzle-orm 런타임 마이그레이터, 멱등) → 서빙 | 차트에 migrate Job 없음(self-migrate 계약) |
| 보안 | non-root(65532)·read-only rootfs 정합 | Dockerfile + 차트 PSA restricted |
| 이미지 | `ghcr.io/ukyi-app/trip-mate-api`(linux/arm64) | `reusable-app-build.yaml` |

**앱이 요구하는 env 키**(SealedSecret으로 주입 — envFrom):
앱은 **prefixed conn 핸들 키를 그대로** 읽는다(generic 폴백 없음). 키 = `create-database`/`create-cache` 산출명을 UPPER_SNAKE한 것. ⚠️ **DB·캐시 이름은 반드시 `trip-mate`** 로 만들어야 키가 `TRIP_MATE_*`가 되어 앱과 일치한다(`trip-mate-api`로 만들면 `TRIP_MATE_API_*`가 되어 불일치).
- `TRIP_MATE_DATABASE_URL` (런타임, pgbouncer 풀러) — create-database(name=trip-mate) 산출
- `TRIP_MATE_MIGRATE_DATABASE_URL` (선택; boot 마이그레이션 직결 pg-rw — 비우면 `TRIP_MATE_DATABASE_URL` 사용. **풀러는 DDL 비호환**이라 prod는 직결 권장)
- `TRIP_MATE_REDIS_URL` (세션·FX 캐시) — create-cache(name=trip-mate) 산출
- `BETTER_AUTH_SECRET`(≥32자)·`BETTER_AUTH_URL`·`WEB_ORIGINS`·`USE_SECURE_COOKIES=true`·`INVITE_TOKEN_TTL_HOURS`
- 선택: `GOOGLE_CLIENT_ID/SECRET`, `OXR_APP_ID`, `CURRENCYAPI_KEY`

## B. owner 실행 절차

### 0) 앱 레포 `ukyi-app/trip-mate-api`
이 레포를 `ukyi-app/trip-mate-api`로 푸시(템플릿 `ukyi-app/homelab-app-template` 관례 정합: `.app-config.yml`·`Dockerfile` 준비됨). main push → `reusable-app-build.yaml@main`이 arm64 이미지를 GHCR에 push(digest 핀).

### 1) DB 프로비전 — homelab 디스패처 `create-database` (**name=`trip-mate`**)
> ⚠️ 이름은 반드시 `trip-mate`(앱이 `TRIP_MATE_*`를 읽음). `trip-mate-api`로 만들면 키가 `TRIP_MATE_API_*`가 되어 불일치. 확장은 선택하지 않음(앱은 확장 불요 — 별도 안내 참조).

공유 CNPG `pg`(ns `database`)에 논리 DB + owner/ro role 생성(PR). 산출 conn 핸들 `db-trip-mate-conn`(ns `prod`)에 **`TRIP_MATE_DATABASE_URL`(풀러)·`TRIP_MATE_MIGRATE_DATABASE_URL`(직결)·`TRIP_MATE_RO_DATABASE_URL`** 키.
- 접속: 런타임 `pg-pooler-rw.database.svc.cluster.local:5432`, 마이그레이션/ro `pg-rw.database.svc.cluster.local:5432`.

### 2) 캐시 프로비전 — 디스패처 `create-cache` (**name=`trip-mate`**, maxmemory 비움=64Mi)
Valkey 인스턴스(ns `cache`) 생성(PR). 산출 `cache-trip-mate-conn`(ns `prod`)에 **`TRIP_MATE_REDIS_URL`** 키. 접속 `trip-mate.cache.svc.cluster.local:6379`.

### 3) 앱 시크릿 봉인(`trip-mate-api-secrets`, ns `prod`)
앱 레포에서 `.env`→`pnpm secret:seal`로 `trip-mate-api-secrets.sealed.yaml` 생성. **DB/Redis URL은 넣지 않는다**(1·2단계 conn 핸들이 envFrom로 공급). 이 시크릿엔 앱 설정만:
- `BETTER_AUTH_SECRET`(≥32자)·`BETTER_AUTH_URL`·`WEB_ORIGINS`·`USE_SECURE_COOKIES=true`·`INVITE_TOKEN_TTL_HOURS` (+선택 `GOOGLE_*`/`OXR_APP_ID`/`CURRENCYAPI_KEY`)

### 4) 앱 온보딩 — 디스패처 `create-app` (app=`trip-mate-api`)
`apps/trip-mate-api/deploy/prod/`(values.yaml·kustomization.yaml·source-repo·.bindings.json·sealed) 생성(PR, `apps/example-api/` 미러). values.yaml `envFrom`에 **`trip-mate-api-secrets` + `db-trip-mate-conn` + `cache-trip-mate-conn`** 배선(conn 핸들 envFrom은 example-api처럼 직접 추가), `route.host: trip-mate-api.home.ukyi.app`, `public: false`. 내부 전용이라 `activate-app`(공개 DNS)·`infra/cloudflare/apps.json` 불요.

### 5) PR 머지 → ArgoCD 싱크 → 검증(owner, 클러스터)
- 파드 Running, **boot 마이그레이션 로그** 확인, `/health`·`/ready` 200
- 내부 접속 `https://trip-mate-api.home.ukyi.app/v1/openapi.json`(계약 self-serve)
- DB 테이블·시드(currencies) 확인, 세션/FX 캐시 동작

## C. 로컬 검증(이 레포에서 가능)
- `bun run check` · `bun run test`(testcontainers) green
- 이미지: `docker build -t trip-mate-api .` (arm64) → `docker run` 시 A절 env 주입
- 마이그레이션 함수: `src/db/migrate.ts`(테스트 `migrate.test.ts`가 빈 DB 전체 적용·멱등 검증)

## D. AGENTS.md 필수 규칙(homelab 작업 시)
한국어 conventional 커밋·AI 마커 금지 · `*.enc.yaml` 직접 수정 금지(sops만)·시크릿 로그 출력 금지 · **kubectl apply 금지(권위=ArgoCD)** · main 쓰기는 PR-first+auto-merge · 메모리 원장(≤9216Mi) 게이트(앱·캐시만 행 추가, 논리 DB 제외).
