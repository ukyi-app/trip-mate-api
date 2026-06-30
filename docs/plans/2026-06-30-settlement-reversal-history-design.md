# 정산 reversal/history 슬라이스 — 설계

날짜: 2026-06-30 · 브랜치: `feat/settlement-reversal`(`.worktrees/settlement-reversal`, feat/expenses-pagination 위 적층)

## 1. 배경·목표

정산(settlement)은 finalize로 스냅샷을 영속하고(`settlements.version`, active|superseded), transfer를 `mark-paid`로 결제 완료 표시한다. 그러나:

- **reversal 부재**: `mark-paid`만 있고 되돌리는 `mark-unpaid`가 없다. `unlock`은 paid transfer가 있으면 차단하며 코드 주석에 "reversal/carry-forward는 후속"으로 명시됨.
- **결제 이력 부재**: transfer는 현재 상태(`paid_at`·`marked_by_member_id`)만 보유. mark-unpaid가 이 값을 지우면(`paid_consistency` 제약) "누가 언제 결제표시했는지"가 소실된다.
- **버전이력 읽기 부재**: 재확정으로 생긴 superseded 스냅샷은 DB에 보존되나 조회 API가 없다.

목표: 결제 되돌리기(reversal) + 결제 이벤트 감사 + 정산 버전이력 조회를 제공한다.

## 2. 스코프 (확정)

1. transfer `mark-unpaid` 엔드포인트 (reversal)
2. `settlement_transfer_events` 감사 테이블 (paid/unpaid 이벤트 append-only) — mark-paid도 이벤트 기록하도록 수정
3. 정산 버전이력 조회 API (헤더 목록)
4. transfer 결제 이벤트 로그 조회 API

**핵심 불변식**: superseded 스냅샷의 transfer는 **항상 pending**이다(`unlock`이 paid 존재 시 차단 → 재확정 전 전부 pending). 따라서 **결제 이벤트는 active 정산의 transfer에만** 발생하며, 버전이력은 헤더(타임라인)로 충분하다(과거 버전 full 스냅샷 detail은 defer).

## 3. 데이터 모델 — `settlement_transfer_events`

append-only 감사 로그(expense_audit_logs 패턴, `created_at`만):

| 컬럼 | 타입 | 비고 |
|---|---|---|
| `id` | uuid pk | |
| `transfer_id` | uuid notNull | FK → settlement_transfers.id (단순 FK; transfer는 supersede 시에도 보존) |
| `trip_id` | uuid notNull | |
| `settlement_id` | uuid notNull | |
| `event_type` | text notNull | CHECK `IN ('paid','unpaid')` |
| `actor_member_id` | uuid notNull | 복합 FK (trip_id, actor_member_id) → trip_members |
| `created_at` | timestamptz notNull defaultNow | append-only |

제약·인덱스:
- 복합 FK `(trip_id, settlement_id)` → `settlements(trip_id, id)` (uq_settlement_trip_id 존재), `onDelete cascade`
- 복합 FK `(trip_id, actor_member_id)` → `trip_members(trip_id, id)`
- CHECK `event_type IN ('paid','unpaid')`
- index `(transfer_id, created_at desc)` — transfer별 이력 조회
- 마이그레이션: drizzle-kit generate(추가 테이블, 기존 영향 없음)

enum 처리: `event_type`은 text+CHECK(진화 enum 패턴, 기존 컨벤션).

## 4. 엔드포인트

### 4.1 mark-unpaid (신규)
`POST /trips/{tripId}/settlement/transfers/{transferId}/mark-unpaid`
- 미들웨어: `auth`, `member`, `idempotency`(mark-paid와 동일)
- 가드(tx, trip FOR UPDATE — finalize/unlock과 직렬화): finalized → active 정산 → settlement-basis transfer
- 인가: `to_member_id === actor` 또는 `role === 'admin'` (mark-paid 대칭, 수취인이 "아직 안 받았다" 정정 가능)
- 동작: paid → pending(`paid_at`·`marked_by_member_id`=null, `paid_consistency` 충족) + `'unpaid'` 이벤트 기록 / 이미 pending이면 멱등 no-op(이벤트 없음)
- 응답: `{ transferId, payment_status: "pending" }` (mark-paid 응답 형태 대칭)

### 4.2 mark-paid (수정)
- pending → paid 전이 시 `'paid'` 이벤트 기록(동일 tx). 이미 paid면 이벤트 없음(멱등 유지).

### 4.3 버전이력 (신규)
`GET /trips/{tripId}/settlement/history`
- 인가: `auth`, `member`
- 응답: 최신순 배열 `{ version, status: "active"|"superseded", finalized_by_member_id, finalized_at, settlement_total }`
- 정산 없으면 빈 배열

### 4.4 결제 이벤트 로그 (신규)
`GET /trips/{tripId}/settlement/transfers/{transferId}/events`
- 인가: `auth`, `member`
- transfer가 해당 trip 소속인지 검증(아니면 404)
- 응답: 최신순 배열 `{ event_type: "paid"|"unpaid", actor_member_id, created_at }`

## 5. 동시성·인가·멱등

- 모든 변이(mark-paid/unpaid)는 단일 tx + `trips` FOR UPDATE로 finalize/unlock과 직렬화(기존 mark-paid 패턴 유지).
- mark-unpaid는 Idempotency-Key 미들웨어 적용(재시도 replay, mark-paid와 동일 scope=path).
- 이벤트 기록은 상태 전이가 실제 발생할 때만(멱등 재호출은 이벤트 미생성) → 감사 로그가 멱등 재시도로 부풀지 않음.

## 6. 에러

- finalized 아님 → 409 ConflictError ("settlement not finalized")
- transfer 부재/타 정산 → 404 NotFoundError
- 인가 실패 → 403 ForbiddenError
- (mark-unpaid) 권한 없는 멤버 → 403

## 7. 테스트 고려 (TDD)

- repo: 이벤트 insert/조회, mark-unpaid CAS(paid→pending), 버전이력 목록(active+superseded 정렬), transfer 이벤트 조회(trip 스코프)
- service: mark-unpaid 가드(미finalized 409·비active·인가)·멱등(pending no-op)·이벤트 기록 / mark-paid 이벤트 기록 / history / events
- controller(e2e): mark-unpaid 200·403·404·409, 멱등, history 응답, events 응답, paid→unpaid→paid 이벤트 3건
- DB 제약 통합테스트: event_type CHECK, 복합 FK(타 trip actor·settlement)
- doc: OpenAPI 경로·스키마(MarkUnpaidResult·SettlementHistory·TransferEvents) 등록, openapi.json 재생성

## 8. 결정 로그

| 결정 | 선택 | 근거 |
|---|---|---|
| reversal 범위 | transfer mark-unpaid | unlock은 이미 존재(재오픈), 결제 단위 되돌리기가 빠진 부분 |
| 결제 이력 | 신규 감사 테이블(append-only) | mark-unpaid가 현재상태를 지움 → 별도 이력 필요. expense_audit_logs 패턴 일관 |
| mark-unpaid 인가 | 수취인 또는 admin | mark-paid 대칭, 수취인 자기정정 허용 |
| 버전이력 | 헤더만(detail defer) | superseded는 항상 pending·정적; active full은 기존 GET /settlement 제공 |
| 이벤트 노출 | 전용 엔드포인트 | GET /settlement inline은 페이로드 비대 → 온디맨드 |

## 9. Defer (out-of-scope)

- 과거 버전 full 스냅샷 detail 엔드포인트
- carry-forward(미결제 잔액 다음 정산 이월)
- 이벤트의 trip 전체 활동 피드(transfer 단위로 충분)
