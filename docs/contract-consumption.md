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

## 3. 발행 (R2)

`main` 푸시 시 `publish-openapi` 잡이 `openapi.json`을 Cloudflare R2(S3 호환)에 업로드한다. 다음 GitHub secrets가 설정돼야 동작(없으면 스킵, 레포의 `openapi.json`이 여전히 SSOT):

| secret | 설명 |
|---|---|
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 API 토큰 |
| `R2_ENDPOINT` | `https://<account_id>.r2.cloudflarestorage.com` |
| `R2_BUCKET` | 버킷명 |

발행 경로: `s3://<R2_BUCKET>/openapi.json` (`Cache-Control: no-cache`).

## 4. 소비 (프론트엔드)

FE 레포에서 [@hey-api/openapi-ts](https://heyapi.dev)로 타입·클라이언트를 생성한다(별도 레포라 여기엔 codegen 없음):

```bash
# FE 레포에서
bunx @hey-api/openapi-ts \
  -i <openapi.json 경로 또는 R2 URL> \
  -o src/api/generated \
  -c @hey-api/client-fetch
```

- `-i`: 로컬은 백엔드 레포의 `openapi.json`, 운영은 R2 발행 URL.
- **돈은 `string`(minor unit)**, **`version`은 동시성 토큰**(CAS-feeding 응답·mutation 요청 echo)으로 생성된다(`z.bigint().transform` 금지 — codegen이 bigint/number로 낼 수 있어 D1에서 `z.string().regex(/^-?\d+$/)` 사용).
- 인증은 cookie(`__Host-better-auth.session_token`); 요청에 `credentials: "include"`.
- mutation은 `Idempotency-Key`(nanoid) 헤더 권장(지출 생성 등 중복 방지).

## 5. 계약 요약(현재)

`/v1` 하위 14 경로: 인증(`/api/auth/*`, Better Auth) · trips · members/invites · expenses(+FX) · settlement(GET·precheck·finalize·unlock·transfers/mark-paid). 에러는 RFC 9457 `application/problem+json`.
