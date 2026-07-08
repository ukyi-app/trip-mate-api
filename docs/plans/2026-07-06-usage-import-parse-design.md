# ⑤ 사용내역 파싱 → 지출 초안 — 상세 설계

상위 설계: `2026-07-06-post-deploy-features-design.md` §⑤. 무상태 MVP — 카드 문자내역 텍스트를 파싱해 지출 **초안 배열을 응답으로만 반환**, FE가 확인/편집 후 기존 `POST /trips/{tripId}/expenses`(또는 preview)로 확정. DB 스키마 변경 없음.

## 파서 방식 결정: (B) LLM 추출

- **(A) 정규식-per-발급사 기각**: 한국 카드 SMS는 발급사·상품·알림채널(문자/앱푸시/카톡)별로 형식이 제각각이고 수시로 바뀜 → 발급사별 규칙 유지보수 비용이 MVP 가치를 초과. 결정성은 얻지만 미지원 형식은 그냥 실패.
- **(B) LLM 채택**: `claude-haiku-4-5` ($1/$5 per MTok) — 요청당 입력 ~1–3K tokens 수준, 건당 비용 무시 가능. structured outputs(json_schema) 지원으로 출력 형태 보증. 형식 다양성에 강건. 지연(~1–3s)은 "붙여넣기→초안 생성" UX에 허용.
- **(C) 하이브리드 기각(현재)**: 포트 뒤에 격리하므로 필요 시 정규식 fast-path를 같은 포트 구현으로 후속 추가 가능. MVP 복잡도만 증가.
- 사람이 초안을 **확인/편집 후 확정**하는 플로우가 전제라 LLM 오추출 리스크는 UX 단계에서 흡수됨(+`confidence` 노출).

## API

`POST /v1/trips/{tripId}/usage-imports/parse` — zod-openapi(`createRoute`), `security: [{cookieAuth}]`, `middleware: [auth, member]`. **preview 라우트 선례**: 무영속이므로 Idempotency-Key 불필요, rate limit(v1w 60/min/IP)·CSRF·422 defaultHook은 /v1 등록만으로 자동.

- 요청: `{ text: z.string().min(1).max(4_000), reference_date: z.iso.date().optional(), disclosure_accepted: z.literal(true) }` — `text`는 붙여넣은 사용내역 원문(여러 건 가능, 4K는 LLM 비용 상한 겸). `reference_date`는 연도 없는 날짜 해석 기준일(FE가 사용자 로컬 오늘 또는 여행 기준일 전달, 미전달 시 **서버 now의 KST 날짜** — 카드 SMS 타임스탬프가 KST이므로 UTC 자정 경계의 하루 밀림 방지) — 서버 타임존/여행 후 임포트로 인한 연도 오염 방지. `disclosure_accepted`는 외부 LLM 전송 고지에 대한 사용자 동의를 FE가 보증하는 계약 필드(true 아니면 422) — 키 오배포로 기능이 켜져도 고지 UI 없는 클라이언트를 계약에서 차단.
- 응답 200: `{ drafts: UsageDraft[] }` — 파싱 불가·지출 없음이면 빈 배열(에러 아님)
- `UsageDraft` (CreateExpense-호환 서브셋 + 파싱 메타):

```ts
{
  title: string,               // 상호명 (1..200)
  local_amount: string,        // 최소단위 정수 string (minorString 규약: /^\d+$/)
  local_currency: string,      // ISO 4217 3글자 (원/₩ → "KRW")
  spent_at: string,            // ISO datetime (연도 없는 SMS는 referenceDate 기준 최근 과거로 해석)
  category?: enum,             // 기존 CATEGORY enum 제안값 (확신 없으면 생략)
  payment_method?: enum,       // 기본 "card"
  card_billed_amount?: string,   // 해외승인 SMS에 병기된 카드 청구/승인 금액(minorString) — 쌍 필수
  card_billed_currency?: string, // 위 금액의 통화(보통 KRW) — 쌍 필수
  confidence: number,          // 0..1 — 필드 해석 불확실성
}
```

