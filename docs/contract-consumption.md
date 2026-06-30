# API 계약(OpenAPI) — 발행·소비 가이드

trip-mate-api는 **contract-first**다. `src/`의 zod-openapi 라우트가 OpenAPI 3.1 스펙을 생성하고, 그 스펙(`openapi.json`)이 프론트엔드 타입·클라이언트의 **SSOT(single source of truth)**다.

## 1. 생성 (백엔드)

```bash
bun run gen:openapi   # src/openapi-gen.ts → openapi.json (무-IO·stub deps, env 불요)
```

- `openapi.json`은 **레포에 커밋**된다(생성물이지만 추적). 계약 변경은 이 파일의 diff로 드러난다.
- 라우트/DTO를 바꿨으면 **`bun run gen:openapi` 후 커밋**해야 한다.

## 2. drift 방지 (CI)

`.github/workflows/ci.yml`의 `openapi-drift` 잡이 PR마다 `gen:openapi`를 재실행해 커밋본과 `git diff`한다. **불일치 시 CI 실패** → 코드와 계약이 항상 동기화된다.

## 3. 발행·호스팅

### 3.0 기본(권장): 앱이 직접 서빙 — homelab self-host

백엔드가 `GET /v1/openapi.json` 으로 자기 OpenAPI 스펙을 노출한다(인증 불요·plain route라 스펙 자체엔 미포함·1회 생성 후 캐시, `src/app.ts`). homelab에서 백엔드가 돌면 **외부 스토리지·발행 스텝·시크릿이 전혀 필요 없고**, 계약이 항상 실행 코드와 동기다.

```
소비: http://<homelab-host>:3000/v1/openapi.json
```

레포의 커밋된 `openapi.json`이 여전히 SSOT(drift CI가 보장)이며, 위 엔드포인트는 그 스펙을 런타임에 서빙한다.

### 3.1 선택: 객체 스토리지 발행 (S3 호환 — Cloudflare R2 **또는** homelab MinIO)

정적 호스팅/CDN/앱 다운타임 무관 제공이 필요할 때만. `main` 푸시 시 `publish-openapi` 잡이 S3 호환 스토리지에 업로드(secret 게이트, 없으면 스킵). **엔드포인트만 바꾸면 R2든 homelab MinIO든 동일**(MinIO도 S3 API):

| env/secret | 설명 |
|---|---|
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | S3 액세스 키(R2 API 토큰 또는 MinIO 키) |
| `R2_ENDPOINT` | R2: `https://<account_id>.r2.cloudflarestorage.com` · MinIO: `http://<homelab>:9000` |
| `R2_BUCKET` | 버킷명 |

발행 경로: `s3://<R2_BUCKET>/openapi.json` (`Cache-Control: no-cache`).

#### 수동 발행 (로컬, 선택)

CI를 거치지 않고 즉시 발행하려면(예: 핫픽스 계약), 동일 환경변수로:

```bash
# R2: R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
# homelab MinIO: R2_ENDPOINT=http://<homelab>:9000
export R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_ENDPOINT=... R2_BUCKET=<버킷명>
bun run gen:openapi      # 최신 스펙 재생성(필수)
bun run publish:openapi  # src/publish-openapi.ts → S3 호환 업로드(R2/MinIO, aws CLI, CI와 동일)
```

- **aws CLI 필요**(S3 호환 업로드). `R2_OBJECT_KEY`로 키 변경 가능(기본 `openapi.json`, 예: `v1/openapi.json`).
- 환경변수 누락 시 어떤 변수가 빠졌는지 명시한 에러로 안전 중단.
- 자격증명: R2는 Cloudflare 대시보드 토큰, MinIO는 액세스 키. CI 자동 발행은 위 env를 GitHub secrets로 설정 시 `main` 푸시에 동작.

## 4. 소비 (프론트엔드)

FE 레포에서 [@hey-api/openapi-ts](https://heyapi.dev)로 타입·클라이언트를 생성한다(별도 레포라 여기엔 codegen 없음):

```bash
# FE 레포에서
bunx @hey-api/openapi-ts \
  -i <로컬 openapi.json | 앱 http://<homelab>:3000/v1/openapi.json | 발행 R2/MinIO URL> \
  -o src/api/generated \
  -c @hey-api/client-fetch
```

- `-i`: 로컬은 백엔드 레포의 `openapi.json`, 운영은 R2 발행 URL.
- **돈은 `string`(minor unit)**, **`version`은 동시성 토큰**(CAS-feeding 응답·mutation 요청 echo)으로 생성된다(`z.bigint().transform` 금지 — codegen이 bigint/number로 낼 수 있어 D1에서 `z.string().regex(/^-?\d+$/)` 사용).
- 인증은 cookie(`__Host-better-auth.session_token`); 요청에 `credentials: "include"`.
- mutation은 `Idempotency-Key`(nanoid) 헤더 권장(지출 생성 등 중복 방지).

## 5. 계약 요약(현재)

`/v1` 하위 19 경로: 인증(`/api/auth/*`, Better Auth) · trips · members/invites · expenses(+FX·preview·fx-defaults·**커서 목록/필터**) · settlement(GET·precheck·finalize·unlock·transfers/mark-paid·**mark-unpaid**·**history**·**transfers/events**). 에러는 RFC 9457 `application/problem+json`. 멱등은 DB-durable(`idempotency_keys`).
