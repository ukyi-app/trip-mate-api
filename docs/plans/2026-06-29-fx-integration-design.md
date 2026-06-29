# FX 통합 슬라이스 설계 (expenses CRUD + resolveFx 스냅샷 + Idempotency-Key)

**작성일:** 2026-06-29
**브랜치:** feat/fx-integration (feat/api-routes 위 적층)
**선행:** fx-pipeline(resolveFx 코어)·db(expenses 스키마)·auth-invite(guards)·api-routes(buildV1App·OpenAPI 스택)

---

## 1. 목표·범위

지출(expense) CRUD 라우트를 `/v1`에 추가하고, **생성 시 `resolveFx`로 정산통화 환산 스냅샷을 영속화**하며, **Idempotency-Key 미들웨어**로 중복 저장을 차단한다. fx-pipeline의 `resolveFx` 코어와 db 슬라이스의 expenses 스키마(FX 컬럼·`fx_by_source` CHECK·`version`·`expense_audit_logs` 기존재)를 api-routes의 `buildV1App`·guards·OpenAPI 스택에 통합한다.

**In scope:**
- expenses CRUD 라우트(POST·GET목록·GET상세·PATCH·DELETE)
- 생성 시 resolveFx 스냅샷 저장(expenses 스키마의 기존 FX 컬럼·`fx_by_source` CHECK 활용)
- Idempotency-Key 미들웨어(api-contract §5)
- 낙관적 version CAS(PATCH/DELETE)
- audit 로그(create/update/delete)
- 돈 = string DTO(D1)

**Out of scope(후속 슬라이스, forward-ref):**
- **card_billed**(카드 청구통화 — `settlement_amount_source='card_billed'` 경로): FX 슬라이스 확장
- **`:preview`**(저장 전 환율·정산 미리보기): FX 슬라이스 확장
- **편집재계산**(PATCH로 amount/currency/date 변경 시 resolveFx 재실행): 본 슬라이스 PATCH는 메타+참여자만
- **trip_default 환율 승격**: trip 설정 슬라이스
- **커서 페이지네이션**: 페이지네이션 슬라이스(본 슬라이스는 기본 limit 목록)
- **정산 분할 계산**: settlement 슬라이스(본 슬라이스는 참여자 집합만 저장)

---

## 2. 아키텍처

functional core / imperative shell, port+adapter(DIP), 수동 DI. api-routes에서 확립한 패턴 그대로 재사용.

- **expenses 모듈**(`src/modules/expenses/`):
  - `expenses.schema.ts` — 공개 응답 DTO·생성/수정 입력 DTO(돈 string·version·omit 내부 컬럼)
  - `expenses.repo.ts` — DrizzleExpenseRepo(create tx·findById·listForTrip·updateMeta CAS·softDelete CAS·insertParticipants·insertAudit)
  - `expenses.service.ts` — ExpensesService(resolveFx 호출·exponent 조회·단일 tx 조립·needsManual→422)
  - `expenses.controller.ts` — zod-openapi 라우트(createRoute·미들웨어·valid·제네릭 헬퍼)
- **Idempotency 미들웨어**(`src/core/idempotency.ts`): Valkey(ioredis) 주입, cross-cutting 미들웨어 팩토리
- **컴포지션 루트**(main.ts): FX deps(OXR/CurrencyAPI providers·RedisCache·DrizzleTripDefaults·currencies exponent 조회)와 ioredis 인스턴스를 ExpensesService·Idempotency 미들웨어에 주입. `buildV1App`의 `V1Deps`에 `expensesService`·`idempotencyStore` 추가, `registerExpenseRoutes(v1, deps)` 호출

---

## 3. 라우트 (전부 `/v1/trips/{tripId}/expenses` 하위, requireTripMember)