- `card_billed_*`는 **정산액으로 단정하지 않는다** — CreateExpense의 `card_billed_settlement_amount`(trip 정산통화 의미)로의 매핑은 trip 정산통화를 아는 FE가 통화 일치 확인 후 수행(비-KRW 정산 여행의 통화 오염 방지, 코드 리뷰 반영).

- 추출 대상은 **승인(지출)만** — 입금·잔액안내 등은 제외. **승인취소/환불은 같은 입력 안의 대응 승인 건과 페어링해 둘 다 제외**(대응 건이 입력에 없는 취소는 무시). 페어링 확신이 없으면 해당 승인 draft를 유지하되 `confidence`를 낮춘다 — 취소 라인을 조용히 버리고 승인만 남기는 것 금지(허위 지출 방지). 프롬프트 계약 + smoke 케이스로 검증.
- 초안 수 상한 **50건** — 초과 시 `UpstreamError`(비정형 출력 취급).
- 에러: 403(비멤버) / 422(요청 검증) / **502(신설 `UpstreamError`)** — LLM 호출 실패·비정형 출력(zod 재검증 실패) / **503(신설 `UnavailableError`)** — 파서 미설정(feature off). `core/errors.ts`에 두 AppError 서브클래스 추가, 둘 다 스펙 errorResponses에 포함.

## 모듈 구조 (port+adapter, receipts 규약)

```
src/modules/usage-imports/
  usage-parser.port.ts       # UsageParseInput { text, referenceDate } / UsageDraft / UsageParserPort { parse(input): Promise<UsageDraft[]> }
  usage-parser.claude.ts     # ClaudeUsageParser implements UsageParserPort + 순수 함수 buildUserPrompt / validateDrafts
  usage-imports.schema.ts    # 요청/응답 zod (OpenAPI 등록명 "UsageParseRequest"/"UsageDraft")
  usage-imports.controller.ts # registerUsageImportRoutes(app, { parser, resolver, memberLookup })
```

- 컨트롤러는 포트만 의존(type-only import). `referenceDate`는 컨트롤러가 서버 현재시각으로 주입(연도 추론용) — 어댑터는 순수 입력만. 연도를 추론한 draft는 `confidence` 하향을 프롬프트로 강제(MVP 한계 — trip 기간 기반 보정은 후속, FE 확인 단계가 최종 방어선).
- service 계층 생략: 무상태·비즈니스 로직 없음 → 컨트롤러가 포트 직접 호출(receipts의 `deps.service` 대응이 `deps.parser`).

## 외부 LLM 트러스트 바운더리 (개인정보)

카드 알림 원문에는 지출 외 정보(마스킹된 카드번호 조각, 누적/잔액, 전화번호, 이름 조각)가 섞일 수 있다. Anthropic API로 전송되는 경계에 대한 최소 방어:

