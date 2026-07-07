# PB-1 서버측 동의 캡처 — 설계

- 날짜: 2026-07-07
- 상태: 승인됨(brainstorming) → writing-plans로 구현 계획 예정
- 관련: [[production-blockers]] PB-1 · [[trip-mate-prd]] §42(개인정보·약관·동의)·§43(보존·삭제) · [[usage-import-parse-design]] §외부 LLM 트러스트 바운더리·§배포

## 1. 배경·목표

`docs/production-blockers.md` **PB-1(P-1)** — 서버측 동의(약관·개인정보) 캡처 부재가 유일한 P-1 프로덕션 블로커다. ⑤ 사용내역 파싱을 프로덕션에서 켜기 위한 **활성화 게이트의 전제**다.

현재 갭:
- 가입(최초 Google 로그인)·초대 수락 동의를 **영속 기록하는 서버측 저장소가 없음**(누가·언제·어느 약관 버전에 동의했는지 감사 불가).
- 사용내역 파싱의 `disclosure_accepted: true`(외부 LLM 전송 고지 동의)는 요청에서 **검증만 하고 기록하지 않음**.

이 슬라이스의 목표: **최소 충족**으로 위 두 갭을 닫는다 — `user_consents` 영속 테이블 + `consents` 모듈(전용 엔드포인트) + parse 파이프라인의 `llm_disclosure` 기록 배선. PB-1의 핵심 불변식은 **"외부 LLM에 전송된 데이터에는 동의 기록이 존재한다"**이다.

## 2. 확정된 결정 (AskUserQuestion 잠금)

1. **동의 포착 = 전용 엔드포인트(명시적 accept)**. 자동 훅 기록 아님. Google OAuth 가입엔 폼 동의 이벤트가 없으므로, FE가 약관 표시 후 사용자가 "동의" 클릭 → `POST /v1/consents`가 서버 기록. 초대 수락자도 이미 로그인된 유저라 동일 경로(별도 Better Auth 훅 불요, `source` 필드로 시점 구분).
2. **강제 = 기록만(FE 게이트)**. 백엔드 차단 미들웨어 없음(403 게이트 아님). PB-1 요구는 "기록"이므로 최소 충족·슬라이스 집중.
3. **`llm_disclosure` = 일회성 동의(버전별)**. parse마다 기록 아님. 버전별 1회 upsert(멱등), 버전 변경 시 재기록.
4. **parse의 `llm_disclosure` 기록 = fail-closed**. 기록이 인프라 장애로 실패하면 파싱을 중단(에러 반환)하고 LLM에 전송하지 않는다. `recordDisclosure`는 usage-imports의 **필수 dep**으로 배선해 타입 레벨에서 강제한다.

## 3. 스키마 — `user_consents`

`src/db/schema/consents.ts` (배럴 `index.ts`에 `export * from "./consents.ts"` 추가). Better Auth `user.id`는 **text**임에 주의(uuid 아님).

| 컬럼 | 타입 | 비고 |
| --- | --- | --- |
| `id` | `pk()`(uuid, defaultRandom) | 레코드 PK |
| `user_id` | `text` FK → `user.id` `onDelete: "cascade"` | 사용자 삭제 시 동의 기록도 삭제 |
| `consent_type` | `text` | `tos` \| `privacy` \| `llm_disclosure` |
| `document_version` | `text` | 서버 소유 문서 버전 문자열 |
| `source` | `text` | `signup` \| `invite_accept` \| `usage_parse` \| `settings` |
| `accepted_at` | `timestamptz` default `now()` | 불변 이벤트 시각 |
| `ip` | `text?` | 감사용, nullable(best-effort) |

제약:
- CHECK: `consent_type IN ('tos','privacy','llm_disclosure')`, `source IN ('signup','invite_accept','usage_parse','settings')` (승인 설계 = text + CHECK. repo `enums.ts` pgEnum 관례와의 조율은 구현 계획에서).
- **`uniqueIndex uq_user_consent (user_id, consent_type, document_version)`** → 일회성-per-version 멱등의 근거. 재수락 = `ON CONFLICT (user_id, consent_type, document_version) DO NOTHING` no-op.
- `updated_at` 생략(불변 append-only 이벤트). `_shared.timestamps`(created/updated 쌍) 대신 `accepted_at`만 정의.
- 조회 인덱스: `uq_user_consent`가 `(user_id, ...)` prefix라 GET의 user별 조회를 커버(별도 인덱스 불요).

