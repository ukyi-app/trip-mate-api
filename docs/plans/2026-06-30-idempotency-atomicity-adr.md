# ADR: 멱등 완전 원자성 — 접근법 결정

날짜: 2026-06-30 · 상태: **결정됨 — C + 지출 한정 B-특화(구현 완료)** · 관련: `src/core/idempotency.ts`(DB-durable 멱등)

## 1. 배경 — 현 설계와 갭

멱등은 **미들웨어 레벨**(`idempotency()`): ① lock INSERT(tx_L) → ② 핸들러 비즈니스 효과(tx_B, 서비스 자체 트랜잭션) → ③ 결과 기록 UPDATE(status/response_body, tx_R). 세 트랜잭션이 분리돼 있다.

**갭:** `response_body`는 핸들러가 끝난 **HTTP 계층(미들웨어)에서야 존재** → 비즈니스 tx(tx_B)에 같이 담을 수 없다. tx_B 커밋과 tx_R 커밋 사이에 크래시/실패하면 비즈니스 효과는 커밋됐는데 멱등 기록은 미완료(status=null)로 남는다.

**현재 완화(코드리뷰 반영, 이미 적용):** 짧은 lock 임대(5m) vs 보존 TTL(24h) 분리 → 포이즌 윈도를 5분으로 bound. 윈도 내 재시도 409, 이후 재실행 시 **중복** 가능. → **at-least-once + bounded 중복** 시맨틱.

## 2. 핵심 통찰 — 잔여 위험은 1곳에 집중

멱등 미들웨어가 붙은 5개 mutation 중 **4개는 이미 비즈니스 레벨에서 자연 멱등**이라 크래시-갭 중복이 무해하다:

| 연산 | 자연 멱등성 | 크래시-갭 재실행 결과 |
|---|---|---|
| settlement **finalize** | status=open 요구 | 이미 finalized → **409**(이중 확정 불가) ✅ |
| settlement **unlock** | finalized 요구 | 이미 open → **409** ✅ |
| transfer **mark-paid** | status 가드(paid면 no-op) | 멱등 no-op ✅ |
| transfer **mark-unpaid** | status 가드(pending면 no-op) | 멱등 no-op ✅ |
| **expense create** | **자연 키 없음** | **중복 지출 1건 생성** ⚠️ |

→ 실제 잔여 위험은 **지출 생성 한 곳**이며, 그마저 (a) 확률 낮음(5분 윈도 내 크래시), (b) **사용자 가시·복구 가능**(중복 지출 삭제), (c) 무성(無聲) 금전 손실 아님. 정산·이체는 이미 안전.

## 3. 접근법 비교

### A. 전면 ambient-tx 리팩터
요청 단위 tx를 열어 컨텍스트(AsyncLocalStorage 또는 명시적 tx 인자)로 전 서비스/레포에 주입. 비즈니스 효과 + 멱등 기록 + 응답을 단일 tx로 커밋.

- ✅ 진짜 원자성(모든 라우트)
- ❌ **락 장기 보유**: trip FOR UPDATE가 요청 전체 동안 유지 → 경합·커넥션 풀 압박 증가(머니 앱에 역행)
- ❌ **유지보수성 최악**: ALS는 "암묵 컨텍스트"(테스트·추론 난해, 모든 레포가 숨은 상태 의존) / 명시 tx 인자는 viral(전 시그니처 오염)
- ❌ 내부 `db.transaction`이 savepoint로 중첩 → 락 시맨틱 변화
- ❌ 검증·리뷰 완료된 시스템 대규모 재작성, 고위험
- **DX**: 신규 라우트마다 ambient tx 규약 학습·준수 필요(영구 세금)

### B. 타깃 in-tx 마커 + replay 재조회 (핵심 라우트)
비즈니스 tx 안에서 멱등 마커(scope_key + 결과 참조 + request_hash)를 같이 커밋. replay는 마커→엔티티 재조회로 응답 재구성.

