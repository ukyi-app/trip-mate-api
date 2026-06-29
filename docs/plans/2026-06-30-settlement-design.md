# Settlement 슬라이스 설계 (정산 계산·finalize·transfers)

**작성일:** 2026-06-30
**브랜치:** feat/settlement (feat/fx-integration 위 적층)
**선행:** settlement-engine(`compute.ts` 코어)·db(settlements/transfers/summaries/currency_totals 스키마)·fx-integration(expenses·trips FOR UPDATE 직렬화)·api-routes(buildV1App·guards)

---

## 1. 목표·범위

기존 **`compute.ts` netting 코어**(splitExpense·minTransfers greedy·computeSettlement 이중축·환불·Σnet==0)와 **기존 DB 스키마**(settlements/settlement_transfers/settlement_member_summaries/settlement_currency_totals) 위에 **글루 레이어**(service/repo/controller/schema)를 얹어 정산 API를 완성한다. **새 마이그레이션 불요.**

**In scope:** GET /settlement(라이브 재계산)·precheck·finalize(seen_expense_versions drift→409·이중축 saveSnapshot·trips.settlement_status='finalized')·unlock(재오픈)·transfers/{tid}/mark-paid(멱등).

**Out of scope(후속):** transfer 결제취소(revert)·local-basis 결제추적·정산 이력 목록·부분정산·DB-durable 멱등.

## 2. 아키텍처

functional core(`compute.ts`, 불변) / imperative shell(service+repo). port+adapter. api-routes의 buildV1App·guards·money·zod-openapi 패턴 재사용.

- **settlements 모듈**(`src/modules/settlements/`):
  - `domain/compute.ts` — **기존**(재사용)
  - `settlements.schema.ts` — 응답/요청 DTO(돈 string·version·seen_versions·이중축)
  - `settlements.repo.ts` — 포함지출 쿼리·saveSnapshot(supersede+자식 일괄)·getActiveSnapshot·markTransferPaid CAS·trips lock
  - `settlements.service.ts` — getSettlement(라이브)·precheck·finalize(tx)·unlock·markPaid
  - `settlements.controller.ts` — 5 라우트
- **컴포지션:** `V1Deps`에 `settlementsService` 추가·`registerSettlementRoutes(v1, deps)`. main.ts에서 인스턴스화.

## 3. 라우트 (전부 `/v1/trips/{tripId}/settlement*`, requireTripMember)

| 메서드 | 경로 | 인가 | 동작 |
|---|---|---|---|
| GET | `/settlement` | member | **라이브 재계산**(포함 지출→이중축 transfers/summaries/totals) + `seen_versions [{expense_id,version}]` + trip settlement_status + active 스냅샷 version |
| GET | `/settlement/precheck` | member | finalize 사전점검 — compute dry-run + `finalizable` flag + `reasons`(Σnet≠0·통화혼재·0건 등 구조화, throw 대신) + seen_versions |
| POST | `/settlement/finalize` | **admin** | body `{seen_expense_versions:[{expense_id,version}]}`·tx 확정(§4) |
| POST | `/settlement/unlock` | **admin** | trips FOR UPDATE→status='finalized' 확인→`'open'` 재오픈(스냅샷 historical 유지) |
| POST | `/settlement/transfers/{transferId}/mark-paid` | **수취인∥admin** | 조건부 `WHERE payment_status='pending' AND basis='settlement'`→멱등(이미 paid면 현재상태 200) |

> 액션은 `:verb` 아닌 **`/verb` 경로-세그먼트**(api-routes 확립 패턴, openapi.json=SSOT).

## 4. finalize 트랜잭션 (핵심)