## 4. 버전 정책

서버 소유 config 상수:

```ts
// src/modules/consents/consents.config.ts
export const CONSENT_VERSIONS = {
  tos: "2026-07-07",
  privacy: "2026-07-07",
  llm_disclosure: "2026-07-07",
} as const; // placeholder — 실 약관/처리방침 문서 확정 시 owner가 갱신
```

- FE가 보낸 `version`이 서버 `CONSENT_VERSIONS[type]`과 다르면 **409 ConflictError(stale)** — FE가 항상 최신 문서를 표시하도록 강제.
- `CONSENT_VERSIONS[type]` 인덱싱은 `type: keyof typeof CONSENT_VERSIONS`로 좁혀 `noUncheckedIndexedAccess`의 `| undefined` 회피.

## 5. 모듈 구조

`src/modules/consents/` — 기존 모듈(expense-drafts 등) 레이아웃 미러:

- `consents.config.ts` — `CONSENT_VERSIONS`.
- `consents.schema.ts` — zod: `consentTypeEnum`, `sourceEnum`, `postConsentsRequestSchema`(`{ consents: [{type, version}], source }`), `consentRecordSchema`, `getConsentsResponseSchema`(`{ current, accepted }`). 응답 enum은 zod-openapi 관례상 명시 검증.
- `consents.repo.ts` — Drizzle 어댑터. `insertMany(rows) → ON CONFLICT DO NOTHING`(멱등), `listByUser(userId) → 기록 배열`. testcontainer 대상.
- `consents.service.ts` — `ConsentService`: `record(userId, {consents, source, ip?})`(버전 검증→409, 멱등 삽입), `recordDisclosure(userId, {ip?})`(source=`usage_parse`, current `llm_disclosure` 버전 1건 멱등), `list(userId) → {current, accepted}`.
- `consents.controller.ts` — `registerConsentRoutes(app, { service, resolver })`. `requireAuth` 가드. IP는 `clientIp(c.req.raw.headers)`(core/rate-limit) 재사용.

`ConsentService`는 DB만 있으면 항상 배선 가능 → composition root(`main.ts`)에서 **항상 생성**(expense-drafts 패턴). `recordDisclosure`는 usage-imports에 **필수 dep**으로 주입 → fail-closed by construction.

## 6. 엔드포인트

### POST /v1/consents (auth, openapi)

- 요청: `{ consents: [{ type: consent_type, version: string }], source }`. tos+privacy batch 수락 가능.
- 처리: 각 항목 `version === CONSENT_VERSIONS[type]` 검증(불일치 시 **409 ConflictError**, meta에 `{type, expected}`) → 멱등 삽입(`ON CONFLICT DO NOTHING`) → 기록분 반환.
- 응답 200: `{ recorded: [{ type, version, accepted_at }] }`.
- 에러: 409(stale), 422(스키마), 401(미인증, requireAuth).

### GET /v1/consents (auth, openapi)

- 응답 200: `{ current: { tos, privacy, llm_disclosure }, accepted: [{ type, version, accepted_at }] }` — FE가 미동의 판단(current에 대응하는 accepted 없으면 미동의).
- 에러: 401.

## 7. parse 배선 (⑤의 구체적 PB-1 조건)

공용 `runParsePipeline`(`usage-imports.controller.ts`)에 기록 지점을 추가한다. text 라우트는 `disclosure_accepted`를 스키마(`z.literal(true)`)로, image 라우트는 쿼리 명시 체크로 **파이프라인 진입 전** 검증하므로, 파이프라인 내부는 "동의됨"이 보장된 상태다.

- `Deps`에 `recordDisclosure: (userId: string, opts?: { ip?: string }) => Promise<void>` **필수** 추가.
- `runParsePipeline` args에 `ip?: string` 추가. 두 컨트롤러 핸들러가 `const ip = clientIp(c.req.raw.headers) || undefined`로 추출해 전달.
- **기록 지점**: 쿼터 통과 후 · `run()`(LLM 전송) **직전**.
  ```
  1) quotaCheck (있으면) → 초과 시 429
  2) recordDisclosure(userId, ip ? { ip } : {})   ← NEW, fail-closed(throw 시 파싱 중단)
  3) run() (LLM)
  4) clampOutOfWindowConfidence
  5) persistDrafts
  ```
  쿼터 통과 후에 두는 이유: 기록을 "곧 전송한다"에 최밀착시키고 남용 요청은 쿼터가 먼저 게이팅. busy(UnavailableError)로 3)이 실패해도 2)는 이미 멱등 기록되어 무해(전송은 없음). (쿼터 앞 배치도 멱등이라 실질 차이 없음 — 최소 결합 선택.)