- ✅ 핵심 라우트 원자성(마커+효과 동일 tx → 갭 없음)
- ✅ 장기 락 없음·ambient 매직 없음
- ⚠️ **라우트별 작업**: 각 연산이 scope_key 수용·마커 기록·replay 경로 제공
- ⚠️ 멱등이 비즈니스 레이어로 침투(범용 미들웨어 추상 일부 상실)
- ⚠️ replay가 **재조회 표현**(원 응답과 바이트 동일 아님 — 대개 무방/더 정확)
- **DX**: 신규 라우트는 미들웨어처럼 자동이 아니라 직접 배선(누락 위험)
- **특화 최적안(지출 생성):** `expenses`에 `idempotency_key` 컬럼 + `(trip_id, key)` unique → create tx에서 INSERT(중복 → 23505 → 기존 replay). **단일 라우트·기존 테이블 변경**으로 유일한 실위험을 원자적으로 제거.

### C. 현행 유지 + accepted-risk 문서화 (+ 선택적 타깃)
미들웨어 멱등 유지(업계 표준 — Stripe류 idempotency-key도 at-least-once + dedup 윈도). 잔여 시맨틱을 ADR로 명문화. 원하면 지출 생성에만 B-특화안 적용.

- ✅ **유지보수성·DX 최상**: 범용 미들웨어 1개, 신규 라우트는 헤더+미들웨어로 **공짜 멱등**
- ✅ 코드 위험 0(이미 검증·리뷰 완료)
- ✅ 잔여 위험이 작고(§2) 대부분 자연 멱등으로 커버, 나머지는 복구 가능
- ⚠️ 지출 생성 크래시-갭 중복(드묾·가시·복구 가능) 잔존 — 단, 선택적 B-특화안으로 닫을 수 있음

## 4. 추천

**C (현행 유지 + 문서화)**, 그리고 지출 생성의 잔여 위험을 정말 닫고 싶으면 **B-특화안(지출 한정)** 만 추가.

근거(유지보수성·DX 우선):
1. 범용 미들웨어는 깨끗하고 재사용·확장 친화 — 신규 라우트가 멱등을 공짜로 얻는다. A/B는 이 자산을 침식(A=암묵 매직, B=라우트별 결합).
2. 진짜 원자성의 비용(장기 락·ambient 매직·대규모 재작성)은 **영구적 세금**인데, 막는 위험은 **드물고 bounded·복구 가능**.
3. 정산/이체는 이미 비즈니스 자연 멱등 → A의 광범위 원자성은 대부분 불필요한 일.
4. 유일한 실위험(지출 생성)은 단일 라우트 B-특화안(`(trip_id, idempotency_key)` unique)으로 **국소·저위험**하게 제거 가능 — 전면 리팩터 불요.

## 5. 결정

- [ ] C: 현행 유지 + 본 ADR을 accepted-risk로 채택(코드 변경 0)
- [x] **C + B-특화 (채택·구현)**: 미들웨어 멱등 유지 + 지출 생성에 `expenses(trip_id, idempotency_key)` 부분 unique 마커. `repo.create`가 trip FOR UPDATE 하에서 pre-check(같은 키 라이브 행 → replay) + 키 삽입 → 크래시-갭 중복을 원자적으로 차단. 정산/이체는 비즈니스 자연 멱등이라 추가 작업 불요(§2).
- [ ] B(핵심 라우트 전체) / A(전면) — 비용 대비 권장하지 않음

**구현(2026-06-30):** 마이그레이션 0004(컬럼 + 부분 unique `WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL`) · `ExpenseSnapshot.idempotency_key` · controller가 `Idempotency-Key` 헤더 전달 · repo/controller 테스트(같은 키 replay·다른 키 별개·null 비충돌). 잔여: 미들웨어 멱등의 at-least-once 시맨틱은 그대로(비-지출 라우트는 자연 멱등이 커버).

> 미들웨어 멱등의 at-least-once 시맨틱과 §2의 연산별 자연 멱등성은 계약/운영 가정으로 유지된다. 클라이언트는 mutation에 `Idempotency-Key`를 보내고, 5xx/네트워크 실패 시 **같은 키로 재시도**한다.
