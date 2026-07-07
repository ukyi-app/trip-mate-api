# ⑤ 사용내역 파싱 후속 — 날짜 보정 · 쿼터/메트릭 · expense_drafts · 이미지 입력

상위: `2026-07-06-usage-import-parse-design.md`(무상태 MVP). 그 위에 얹는 4개 슬라이스. 의존 순서대로 각각 TDD→codex 리뷰→PR. graceful-off·strict TS·PII redaction·PB-1(동의 캡처) prod 게이트 유지. **CSV 입력은 제외(사용자 결정, 저활용)**.

## 슬라이스 1 — 여행 기간/타임존 날짜 보정

**gap**: parse가 `referenceDate = reference_date ?? KST(now)` 단일 날짜만 파서에 전달, trip 실제 timezone·기간 미사용 → 서버 타임존·연말 경계에서 연도 오염.

- 라우트에 `tripContext(tripId) → {timezone, start_date, end_date} | null` 조회 dep 주입(trips repo 재사용, memberLookup과 동형).
- `UsageParseInput`에 `tripTimezone?`·`tripStart?`·`tripEnd?` 추가. `buildUserPrompt`가 여행 기간을 프롬프트에 명시.
- 프롬프트 규칙: 연도 없는 날짜는 **여행 기간 내로 해석**, 기간 밖이면 **유지하되 confidence 하향**(거부 아님 — FE 확인이 최종 방어). referenceDate 기본값도 서버 KST → **trip timezone 기준 오늘**.
- claude·codex 어댑터 공유(`SYSTEM_PROMPT`/`buildUserPrompt`)라 한 곳 수정.
- **결정적 후검증(codex 리뷰 반영)**: LLM 출력을 신뢰하지 않고, 파싱 후 `clampOutOfWindowConfidence`(순수)가 각 초안의 여행-로컬 날짜를 계산해 여행 기간 밖이면 confidence를 강제 하향(≤0.3). 거부 아님 — FE 확인·여행 전 예약 등 정당 경계 케이스 보존. 모델 드리프트·프롬프트 인젝션 방어.
- **시각 해석 결정(codex 리뷰)**: 사용내역의 날짜·시각은 **여행 timezone 기준(trip-local)**으로 해석한다. 카드 이슈어 클럭(KST)이 아니라 trip-local을 택한 이유 = 사용자가 붙여넣은 날짜(예 08/02)를 그대로 지출 날짜로 원하며, KST 해석은 서쪽 여행에서 하루 밀린다(사용자 의도 우선). 명시 시각의 UTC instant 정밀도는 근사이며 confidence·clamp·FE 확인이 방어층. 연도 없는 날짜는 여행 기간 우선 → 없으면 referenceDate 기준 과거(우선순위 명시로 미래-금지 규칙과의 충돌 해소).
- **동의 경계(codex 리뷰)**: 프롬프트에 여행 기간·timezone이 포함되므로 `disclosure_accepted`의 계약 범위를 "사용내역 텍스트 + 여행 기간·timezone 전송 동의"로 명문화(스키마 주석·[[usage-import-parse-design]] §트러스트 바운더리). 최소 정보이며 이미 동의된 카드 텍스트에서 도출 가능.
- 테스트: 프롬프트에 기간·timezone 포함·우선순위(순수), 라우트 tripContext 조회·전달·기간밖 clamp(fake), `clampOutOfWindowConfidence` 순수(westward tz·연말연시), 실 codex smoke(NY date-only·연말연시 교차).

## 슬라이스 2 — 파서 쿼터 + 메트릭

**쿼터**: parse 전용 per-user·per-trip Redis 고정윈도우(기존 `core/rate-limit.ts` Lua INCR+EXPIRE 재사용). 키 `pq:u:{userId}`·`pq:t:{tripId}`, 상한 상수(user 20/시간·trip 60/일, 튜너블). 초과 → 429 + Retry-After. 인증 주체 기반(IP 기반 기존 rate-limit보다 정밀). parse 라우트에만 미들웨어로 적용.

**메트릭**: 무의존 Prometheus 텍스트 포맷(hand-rolled registry, 새 dep 없음). `usage_parse_requests_total{engine,status}`·`usage_parse_errors_total{type}`·`usage_parse_duration_seconds`(히스토그램). `GET /metrics`로 노출(우선 메인 8080 포트). chart 전용 메트릭 포트(9090) scrape 배선은 owner 후속(문서화).