- **fail-closed**: `recordDisclosure`는 `try/catch`로 감싸지 않는다 — 인프라 장애(DB 다운)로 throw하면 파이프라인 전체가 중단되어 LLM에 전송되지 않는다.
- IP는 감사용 nullable이므로 **부재는 실패가 아님**(빈 문자열→`undefined`). `exactOptionalPropertyTypes` 준수 위해 `ip` 조건부 스프레드(`ip ? { ip } : {}`).
- app.ts: `recordDisclosure`는 `usageParser` 유무와 무관하게 **항상** 주입(parser off여도 dep은 배선 — 라우트가 503으로 먼저 끊김). `registerUsageImportRoutes(v1, { ..., recordDisclosure: consentService.recordDisclosure })`.

## 8. 데이터 플로우

**가입/초대 수락(FE 주도):** Google 로그인/초대 수락 완료(로그인 세션 확보) → FE가 약관·처리방침 표시 → 사용자 "동의" → `POST /v1/consents { consents:[{tos,v},{privacy,v}], source }` → 서버 멱등 기록.

**사용내역 파싱:** FE가 고지 UI 표시·`disclosure_accepted=true` 동반 요청 → 라우트가 동의 검증 → `runParsePipeline` → (쿼터) → **`recordDisclosure`(fail-closed)** → LLM 전송 → 초안 저장.

## 9. 에러 처리

- 버전 stale → **409 `ConflictError`**(기존 타입 재사용, problem+json title "ConflictError").
- 스키마 위반 → 422(defaultHook).
- 미인증 → 401(requireAuth).
- parse `recordDisclosure` 실패 → 파싱 중단(전파). LLM 전송 없음. (일반 500/503으로 표면화 — 인프라 장애.)

## 10. 테스트 계획

- **repo**(testcontainer): 삽입 · 멱등 재수락 no-op(같은 user·type·version 2회 → 1행) · unique 제약.
- **service**: `record` 멱등 · 버전 불일치 409 · `list`(current/accepted 구성) · `recordDisclosure`(source=usage_parse·current llm_disclosure 버전·멱등).
- **controller**: `POST`/`GET` · auth(미인증 401) · 409 stale · batch(tos+privacy).
- **parse**: `disclosure_accepted` 수신 시 `llm_disclosure` 기록됨(버전·source 검증) · **fail-closed**(recordDisclosure throw → 파싱 중단·LLM 미호출) · IP 전달(있을 때/없을 때).

## 11. 스코프 밖 (명시)

- 실 약관·개인정보 처리방침 **문서 내용**(owner 결정, 버전 문자열만 관리).
- 백엔드 403 게이트(기록만 결정).
- parse별 전송 activity 로그(일회성 결정 — 버전별 1회만 기록).
- 파기·열람 요청 처리 경로(PRD §43, 별도 슬라이스).

## 12. 활성화 게이트 연동

이 슬라이스 완료 = PB-1 해소(최소). 이후 파싱 프로덕션 활성화 임계경로: **PB-1(이 슬라이스) → FE 고지 UI → codex 엔진 봉인(`USAGE_PARSER_ENGINE=codex` + `USAGE_PARSER_CODEX_AUTH` sealed) → `replicas:1` + no-overlap 롤아웃**(codex=단일 replica 불변식). 이 설계는 그중 `llm_disclosure` 동의 기록 조건을 충족한다.

## 13. 참조

- `docs/production-blockers.md`(PB-1 요구·활성화 게이트).
- `docs/trip-mate-prd.md` §42·§43.
- `docs/plans/2026-07-06-usage-import-parse-design.md`(§외부 LLM 트러스트 바운더리·§배포·§런북).
- 통합 지점: `src/db/schema/{auth-schema,_shared,index}.ts` · `src/core/{errors,rate-limit,guards,http}.ts` · `src/modules/usage-imports/usage-imports.controller.ts` · `src/app.ts`(V1Deps·buildV1App) · `src/main.ts`(composition root).