```
auth → requireTripMember(admin) →
tx: SELECT trips FOR UPDATE → settlement_status='open'? (아니면 409 이미확정) →
    포함 지출 읽기(expense_settlement_state='included' AND deleted_at IS NULL) + participants →
    assertNoVersionDrift(seen vs 현재 집합·버전) → drift? 409 ConflictError →
    ExpenseInput[] 매핑(id·paid_by·participants·local{amount,currency}·settlement{amount,currency}·refund_of) →
    members = 결제자 ∪ 참여자(포함지출 전체) →
    computeSettlement({expenses, members}) → { settlement: AxisResult, local: Record<ccy, AxisResult> } →
    이전 active 스냅샷 status='superseded'(있으면) →
    insert settlements(version=이전+1∥1, status='active', finalized_by_member_id, finalized_at, total_settlement_amount=settlement축 total) →
    insert settlement_transfers(settlement축: basis='settlement' + local축들: basis='local') →
    insert settlement_member_summaries(settlement + local, net=paid−share) →
    insert settlement_currency_totals(local축 통화별 total) →
    UPDATE trips SET settlement_status='finalized', finalized_at=now() →
→ 스냅샷 DTO 반환(version·transfers·summaries·totals)
```

**expense mutation과 상호 직렬화:** expenses.repo가 create/update/delete 모두에서 `SELECT trips FOR UPDATE`+status='open' 확인 → finalize가 같은 trips row를 잠그고 'finalized'로 전환하므로 스냅샷 밖 insert race 차단(architecture §4.6, expenses.repo.ts:96-98 forward-ref).

> **compute.ts 계약 확인:** 입력은 `{expenses, members}` 객체(architecture 의사코드의 단일인자·`result.imbalance`와 drift — 실제 코어는 Σnet≠0이면 `SettlementInvariantError` throw, imbalance 미반환). 글루는 실제 시그니처에 맞춤.

## 5. drift·동시성

- `assertNoVersionDrift(seen: Map<expenseId, version>, current: [{id, version}])`: seen의 expense_id 집합 ≠ 현재 포함 집합, **또는** 버전 불일치 → **409**. admin이 *본 그대로* 확정 보장(reviewed-set, api-contract §5).
- 중복 finalize: 첫 확정이 status='finalized' → 둘째는 status≠open → 409(자연 멱등). Idempotency-Key 불요.
- DB 보강: `uq_settlement_active`(부분 unique WHERE status='active')·`uq_settlement_version`.
- mark-paid: 조건부 UPDATE WHERE pending → 멱등(이미 paid면 현재 행 반환).

## 6. 에러 처리 (RFC 9457)

| 상황 | 상태 | code |
|---|---|---|
| reviewed-set drift·비-open finalize·비-finalized unlock | 409 | ConflictError |
| Σnet≠0·통화혼재(compute throw) | 422 | SettlementInvariantError |
| 비멤버·비admin(finalize/unlock)·비수취인(mark-paid) | 403 | ForbiddenError |
| trip/transfer 부재 | 404 | NotFoundError |

precheck는 SettlementInvariantError를 throw 대신 `reasons`로 구조화 반환(사전점검 UX).

## 7. 테스트 (TDD, testcontainers PG16)

- `settlements.repo.test`(PG): 포함지출 쿼리(included만·deleted 제외)·saveSnapshot(supersede prior+transfers/summaries/totals 자식)·markTransferPaid CAS(pending→paid·이미 paid 멱등)·getActiveSnapshot.
- `settlements.service.test`(PG): getSettlement 라이브 compute·finalize happy(스냅샷+이중축 transfers+trips status='finalized')·drift→409·이미확정→409·unlock→open·markPaid 멱등·Σ보존.
- `settlements.controller.test`(PG): 5 라우트·authz(admin finalize/unlock·수취인 mark-paid)·drift 409.
- **교차-슬라이스**: finalize 후 expense create→409(expenses.assertTripOpen)·unlock 후 create 재허용.
- `settlement-doc.test`: 스펙 경로·DTO 컴포넌트.

## 8. 핵심 설계 결정 (사용자 확정)

1. **GET = 항상 라이브 재계산**(finalized면 expense 잠금이라 스냅샷과 동일 — 별도 스냅샷 분기 불요).
2. **mark-paid = 조건부 WHERE pending·멱등-OK**(이미 paid면 200, 네트워크 재시도 안전).
3. **unlock 포함**(정산 후 수정 재개 루프 완성).

## 9. 빌드 순서 (예상 6 Task)

0 settlements.schema(DTO) → 1 repo(포함지출·saveSnapshot·markPaid) → 2 service(GET·precheck·finalize·unlock·markPaid) → 3 controller(5 라우트) → 4 buildV1App·main 배선 → 5 계약·교차-슬라이스 테스트