| 메서드 | 경로 | 미들웨어 | 동작 | 응답 |
|---|---|---|---|---|
| POST | `/expenses` | auth·member·**idempotency** | resolveFx 스냅샷 + 참여자 + audit, 단일 tx | 201 expenseResponse |
| GET | `/expenses` | auth·member | 목록(spent_at desc, id desc 타이브레이커; 기본 limit 50, max 100) | 200 expenseResponse[] |
| GET | `/expenses/{expenseId}` | auth·member | 상세(없음/타-trip → 404) | 200 expenseResponse |
| PATCH | `/expenses/{expenseId}` | auth·member | 메타+참여자만(FX 불변)·version CAS·audit | 200 expenseResponse |
| DELETE | `/expenses/{expenseId}` | auth·member | soft delete(deleted_at)·version CAS·audit | 200 {id, deleted:true} |

- 인가: requireTripMember(멤버면 CRUD 가능 — admin 전용 아님). paid_by/created_by는 멤버십 검증 후 기록.
- 모든 경로 `tripId` 파라미터는 requireTripMember가 읽음(api-routes finding #1 pass3 패턴).

---

## 4. FX 통합 (POST 생성 흐름)

1. **입력 검증**(zod): `local_amount`(string `^\d+$`, minor)·`local_currency`(3자)·`settlement_currency`(3자, trip 정산통화와 일치 — DB FK가 강제)·`spent_at`·`participant_member_ids`(min 1)·`paid_by_member_id`·`payment_method`·`category`·optional `manualRate`·`title`·`memo`
2. **exponent 조회**: `currencies.minor_unit`에서 local/settlement exponent 조회(없는 통화 → 422). `FxInput` 구성(localMinor=BigInt(local_amount), localCurrency, settlementCurrency, date=spent_at의 현지 TZ 일자, localExp, settleExp, tripId, manualRate?)
3. **resolveFx(input, deps)**:
   - `FxResolved` → `settlement_amount` + `exchange_rate`·`exchange_rate_date`·`exchange_rate_source`·`exchange_rate_provider`·`exchange_rate_table_date`·`exchange_rate_fetched_at` + `settlement_amount_source='converted'` 저장
   - `{needsManual:true}` → **422 FxUnresolvedError**(code로 클라가 식별, `manualRate` 첨부 재요청). audit/expense 미생성
4. **단일 `db.transaction`**: expense insert(FX 스냅샷·version=0) + expense_participants insert(member_ids) + expense_audit_logs insert(change_type='create', after=jsonb)
   - DB 제약 위반(23503 통화 FK·23514 fx_by_source 등) → 422 ValidationError 매핑(api-routes asValidation 패턴)

> `fx_by_source` CHECK: `converted`면 exchange_rate·source NOT NULL — resolveFx FxResolved가 항상 충족. card_billed 경로(미포함)는 후속.

---

## 5. Idempotency-Key 미들웨어 (api-contract §5)

- **적용 대상**: POST `/expenses`만. 헤더 `Idempotency-Key` 있으면 honored, 없으면 통과(클라 권장 — 오프라인 큐 §26.2 중복 방지)
- **scope**: `idempotency:{principal_id}:{endpoint}:{client_key}` — 사용자×엔드포인트 격리
- **값**: `{request_hash, status, body, stored_at}`(JSON). request_hash = body의 결정적 해시(SHA-256)
- **TTL**: 24h
- **동작**:
  - 저장된 키 HIT + 같은 request_hash → 저장된 응답(status+body) 재생(핸들러 미실행)
  - 저장된 키 HIT + **다른 request_hash** → **409 ConflictError**(키 오용)
  - 미스 → `SET key lock NX EX <lockTtl>`:
    - lock 획득 → next() 실행 → 응답 캡처 → 결과 저장 → lock을 결과로 교체
    - lock 점유 중(SET NX 실패, 결과 아직 없음) → **409 ConflictError(in-progress)**(클라 재시도)
- **응답 캡처**: Hono 미들웨어가 `await next()` 후 `c.res` clone해 body 읽어 저장. 2xx만 저장(4xx/5xx는 미저장 — 재시도 허용)
- 미들웨어는 `requireAuth` **뒤**(principal 필요). 순서: auth → member → idempotency → 핸들러

---

## 6. version CAS·audit

- **version CAS**: PATCH/DELETE 요청 스키마에 `version: number` 필수(클라가 읽은 값 echo). `UPDATE ... WHERE id=? AND trip_id=? AND version=? AND deleted_at IS NULL` → 0행이면 **409 ConflictError**(stale), 성공 시 version+1
- 모든 expense 응답 DTO에 `version` 포함(CAS-feeding, 리뷰 #2)
- **audit**: create/update/delete 시 **같은 tx**에서 `expense_audit_logs`(trip_id·expense_id·changed_by_member_id·change_type·before_value jsonb·after_value jsonb) 기록. update는 before(수정 전)·after(수정 후), delete는 before만

---

## 7. 에러 처리 (RFC 9457 problem+json)

| 상황 | 상태 | code |
|---|---|---|
| 입력 검증 실패 | 422 | ValidationError(기존 defaultHook) |
| FX 미해결(needsManual) | 422 | FxUnresolvedError |
| version 불일치(stale) | 409 | ConflictError |
| Idempotency 키 오용/in-progress | 409 | ConflictError |
| 비멤버 | 403 | ForbiddenError |
| 부재/타-trip | 404 | NotFoundError |

기존 `errorResponses`·`registerErrorFilter`·`application/problem+json` 미디어타입 재사용. FxUnresolvedError는 `core/errors.ts`에 ValidationError 하위(422) 또는 별도 code로 추가.

---

## 8. 데이터 흐름 (POST 생성)

```
요청 → cors → csrf → requireAuth → requireTripMember → idempotency(replay체크/lock NX)
  → 핸들러: validate(zod) → currencies exponent 조회 → resolveFx(input, fxDeps)
            → FxResolved? tx{ expense insert(스냅샷,version=0) + participants insert + audit(create) }
            → needsManual? 422 FxUnresolvedError
  → 201 응답 → idempotency 결과 저장(2xx) → lock 해제
```

조회/수정/삭제는 idempotency 없이 동일 guards 체인.

---

## 9. 테스트 (TDD, testcontainers PG16 + redis:7)

- `expenses.schema.test.ts` — 돈 string regex·DTO omit(audit/deleted_at)·version 포함·생성/수정 입력 검증
- `expenses.repo.test.ts`(PG) — insert+participants·findById·listForTrip(정렬/limit)·updateMeta CAS·softDelete CAS·audit insert
- `expenses.service.test.ts`(PG) — resolveFx 통합(identity·manual 스냅샷 저장)·needsManual→422·단일 tx 롤백(참여자 실패 시 expense 미생성)·DB제약→422
- `expenses.controller.test.ts`(PG) — 5라우트·인가(비멤버 403)·version 409·돈 string 왕복
- `idempotency.test.ts`(Valkey) — replay 동일응답·다른 body 409·in-progress 409·헤더 없으면 통과
- `expenses-doc.test.ts` — 스펙 경로(/v1/trips/{tripId}/expenses)·DTO 컴포넌트

---

## 10. 빌드 순서 (예상 7~8 Task)

0. Idempotency 미들웨어(`core/idempotency.ts`) + FxUnresolvedError
1. expenses DTO(`expenses.schema.ts`)
2. expenses repo(`expenses.repo.ts`)
3. expenses service(`expenses.service.ts`, resolveFx 통합)
4. expenses controller(`expenses.controller.ts`, 5 라우트)
5. buildV1App·main 배선(V1Deps 확장·FX deps·ioredis 주입)
6. 계약/보안 통합 테스트

---

## 11. 핵심 설계 결정 (사용자 확정)

1. **needsManual → 422 + manualRate 재시도**(draft 저장은 fx_by_source CHECK 위반 → 스키마 변경 필요, 후속)
2. **audit 포함**(create/update/delete tx 내 before/after jsonb 기록)
3. **Idempotency in-progress → 409 즉시 반환**(폴링 복잡성 회피, single-flight 보장)
4. **PATCH = 메타+참여자만**(FX 불변; amount/currency/date 변경=편집재계산은 후속 defer)
