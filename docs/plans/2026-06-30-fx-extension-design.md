# FX 확장 슬라이스 설계 (card_billed·preview·편집재계산·trip_default)

**작성일:** 2026-06-30
**브랜치:** feat/fx-extension (feat/contract-publish 위 적층)
**선행:** fx-pipeline(resolveFx)·fx-integration(expenses·FX 스냅샷)·settlement.

---

## 1. 목표·범위

expenses 도메인의 FX 기능을 완성한다. **새 마이그레이션 불요**(expenses 스키마의 FX 컬럼·`fx_by_source` CHECK·trip_fx_defaults 기존재).

**In scope:** (1) card_billed(카드 외화결제) · (2) `POST .../expenses/preview`(미영속 미리보기) · (3) 편집재계산(PATCH amount/currency/date) · (4) trip_default 승격(admin 엔드포인트). + `resolveExpenseFx` 공통 헬퍼 추출.

**Out of scope(후속):** card_billed↔converted source 전환 · 환불(음수 amount) · 커서 페이지네이션.

## 2. card_billed (카드 외화결제)

카드로 외화 결제 시 카드 청구액(= trip 정산통화)이 곧 정산액 — FX 해석 불요. `fx_by_source` CHECK: `card_billed`면 `exchange_rate_source` NULL.

- **신호:** `createExpenseSchema`에 `card_billed_settlement_amount?: minorString`. **존재 시 card_billed 모드**(`manualRate`와 상호배타 — 둘 다면 422).
- **저장:** `settlement_amount`=입력값, `settlement_amount_source='card_billed'`, `exchange_rate/source/provider/table_date/fetched_at`=NULL, `exchange_rate_date`는 spent_at→tz 파생(NOT NULL 유지). resolveFx 우회.
- `ExpenseSnapshot.settlement_amount_source: "converted"|"card_billed"` + FX 컬럼 nullable화.

## 3. POST /v1/trips/{tripId}/expenses/preview

member 인가. body = create 입력(local_amount·currency·spent_at·participant_member_ids·manualRate?·card_billed_settlement_amount?). **FX 계산 + 균등분할만 반환, 영속·version·멱등 없음.**

- 응답 `{ settlement_amount, settlement_currency, exchange_rate(nullable), exchange_rate_source(nullable), settlement_amount_source, fallbackWarning, needs_manual, per_member:[{member_id, share}] }`.
- split은 compute.ts `splitExpense(settlement_amount, participants)` 재사용.
- needsManual이면 **구조화 응답**(`needs_manual: true`, 나머지 null) — 미리보기 UX(422 대신).

## 4. 편집재계산 (PATCH amount/currency/date)

`updateExpenseSchema`에 `local_amount?·local_currency?·spent_at?·manualRate?·card_billed_settlement_amount?` 추가.

- tx 내 현재행 로드 → 변경 필드 병합 → **converted면 resolveFx 재실행**(tz 재검증, finding #3 pass3 패턴) · **card_billed면 settlement_amount만 수정**(source 유지). **source 전환(converted↔card_billed)은 out-of-scope**(요청 시 422).
- repo: `updateMeta`를 `updateExpense`로 확장 — 메타 + (재계산 시)FX 컬럼·settlement_amount를 같은 version CAS UPDATE에. audit before/after·tz 재검증(FOR UPDATE) 유지.
- FX 영향 필드 미변경이면 기존 메타-전용 경로(resolveFx 미실행).

## 5. trip_default 승격

**별도 admin 엔드포인트** `PUT /v1/trips/{tripId}/fx-defaults` body `{base_currency, settlement_currency, rate}`(rate=major→major 문자열) → `DrizzleTripDefaults.upsertRate`(기존재). admin 인가. 명시적 관리 액션(create-flag 아님).

- 이후 resolveFx의 trip_default fallback이 이 값을 사용(이미 배선·5번째 fallback).

## 6. 공통 리팩토링 — resolveExpenseFx

createExpense의 step 2~3(exponent 조회 + date 파생 + resolveFx)을 `resolveExpenseFx(deps, { tripId, tz, settle, local_amount, local_currency, spent_at, manualRate? }): Promise<FxResult>`로 추출. create·preview·edit가 공유. card_billed는 이 헬퍼 우회(별도 분기).

## 7. 라우트 요약

| 메서드 | 경로 | 인가 | 변경 |
|---|---|---|---|
| POST | `/trips/{tripId}/expenses` | member·idem | card_billed 분기 추가 |
| POST | `/trips/{tripId}/expenses/preview` | member | **신규** |
| PATCH | `/trips/{tripId}/expenses/{expenseId}` | member | 편집재계산 추가 |
| PUT | `/trips/{tripId}/fx-defaults` | **admin** | **신규** |

## 8. 에러
422(card_billed+manualRate 동시·source 전환 시도·미지 통화·FX 미해결[create/edit]) · 409(version CAS·finalized) · 403(비멤버·비admin) · 404. preview는 needsManual을 구조화 응답으로.

## 9. 테스트(TDD, PG)
schema(card_billed·preview·update 확장) · service(card_billed 저장·preview 계산·편집재계산 converted/card_billed·source 전환 거부·trip_default upsert) · repo(updateExpense FX CAS) · controller(4 라우트·authz) · 계약 doc.

## 10. 핵심 결정(사용자 확정)
1. card_billed 신호 = `card_billed_settlement_amount` 필드 존재.
2. 편집재계산 = converted 재해석 + card_billed 금액수정, **source 전환 제외**.
3. trip_default = 별도 admin 엔드포인트(PUT fx-defaults).
4. preview needsManual = 구조화 응답(422 아님).

## 11. 빌드 순서(예상 6 Task)
0 DTO 확장 → 1 resolveExpenseFx 추출 + card_billed create → 2 preview → 3 편집재계산 → 4 trip_default 엔드포인트 → 5 통합·계약 테스트