- 테스트: 쿼터(Redis testcontainer, 원자 all-or-nothing·refund), 메트릭 registry·`/metrics` 포맷, 라우트(빈text 422·busy 503·쿼터 429 미소모 등).
- **쿼터 흐름(codex 리뷰 수렴)**: context·quota는 **슬롯 없이 먼저** → parse가 동시성 자기보호(busy=UnavailableError) → 슬롯은 parse 실행 동안만(느린 I/O가 슬롯 미보유·false busy 방지). busy·미착수(codex spawn 실패)는 UnavailableError→**쿼터 환불**, LLM 착수 후 실패(UpstreamError)는 소모 유지. 지연은 성공·실패 모두 기록.
- **⚠️ 잔여 한계(수용)**: codex는 "remote 호출을 실제로 했는지" 신호를 안 줘서 non-zero exit(auth 만료·config 오류 등 미착수 가능성)이 UpstreamError로 소모된다. 영향은 **codex outage 한정**(그때 기능은 어차피 전면 다운)·**window 내 제한**(복구 후 유저는 ≤1시간, trip ≤1일 대기). 깨끗한 분류는 codex 신호 부재로 비례 초과 → 한계로 수용. 엔진이 API(claude, per-call 과금)로 바뀌면 이 보수적 소모가 오히려 비용 방어에 맞음.
- **메트릭 prod 활성(owner)**: `/metrics`는 공개 호스트가 아니라 **내부 포트(METRICS_PORT=9090)**에만, `METRICS_ENABLED=true`일 때만 바인딩(기본 off). 실 scrape엔 **둘 다** 필요: (1) `.app-config.yml` `metrics.enabled: true`(차트가 9090 서비스포트+prometheus scrape annotation 추가) + (2) `METRICS_ENABLED=true` 봉인(앱이 9090 바인딩). 포트는 9090으로 정렬됨.

## 슬라이스 3 — expense_drafts (지속형 초안)

무상태 MVP 위에 **지속 계층** 추가(무상태 경로는 유지). 파싱 초안을 저장 → 나중에 검토/편집 → 확정 시 기존 지출 생성 재사용.

- **테이블 `expense_drafts`**(마이그레이션): `id uuid pk`, `trip_id uuid fk`, `created_by_member_id uuid fk`, `source text`(text|image), `status text`(pending|confirmed|discarded), 파싱필드(`title`·`local_amount`·`local_currency`·`spent_at`·`category`·`payment_method`·`card_billed_amount`·`card_billed_currency`·`confidence`) — jsonb `payload` 한 컬럼으로, `confirmed_expense_id uuid null fk`, `source_object_key text null`(이미지 원본, ④ files), `created_at`·`updated_at`·`deleted_at`.
- **흐름**: parse가 초안 batch insert 후 id 포함 반환. 신규 라우트(모두 auth+member):
  - `GET /v1/trips/{tripId}/expense-drafts` — pending 목록(멤버 스코프, trip 스코핑).
  - `PATCH .../expense-drafts/{id}` — 확정 전 payload 필드 편집(version CAS 선택).
  - `POST .../expense-drafts/{id}/confirm` — 초안 payload + 사용자 완성필드(`paid_by_member_id`·`participant_member_ids`·기타) → `CreateExpense` 조립 → **기존 `ExpensesService.createExpense` 재사용** → 초안 `confirmed`·`confirmed_expense_id` 링크(단일 tx). Idempotency-Key 지원.
  - `DELETE .../expense-drafts/{id}` — discard(soft delete).
- **핵심**: 초안은 CreateExpense **부분집합**(파싱이 모르는 결제자·참여자는 confirm 때 사용자 입력). 동시 confirm·중복 방지(status 가드).
- 테스트: repo(testcontainer)·서비스(fake)·라우트, confirm이 createExpense 재사용·초안 소비·재confirm 방지.

## 슬라이스 4 — 이미지 입력 (codex vision)

- **이미지**: `codex exec -i <image>`로 동일 프롬프트/스키마 → 초안(슬라이스 3에 저장). `POST /v1/trips/{tripId}/usage-imports/parse-image`(바이너리 body). ④ 영수증 하드닝 재사용: **타입 allowlist(415)**(image/jpeg·png·webp·heic)·크기 제한(422)·원본을 ④ FilesClient로 저장(bucket trip-mate, key `usage-imports/{tripId}/{uuid}`) → 초안 `source_object_key` 링크.
- `UsageParserPort`에 `parseImage?(input, image: {bytes, contentType})` 선택 메서드 추가. codex 어댑터 구현(임시파일 write→`-i`), claude 어댑터는 vision content block(escape hatch). CSV 제외이므로 텍스트+이미지 2모달.
- 모달리티별 **별도 라우트**(content-type 분기보다 계약 명확).
- 테스트: 이미지 라우트(fake vision 파서 주입·타입 allowlist 415·크기 422), codex parseImage 실 smoke(opt-in).

## 순서·공통

