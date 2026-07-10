---
feature: expense-contract-completion
invariant-class: feature
entry-track: feature
review-track: full
pipeline-stage: executing
issue-tracker: local
skeleton: [I-4]
issues: [I-1, I-2, I-3, I-4, I-5]
design-of-record: true
---

# expense-contract-completion — 설계-of-record

web-expenses가 요구하지만 백엔드가 아직 지탱 못 하는 계약 갭을 닫는다(G3 인가 갭은 PR #28로 완료).
남은 발주 **B-1(통화)·B-2.2(Expense DTO)·B-2.3(신원)** 을 하나의 feature로 완결한다.

- 설계-of-record: `trip-mate/docs/plans/2026-07-09-backend-expense-identity-authz-design.md` §B-1/§B-2.2/§B-2.3
  (web-expenses intake 그릴링 산물 + 사용자 결정 D-1~D-6). 이 문서는 그 발주를 5 슬라이스로 종합한 것.
- 스카우트(5 병렬 에이전트)가 현재 코드 대비 슬라이스별 구현 명세·위험을 확정함.
- **intake 우회 아님**: 설계·그릴링은 web-expenses에서 이미 끝났고 사람이 D-1~D-6을 결정함. `/to-prd` 게이트는
  *새* 설계용이지 *확정된* 설계 구현엔 해당하지 않는다 → 커밋된 발주를 채택해 실행+게이트로 진행.

## 분해 (5 vertical slices, 직렬 실행)

| id | 슬라이스 | openapi 영향 | blocked-by | 비고 |
|---|---|---|---|---|
| I-1 | B-1.2 `CURRENCY_SEED` 9→28 + `oxr.SUPPORTED` 28 + **멱등 데이터 마이그레이션(19 신규행)** + `coverage.test.ts` + 픽스처 정합 | 없음 | — | G5 배포 결함 해소 |
| I-2 | B-1.1 `GET /v1/currencies` (신규 `src/modules/currencies/`) | +path `/v1/currencies` · +`Currency` | I-1(데이터) | auth, minor_unit만 |
| I-3 | B-2.2 Expense DTO +4필드 | +`Expense` 4필드 | — | 이미 영속된 컬럼 노출 |
| I-4 | B-2.3a Trip `my_member_id` + 목록 순정산 | +`Trip`.my_member_id · +`TripListItem` | — | **skeleton**(최복잡) |
| I-5 | B-2.3b `GET /v1/me/invites` (members 모듈) | +path `/v1/me/invites` · +`MyInvite` | — | user-scoped |

- **skeleton = I-4** — 유일하게 실질 로직/아키텍처(순정산 port·배치 조회·타입 분리). I-4 종료 후 structure 게이트.
- 나머지는 대체로 가산적(DTO 확장·시드·신규 read 엔드포인트). 직렬 순서: I-1 → I-2 → I-3 → I-4 → I-5.
- **openapi 재생성 전략(D-G)**: openapi 변경 슬라이스(I-2·I-3·I-4·I-5)는 각자 `bun run gen:openapi` 실행 후
  openapi.json 델타를 커밋. verification에서 `openapi-drift` green. I-1은 openapi 무변경.

## 검증할 load-bearing 결정 (design 게이트 대상)

- **D-A minor_unit 판단(B-1.2)**: `minor_unit`은 실무 거래 관행(런타임 돈 계산에 쓰이는 값), `iso_exponent`는
  ISO 4217(문서용, 런타임 미사용). **minor_unit=0 그룹(6)**: KRW·JPY·VND(ISO도 0) + **TWD·IDR·HUF**(ISO 2이나
  실무 정수). **minor_unit=2 그룹(22)**: 나머지. 기존 9행(KRW JPY VND TWD USD EUR THB GBP CHF)은 **바이트 불변**.
  - **TWD=0은 확정**(기존 시드 행 + 발주 §B-1.2가 못박은 실무 정수 관행 — 변경 시 기존 데이터 행동 변화라 논외).
  - **HUF=0 확정(plan-gate P-3, 사용자 결정)**: 이 앱은 여행 지출 **수동 입력**이고(fillér 1999 폐지 → 정수 forint만
    유통), card_billed도 사용자가 카드 명세서의 정수 forint를 직접 타이핑한다 — **카드 자동 수집 경로가 없어**
    Adyen/Stripe의 2-소수 charge 관행에서 오는 오스케일 리스크가 실현되지 않음. TWD 선례와 일관. 시드 파일 주석에
    이 근거와 "미래에 카드 자동 수집을 붙이면 HUF/TWD 입력 지수를 재검토" 경고를 남긴다.
- **D-B my_net_amount 축(B-2.3a)**: 정산 **settlement-axis** net = `computeSettlement(...).settlement.summaries[me].net`
  (= 지불액−분담액), **부호 있는 minor-unit 문자열**(`/^-?\d+$/`, 음수 가능). `net_currency` = `trip.settlement_currency`.
  **local axis 아님.**
  - **호출자 summary 부재 → 항상 `"0"`(plan-gate P-2)**: computeSettlement 입력은 included 지출에 결제/참여한
    멤버만 포함하므로, **비어있지 않은 여행방에서도 호출자가 지출 무활동이면 summary가 없다**. 이 경우(빈 여행방이든
    무활동 멤버든) my_net_amount = 부호 있는 `"0"`. **null은 오직 compute 에러 때만**(D-C try/catch). 두 케이스
    (무활동 멤버→"0", corrupt 여행방→null)를 각각 테스트.
- **D-C 목록 N-cost(B-2.3a)**: N여행방 × computeSettlement의 CPU가 아니라 **FETCH를 배치화** — 신규
  `settlements.repo.listIncludedExpensesForTrips`가 expenses IN-쿼리 1 + participants IN-쿼리 1(= O(1) 라운드트립),
  순수 compute는 메모리에서 여행방당 1회. **여행방별 try/catch → 이상 여행방은 net=null**(1개 나쁜 여행방이 목록 전체를
  500내지 않게). finalized 여행방도 동일 live compute(잠금이 지출 변경 차단하므로 snapshot과 동일).
- **D-D Trip 스키마 확산(B-2.3a)**: `my_member_id`를 공유 `Trip` 스키마에 추가하면 `POST /v1/trips`·
  `PATCH /v1/trips/{id}` 응답에도 노출됨(둘 다 Trip 참조). **수용**: 이 세 경로는 전부 멤버/생성자 스코프라
  my_member_id가 항상 해석 가능(생성=creator membership, 상세/patch=requireTripMember 가드). 목록만 별도
  `TripListItem`(Trip + my_role/my_net_amount/net_currency).
- **D-E /me/invites 성격(B-2.3b)**: **discovery-only** — 원시 토큰은 반환 불가(sha256 해시만 저장) → 사용자는
  여전히 이메일 링크로 수락. 필드: trip_id·trip_title·role·invited_email·expires_at. **토큰·member_id·user_id 미노출.**
  필터: `normalized_invited_email = normalizeEmail(session email) ∧ status='invited' ∧ invite_token_expires_at > now()`.
  빈/무효 이메일 → normalizeEmail 던지기 전에 `[]` 가드.
- **D-F GET /v1/currencies(B-1.1)**: `middleware:[auth]`만(비-trip-scoped·비공개). `minor_unit`은 정수 **number**
  (소수자릿수 카운트 0/2, 금액 아님 — "돈은 number 금지"의 예외, 주석 명시). `iso_exponent` 2중 은닉(SELECT·스키마 모두 배제).
  `Cache-Control: public, max-age=3600`.
- **D-H 통화 시드 프로덕션 마이그레이션(plan-gate P-1)**: 프로덕션 부팅은 `runMigrations`만 하고 `seedCurrencies`를
  돌리지 않는다(`main.ts:51`; seed는 `db:seed` CLI·테스트 하네스 전용). 시드 헬퍼 확장만으론 **기존 DB가 9행에 갇힌다**.
  I-1은 **멱등 drizzle 데이터 마이그레이션**(신규 19행 `INSERT ... ON CONFLICT (code) DO NOTHING`)을 추가해 부팅 시
  자동 적용한다. 기존 9행 불변. 검증(`select count(*) from currencies` = 28). minor_unit 오판 시 후속 마이그레이션 `update`로 교정.

## 보존 계약 (전부 green 유지)

- 기존 스위트 590 passed(main baseline). 각 슬라이스 characterization 유지.
- 돈 불변식: 금액은 minor-unit 정수 문자열(number 금지). I-2 currencies.minor_unit만 예외(지수).
- G3 인가(findMutationAuthz·ExpenseMutationActor) 미교란.
- `openapi-drift` CI green(gen:openapi 재생성·커밋). `contract.smoke`는 CI skip(로컬 가드).

## Testing Decisions (seams) — plan-gate P-4

각 슬라이스가 명시 커버해야 할 핵심 행동 seam(광역 스위트 green만으론 불충분):

- **I-1**: `coverage.test.ts`(순수 정적) — `new Set(oxr.SUPPORTED) ⊇ CURRENCY_SEED codes`, USD 포함, 중복 없음.
  `provider.test.ts` FULL 28 정합. (선택) 마이그레이션 후 formerly-missing 통화(SGD 등)로 trip/expense 생성이 더는 422 안 됨.
- **I-2**: `currencies.controller.test.ts`(testcontainers) — authed 200 + 시드 통화 반환(특정 코드 KRW/USD/TWD의
  minor_unit 단언, 행 수 하드코딩 금지), **미인증 403**, `iso_exponent` 부재, `Cache-Control` 헤더.
- **I-3**: `expenses.controller.test.ts` — 새 4필드 왕복(생성 시 last_modified_by=null, 수정 후 non-null; created_at/updated_at ISO), 계약에 4필드.
- **I-4**: `trips.controller.test.ts` + settlements 통합 — 상세 my_member_id; 목록 my_member_id/my_role/my_net_amount/net_currency;
  **무활동 멤버 → "0"** · **정상 net 부호** · corrupt-trip → null; user_id 부재.
- **I-5**: `members.routes.test.ts` — 이메일 정규화 매칭, status='invited'+미만료 필터, 미인증 403, 토큰/user_id/member_id 미노출, 빈-이메일 → [].

## Out of scope

- §30.3 감사로그 상세 read 엔드포인트(발주 밖) · FX 자동 seed/promotion · `user_id` 노출 · FE 코드 변경
  (B-1.2는 FE 카탈로그가 이미 28종이라 FE 변경 0; 나머지는 FE가 새 핀으로 재-codegen).

## Review Decision Log

### Codex Design Review (plan gate) — r1: needs-attention (4 findings)

- **P-1** (Major/high, `design.md:28`) 통화 확장 프로덕션 마이그레이션 부재 → **Accept**: I-1에 멱등 데이터 마이그레이션 추가(D-H).
- **P-2** (Major/high, `design.md:45-51`) 무활동 joined 멤버의 my_net_amount 누락 → **Accept**: 호출자 summary 부재 시 항상 "0"; null은 compute 에러만(D-B).
- **P-3** (Minor/med, `design.md:41-44`) HUF/TWD 0-소수 위험 → **HUF=0(사용자 결정, 옵션 1)**: TWD=0 확정(기존 시드+발주), HUF=0은 수동입력·정수 forint·카드 자동수집 부재로 확정, 주석에 근거+경고(D-A).
- **P-4** (Minor/med, `design.md:64-69`) 테스트 seam 미명시 → **Accept**: Testing Decisions 섹션 추가.
