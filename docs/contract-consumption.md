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

`/v1` 하위 경로: 인증(`/api/auth/*`, Better Auth) · trips · members/invites · expenses(+FX·preview·fx-defaults·**커서 목록/필터**) · settlement(GET·precheck·finalize·unlock·transfers/mark-paid·**mark-unpaid**·**history**·**transfers/events**) · **사용내역 파싱→지출 초안**(usage-imports·expense-drafts) · **동의**(consents GET/POST — §6). 에러는 RFC 9457 `application/problem+json`. 멱등은 DB-durable(`idempotency_keys`). 정확한 경로·스키마는 `openapi.json`(SSOT).

## 6. 동의 캡처 · 외부 LLM 전송 고지 (FE 통합) — PB-1

개인정보·약관 동의(PRD §42.2)와 사용내역 파싱의 외부 LLM 전송 고지(§22.4·§26)는 **FE가 UI로 게이트하고, 서버가 기록**한다. 백엔드는 **기록만** 하며 차단 미들웨어(403 게이트)는 없다 — 미동의 사용자를 막는 것은 FE 몫이다. 동의 버전은 **서버 소유**(현재 placeholder `"2026-07-07"`, 실 문서 확정 시 갱신).

### 6.1 약관·처리방침 동의 (가입·초대수락)

Google OAuth 가입엔 폼 동의 이벤트가 없으므로 FE가 명시적으로 수집한다.

**플로우:** ① 최초 Google 로그인(세션 확보) 또는 초대 수락 완료 후 → ② FE가 이용약관·개인정보 처리방침 표시(문서엔 §42.2대로 **수집 항목별 처리 목적·보유기간·파기 시점**, §42.5 외부 위탁(AI·OCR·환율) 현황 명시) → ③ 사용자 "동의" → `POST /v1/consents`.

```http
POST /v1/consents      (auth 필요; cookie 세션)
Content-Type: application/json
{ "consents": [ {"type":"tos","version":"<current>"},
                {"type":"privacy","version":"<current>"} ],
  "source": "signup" }          // 초대 수락 경로="invite_accept", 설정 재동의="settings"
→ 200 { "recorded": [ {"type":"tos","version":"...","accepted_at":"...Z"}, ... ] }
```

**버전은 서버 소유.** FE는 아래 GET의 `current`에서 받은 버전을 **그대로** 보낸다. 서버 current와 다르면 **409 ConflictError**(stale) → FE는 최신 문서를 다시 표시하고 재수집(구버전 동의 방지).

**미동의 판단(가입/초대 게이트 — `tos`·`privacy`만):** `GET /v1/consents`에서 **`tos`·`privacy` 두 타입만** 검사한다 — 각 타입의 `current` 버전이 `accepted`(동일 type+version)에 없으면 미동의 → 동의 UI 표시. `current`엔 `llm_disclosure`도 포함되지만 이 게이트에서 **반드시 제외**한다: `llm_disclosure`는 §6.2 파싱 시 서버가 자동 기록하므로 가입 시점엔 `accepted`에 없고, 포함하면 온보딩이 영구히 "미동의"로 막힌다.

```http
GET /v1/consents       (auth 필요)
→ 200 { "current": { "tos":"...", "privacy":"...", "llm_disclosure":"..." },
        "accepted": [ {"type":"tos","version":"...","accepted_at":"...Z"}, ... ] }
```

- `source` 허용값(클라 지정): `signup` | `invite_accept` | `settings`. `usage_parse`는 **서버 전용**(6.2 자동 기록)이라 POST로 지정 불가 → 스키마 위반 시 422.
- **멱등**: 같은 `(user, type, version)` 재수락은 no-op(중복 행 없음) — 재호출 안전.
- `consents` 배열 1~10건, `version` 1~64자. 미인증 → 403.

### 6.2 외부 LLM 전송 고지 (사용내역 파싱)

`parse`·`parse-image`는 사용자 입력을 **외부 LLM으로 전송**한다. FE는 전송 전 **고지 UI**를 표시하고 사용자 동의를 받아 `disclosure_accepted`를 함께 보낸다.

**⚠️ FE 필수 구현 의무 — 클라이언트 마스킹(§22.4·§26.3)**: 텍스트를 `parse`로 전송하기 **전에 클라이언트에서** 카드번호·**승인번호**를 마스킹한다. PRD는 이 마스킹을 **클라이언트 책임**(전송 전 기기에서 제거)으로 규정하므로 — 서버 재마스킹은 방어층일 뿐 **1차 통제는 FE**다. (이미지 입력은 마스킹 불가 → 학습 미사용·미보존 제공자 전송 + 사용자 고지로 보완.)

**고지 UI 필수 요소**(§22.4·§26·§42.5 근거 — FE 카피에 반드시 포함):
- **무엇을**: 사용내역 텍스트(또는 캡처 이미지) + 해당 여행의 기간·timezone(날짜 보정용 최소 정보).
- **목적**: 지출 초안 추출(정산에 필요한 정보만).
- **보증**: 학습 미사용·미보존 제공자(DPA)로만 전송 · 서버 원문 미로깅 · 민감정보(카드번호·승인번호·전화·이메일·이름 등)는 전송 전 마스킹(카드번호·승인번호는 **FE가 클라이언트에서** — 1차 통제, 그 외는 서버가 방어적으로).

**요청:**
```http
# 텍스트 — disclosure_accepted는 body(반드시 true, 아니면 422)
POST /v1/trips/{tripId}/usage-imports/parse       (auth·멤버)
{ "text":"...", "disclosure_accepted": true, "reference_date":"2026-07-05"? }

# 이미지 — disclosure_accepted는 query(반드시 "true"); reference_date(선택·ISO date)도 query
POST /v1/trips/{tripId}/usage-imports/parse-image?disclosure_accepted=true&reference_date=2026-07-05
(바이너리 image/jpeg|png|webp 바디; openapi 스펙 미포함 plain route — 영수증 업로드와 동일 패턴.
 reference_date 미전달 시 여행 timezone 기준 서버 오늘.)
```

**서버가 자동 기록**: `disclosure_accepted=true` 수신 시 서버가 `llm_disclosure` 동의를 **전송 직전 fail-closed로 기록**(source=`usage_parse`). **FE는 llm_disclosure를 별도 `POST /v1/consents`할 필요가 없다.** 기록이 인프라 장애로 실패하면 파싱이 중단되어 LLM에 전송되지 않는다(PB-1 불변식: "전송분엔 동의 기록이 존재"). `disclosure_accepted`가 true가 아니면 파싱 전 **422**.

**FE UX:**
- **최소**: 매 파싱 요청에 `disclosure_accepted=true`.
- **권장**: `GET /v1/consents`의 `current.llm_disclosure`가 `accepted`에 있으면 재고지를 생략할 수 있다(버전 갱신 시 다시 표시). 전송 고지 자체는 사용자 인지를 위해 표시 유지 권장.

### 6.3 스코프·주의

- 실제 약관·처리방침 **문서 내용**과 버전 문자열 확정은 owner/법무 몫(서버는 버전 문자열만 관리).
- 백엔드는 **기록만** — 미동의 차단(403 게이트)은 FE가 수행.
- 개인정보 **파기·열람**(다운로드/삭제) 경로는 PRD §43 별도 슬라이스(이 계약 밖).
- 제3자(피초대자) 정보 처리 통지·거절/삭제 경로(§42.4)는 초대 UX에서 별도 안내.