1. 슬라이스 1(날짜 보정) → 2(쿼터/메트릭) → 3(expense_drafts) → 4(이미지). 각 TDD(RED→GREEN)→`bun run check`+`test` 무회귀→codex 적대적 리뷰→한국어 conventional PR→squash 머지.
2. 슬라이스 3이 데이터 모델 최대 변경(마이그레이션·introspection 가드 주의 — 기존 cascade 함정 [[trip-mate-api-slice-progress]] F12 참조).
3. prod 활성화는 PB-1·파서 엔진 봉인 전제 유지(이 후속들도 파서 config-off 시 graceful).

## 슬라이스 3 — 구현·적대적 리뷰 잔여(2026-07-07)

expense_drafts 구현 후 codex 적대적 리뷰를 다회 반복하며 confirm 사가·parse 지속의 정합성·부분실패·동시성·멱등성을 경화. **닫은 이슈(코드+테스트):**

- **소유자 스코프**: 초안은 가져온 멤버의 개인 큐 — 모든 조회/변경이 `(trip_id, created_by_member_id)` 스코프(프라이버시 + 교차-멤버 중복 확정 차단).
- **stale payload**: `claimForConfirm`이 pending→confirmed 원자 전이 시 **커밋 payload를 RETURNING**으로 원자 반환 → 선행 PATCH와의 stale 창 제거.
- **확정 body 바인딩**: claim 시점에 `confirm_payload` 컬럼에 확정 body를 원자 바인딩 → 복구·경합에서 항상 최초 claim한 body만 사용(동시 다른 body가 지출을 뒤엎지 못함).
- **중복 지출 방지**: confirm은 `draft:<id>` 멱등키로 createExpense 재사용. **롤백 전 지출 존재 증명**(`findExpenseIdByKey`) — 동시 생성분이 있으면 롤백 대신 링크. 롤백은 **모든 시도가 정의적 도메인 실패(AppError)** 일 때만(애매한 인프라 실패는 커밋 가능성 → confirmed-미링크 유지, 재-confirm 복구).
- **멱등 리플레이**: 확정+링크된 초안 재확정은 재생성 없이 기존 결과 반환. confirmed-미링크(부분 실패 잔여)는 목록에 노출돼 재-confirm으로 복구.
- **멱등키 네임스페이스**: `draft:` 프리픽스는 **서버 전용** — idempotency 미들웨어가 클라 키의 이 프리픽스를 거부(클라가 지출 선점→오링크 차단).
- **parse 지속 멱등**: parse가 초안을 저장하므로 Idempotency-Key를 `import_key`로 전달. **advisory xact lock + import_key**로 데이터-레벨 원자 replay(미들웨어 부재/크래시-갭에도 배치 중복 방지). discard된 배치는 재시도가 부활시키지 않음(키 존재를 삭제 포함으로 판정).
- **상태전이 가드**: `setConfirmedExpense`는 confirmed·미삭제 행만 링크(pending+링크 유령행 방지). `softDelete`는 링크된 초안 삭제 불가. `updatePayload`는 pending만.
- **스키마 정합**: confirm 스키마에 `card_billed`↔`manualRate` 상호배제 refine(지출 생성과 동일). 라우트 무조건 등록(openapi 스펙-런타임 일치).

**잔여(설계 결정·활성화 시 확정 — PB-1 게이트 하에서 prod 미노출):**

1. **card_billed 신뢰 경계(FF)**: confirm의 `card_billed_settlement_amount`는 **기존 `POST /v1/…/expenses`와 동일**하게 FE가 trip 정산통화 일치를 보증하는 신뢰 모델(설계 §card_billed). 초안 흐름은 파싱된 `card_billed_currency`를 알므로 서버측 통화 일치 검증을 **추가 강화**할 수 있음(두 엔드포인트 공통 개선 후보). 슬라이스 고유 회귀는 아님.
2. **parse 멱등 opt-in(GG)**: Idempotency-Key는 opt-in(지출 생성과 동일 관례). 없으면 재시도가 중복 초안 배치를 만들 수 있음. 활성화 시 FE 계약에서 키 필수화 또는 서버 파생 키(user+trip+text hash)를 확정.
3. **import_key body-safety(EE)**: 데이터-레벨 replay 마커는 body-hash·TTL 미보유. prod에선 미들웨어(24h TTL·body-hash·single-flight)가 커버. 24h 초과 키 재사용(클라 계약 위반)은 stale 반환 가능 — request-hash 컬럼은 활성화 시 FE 키 계약과 함께 확정.
4. **동시 confirm 미세 경합**: `findExpenseIdByKey` 증명과 revert 사이의 극소 창(모든 시도 AppError + 동시 생성이 그 창에서 커밋)은 잔존하나 게이트+동일-소유자-이중확정 전제로 무시 가능.