- **`redactSensitive(text)` 순수 함수**를 프롬프트 조립 전에 적용: 카드번호(4-4-4-4, `-`/` `/`.` 구분·연속 12자리+ 숫자/마스킹 런은 fail-closed 마스킹)·카드 끝자리 표기(`카드(1234)`·`끝자리 1234`·`*1234`)·전화번호(모바일·`+82`·유선)·이메일·이름(마스킹 `홍*동님`·비마스킹 `홍길동님`)·승인번호(`승인번호`/`승인No` 라벨 뒤 숫자 — §22.4/§26.3, 라벨 없는 `승인`·거래 금액은 보존)·비거래 금액(누적/잔액/한도/가용 — 파싱 불필요·금액 오독 위험) 치환. 상호명·거래 금액(콤마 동반)·일시는 보존(파싱에 필요). 유닛 테스트로 금지 패턴이 프롬프트에 실리지 않음을 검증. blocklist의 원리적 한계는 disclosure 동의 계약+FE 확인 플로우가 보완.
- **원문 비로깅**: 컨트롤러·어댑터 어디서도 `text`/프롬프트 원문을 로그에 남기지 않는다(onError는 에러 객체만).
- 전송처는 Anthropic API 단일(30일 보존 정책, 학습 미사용).
- **전송 범위(후속 슬라이스1)**: 사용내역 텍스트 + **해당 여행의 기간·timezone**(연도 없는 날짜의 연도 해석·trip-local 날짜 보정용). `disclosure_accepted` 동의가 이 범위를 커버(최소 정보, 카드 텍스트에서 도출 가능).
- **prod 활성화 게이트**: FE의 사용자 고지 UI("파싱 시 텍스트가 외부 LLM으로 전송됨")가 배포되기 전에는 prod에서 파싱 엔진을 활성(env 봉인)하지 않는다(= 라우트 503 유지). 엔진 활성 봉인이 곧 기능 스위치이므로 이 게이트가 기술적으로 강제됨.
- **✅ P-1 블로커(PB-1) 해소(2026-07-08, PR #26)**: 최초 설계 시엔 `disclosure_accepted`를 검증만 했으나, 이제 parse가 외부 LLM 전송 **직전** `llm_disclosure` 동의를 **fail-closed로 영속 기록**한다(`user_consents` + `POST/GET /v1/consents`; `docs/production-blockers.md` PB-1 해소·`docs/contract-consumption.md` §6). 파싱 prod 활성화의 남은 게이트는 FE 고지 UI 배포 → codex 엔진 봉인 → `replicas:1` 롤아웃(전부 owner).

## LLM 어댑터

- **`@anthropic-ai/sdk` 신규 runtime dep** (ofetch 수기 호출 대신): 타입·재시도·structured outputs 표면을 SDK가 보증. 어댑터가 포트 뒤에 있어 교체 비용 없음.
- `client.messages.create({ model: "claude-haiku-4-5", max_tokens: 2048, system, messages, output_config: { format: { type: "json_schema", schema } } })` — JSON schema는 수기 정의(structured outputs는 `minimum/maximum` 등 수치 제약 미지원 → `confidence` 범위는 **응답 후 zod로 재검증**). 클라이언트 `timeout: 30_000`, `maxRetries: 1`(사용자 대면 요청의 재시도 증폭 방지 — 비용·지연 상한).
- 시스템 프롬프트: 역할(한국 카드 SMS/앱푸시 지출 추출기), 승인만 추출 + **취소↔승인 페어링 제외 규칙**, minor unit 변환 규칙+예시(37,900원→"37900" KRW / $12.34→"1234" USD / ¥1,200→"1200" JPY), **해외승인처럼 현지금액+청구금액이 함께 있으면 둘 다 추출**(`card_billed_amount`+`card_billed_currency` 쌍), 연도 없는 날짜는 referenceDate 기준 최근 과거로 해석(미래 금지)하되 **연도 추론 시 confidence 하향**, 불확실하면 confidence 하향.
- 모델 출력 → `JSON.parse` → `validateDrafts`(zod) → 실패 시 `UpstreamError`. 어댑터는 `onError?.(e)` 로깅 후 rethrow(mailer 규약).
- 모델 ID는 어댑터 상수(`claude-haiku-4-5`) — config 비대화 방지, 필요 시 후속에 env 승격.

## 엔진 선택 — Codex CLI 기본 (owner 결정, 2026-07-06)

owner 결정으로 프로덕션 파서 엔진을 **Codex CLI(ChatGPT 구독, 비대화형)**로 운용한다. Claude 어댑터는 코드에 유지(escape hatch — codex 인증 만료/약관 이슈 시 `USAGE_PARSER_ENGINE` 전환만으로 복귀).

- `USAGE_PARSER_ENGINE: "claude" | "codex"` (optional): `codex` → `CodexUsageParser`. 미설정 → 기존 동작(ANTHROPIC_API_KEY 있으면 claude, 없으면 off/503).
- 호출: `codex exec --ephemeral --skip-git-repo-check --ignore-user-config --color never -s read-only -C <빈 tmp dir> --output-schema <schema> -o <out> -` (프롬프트 stdin). **실측(0.142.3)**: 샘플 3건(취소 페어 포함) 7.7s — 취소 페어링·KST→UTC·category 정확.
- **OpenAI strict 스키마 차이**: 모든 키 required + 선택 필드는 null 유니온 → 어댑터가 null 키 제거(`normalizeDrafts`) 후 공용 `validateDrafts` 재검증. 프롬프트·redaction·검증은 claude 어댑터와 공유.
- 타임아웃 60s(spawn timeout), 실패는 exit code만 담아 `UpstreamError`(stderr에 원문 조각 가능성 → 비로깅 규칙 준수).
- **수용 리스크(owner 승인)**: ① 구독 OAuth(auth.json)를 파드에 반입 — 토큰 갱신 실패 시 502, 재로그인·재봉인 필요 ② 개인 구독의 서버 자동화 사용은 약관 회색지대 ③ **프롬프트 인젝션 표면 — 배포 컨테이너에서 구조적 소거(실측)**. codex는 셸 도구를 가진 에이전트지만, **배포 이미지(Alpine musl)에 `bubblewrap`(bwrap)이 없다 → Linux read-only 샌드박스가 어떤 셸 명령도 실행하지 못하고 fail-closed**(컨테이너 실측: `no system bwrap was found on PATH`로 명령 시작 자체 실패 → 밖 파일·cwd 파일·auth.json 읽기 전부 불가). **파싱은 셸 도구 불필요** → 동일 컨테이너에서 정상 동작 실측(초안 정확). 즉 "파일 읽기 인젝션" 벡터가 파드에서 원천 차단된다(프롬프트 문구가 아니라 플랫폼 강제). ⚠️ **이미지에 bwrap을 설치하지 말 것**(설치 시 셸 도구가 활성화됨 — 의도된 통제). 이 불변식은 **부팅에서 강제**(`assertCodexToolsDisabled` — PATH에 bwrap 있으면 fail-closed로 부팅 중단)돼 우연이 아닌 통제가 된다. macOS(seatbelt)는 반대로 읽기 허용하므로 로컬 개발과 파드 동작이 다름을 유의. 코드 계층 완화도 유지(이중): **spawn env allowlist**(`buildCodexEnv` — 앱 시크릿 env 비상속) + `-c shell_environment_policy.inherit=core` + 빈 tmp cwd + 도구 금지 프롬프트 + output-schema + redaction.
④ 지연 ~8s(API 1–3s 대비) ⑤ **동시 실행 상한 2**(어댑터 세마포어) — 초과분 즉시 503 "parser busy"(60s 프로세스 × 무제한 스폰의 파드(256Mi) 고갈 방지).

## 배포 (owner) — 검증 완료, 차트 변경 불요

플랫폼(공유 차트) 제약: `.app-config.yml`은 고정 스키마(`additionalProperties:false`)라 임의 볼륨·파일 시크릿 마운트를 선언할 수 없고, 시크릿은 **envFrom(env 키)로만** 주입된다. 이에 맞춘 배선:

- **codex 바이너리**: Dockerfile에서 musl 릴리스 직설치(이미지 read-only·non-root 65532 실측). bwrap 미설치 = 셸 도구 비활성 통제.
- **CODEX_HOME(auth.json)**: 파일 시크릿 볼륨이 없으므로 **auth.json 원문을 sealed env `USAGE_PARSER_CODEX_AUTH`로 받아, 부팅 시 앱이 writable dir(`/tmp`)에 0600으로 seed**(`seedCodexHome` — 기존 파일 있으면 보존해 제자리 refresh분 미덮어쓰기) 후 `process.env.CODEX_HOME` 지정. writable `/tmp`는 **공유 차트가 이미 emptyDir로 마운트**(deployment.yaml) → 추가 볼륨 불요. materialize된 파일은 codex만 읽고(이미지에 bwrap 없어 셸 파일읽기 불가), `USAGE_PARSER_CODEX_AUTH` env는 allowlist에서 제외돼 codex 서브프로세스에 비상속.
- **활성화 절차**: `.env`에 `USAGE_PARSER_ENGINE=codex` + `USAGE_PARSER_CODEX_AUTH=<auth.json 1줄>` 넣고 `bun run secret:seal` → sealed 커밋 → homelab bump-poll. (FE 고지 UI 배포 후.)
- **동시성·토큰 리프레시**: **동시 실행 1(직렬화, in-process)** — 2번째 동시 요청은 즉시 503 + **Retry-After: 5**(백프레셔, FE 백오프). cwd(-C)는 auth-free temp이나 **CODEX_HOME은 seed dir 그대로 사용**해 codex가 제자리 토큰 리프레시를 영속(refresh token rotation 시 seed 무효화 방지). 직렬화가 공유 auth.json 동시 write torn을 막는다.
- **⚠️ codex 엔진 = 단일 replica 운영 불변식(owner, 강제 필요)**: in-process 직렬화(MAX_CONCURRENT 1)는 **한 파드 안에서만** 유효하다. 하나의 개인 구독 OAuth를 여러 파드가 각자 seed에서 리프레시하면 rotation 시 크로스-파드로 seed가 무효화될 수 있다(분산 락으로도 근본 해결 불가 — 단일 자격증명이라 공유 토큰 스토리지가 필요). 앱 레포 코드로는 강제 불가(앱 전체 가용성에 영향) → **배포 시 owner가 강제**:
  - `.app-config.yml` `replicas: 1` (codex 엔진 활성 시 — 앱 전체가 단일 replica가 되는 가용성 트레이드오프 수용).
  - **롤아웃 no-overlap**: 롤링 배포의 파드 겹침 구간에도 두 codex가 같은 seed를 리프레시 → `Recreate` 전략 또는 `maxSurge:0`로 겹침 제거(차트 strategy override).
  - 개인 구독은 애초에 수평 확장 불가(계정 rate limit·토큰 rotation 공유). **수평 확장·고가용이 필요하면 claude 엔진(API 키)이 정답**(무상태·멀티-replica 안전). 이 트레이드오프가 codex(구독 절약) vs claude(확장·격리)의 본질 — 스케일 요구 시 엔진 전환이 올바른 선택.
- **테넌트 공정성 한계(수용)**: 단일 슬롯이라 한 유저의 파싱(≤60s, 통상 ~8s)이 그 파드의 다른 파싱을 잠깐 막을 수 있음(Retry-After로 백오프). 대규모 동시 파싱이 필요한 스케일이면 claude 엔진 권장. 라우트는 기존 쓰기 rate-limit(60/min/IP)도 적용.
- **잔여/운영 수용**: `/tmp`는 ephemeral → codex 토큰 리프레시분은 파드 재시작 시 소실, 다음 부팅이 sealed env에서 재생성(refresh_token 유효 동안 OK). 구독 토큰이 만료·회전 실패하면 502 → 재로그인·재봉인. codex 계정은 보조 계정 권장. `automountServiceAccountToken:false`는 **공유 차트 기본값으로 확인됨**(values.yaml).
- **e2e 검증(실측)**: 파드 모사 컨테이너(`--read-only --tmpfs /tmp` -u 65532, auth=env)에서 env→materialize→실 codex 파싱까지 정확한 초안 반환 확인.

### 런북: codex 토큰 만료 → 재로그인·재배포 (owner)

codex 구독 토큰이 만료되거나 refresh가 실패해 파싱이 502가 지속되면(로그 `usage parse failed`), auth.json을 재발급해 재봉인한다. seed env가 SSOT이므로 **파드가 아니라 봉인 소스를 갱신**한다.

```sh
# 1) 로컬(owner 머신)에서 재로그인 — ~/.codex/auth.json을 새 토큰으로 갱신(브라우저 OAuth)
codex login                      # 만료 꼬임 시 codex logout 후 codex login
codex login status               # "Logged in using ChatGPT" 확인

# 2) 새 auth.json 원문을 봉인 소스에 반영(값은 셸/에디터로만 — 채팅·로그 금지)
#    .env에 USAGE_PARSER_CODEX_AUTH=<~/.codex/auth.json 1줄> 갱신 후:
bun run secret:seal              # deploy/…sealed.yaml 재생성

# 3) sealed 커밋 → homelab bump-poll이 반영 → 파드 롤(재시작 시 /tmp emptyDir 비고 새 seed로 재materialize)
```

- **주의**: `/tmp`는 ephemeral이라 파드 재시작만으로는 낡은 토큰이 되살아나지 않는다(재시작 시 새 seed에서 씀). 문제는 **봉인된 seed 자체가 만료**된 경우이므로 반드시 (2)의 재봉인이 필요하다.
- **단일 replica·no-overlap 롤아웃**(아래) 하에서는 롤 도중 토큰 경쟁이 없다. 재봉인 후 새 파드가 새 토큰으로 뜬다.
- refresh token rotation으로 seed가 조기 무효화되면 같은 절차를 반복(빈도가 잦으면 claude 엔진 전환 검토).
- 배포(owner): 이미지에 codex musl 바이너리 설치(Dockerfile), 파드에 `CODEX_HOME`(auth.json secret + writable emptyDir)·writable `/tmp` 마운트.

## config / graceful off (라우트 상시 등록 + 503)

- `src/core/config.ts`: `ANTHROPIC_API_KEY: z.string().optional()` (+ `.env.example` 주석 라인).
- `src/main.ts`: 키 있으면 `new ClaudeUsageParser(key, { onError: logger.warn })` 생성, `buildV1App({ ...(usageParser ? { usageParser } : {}) })` (조건부 spread — exactOptionalPropertyTypes).
- `src/app.ts`: `V1Deps.usageParser?: UsageParserPort` — **라우트는 항상 등록**, 핸들러가 parser 미주입 시 `UnavailableError`(503) throw. 스펙-런타임 불일치 제거(미등록 404는 계약과 어긋남), openapi-gen도 stub 없이 자연 포함.

## 테스트 (TDD)

1. **순수 유닛** `usage-parser.claude.test.ts`: `buildUserPrompt`(text·referenceDate 포함 여부), `redactSensitive`(카드번호 조각·전화·이메일 마스킹, 상호·금액 보존), `validateDrafts`(정상 배열 통과 / JSON 아님·배열 아님·minorString 위반·confidence 범위 밖·50건 초과 → 실패). 샘플 SMS 픽스처(KB·신한·현대·해외승인 등)는 프롬프트 스냅샷 겸용.
2. **라우트 유닛** `usage-imports.controller.test.ts` (fake 포트, DB 없음 — receipts.controller.test 패턴): 200+초안 배열·포트에 text/referenceDate 전달 / 빈 text 422 / 4K 초과 422 / 비멤버 403 / 포트 throw(UpstreamError) → 502 problem+json / parser 미주입 → 503.
3. **opt-in 계약 smoke** `usage-parser.claude.smoke.test.ts`: `ANTHROPIC_API_KEY` 있을 때만(`describe.skipIf`) 실 SMS 2–3건 → 필드 sanity + **승인+취소 페어 → 제외** 케이스.

## 구현 순서

1. `UpstreamError`(502)·`UnavailableError`(503) + config 키 (RED→GREEN 최소)
2. 포트/스키마 + 순수 함수(redact·prompt·validate) TDD
3. 컨트롤러 TDD (fake 포트, 503 포함)
4. Claude 어댑터 + main/app 배선
5. `bun run check` + `bun run test` 무회귀 → gen:openapi 재생성 → PR

## 후속(비-MVP, 명시적 제외)

- trip 기간/타임존 기반 날짜 보정, 파서 전용 쿼터·동시성 제한·비용 메트릭, 사용자 단 LLM 전송 고지 UI, 파일(이미지·CSV) 입력, `expense_drafts` 스테이징 테이블.
