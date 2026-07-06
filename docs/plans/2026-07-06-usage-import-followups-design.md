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

- 테스트: 쿼터 미들웨어(Redis testcontainer, N+1→429·Retry-After), 메트릭 registry 증가·`/metrics` 포맷.

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
