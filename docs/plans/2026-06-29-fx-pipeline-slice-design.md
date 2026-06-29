# trip-mate-api FX 파이프라인 슬라이스 구현 설계

- 작성일: 2026-06-29
- 대상: `trip-mate-api` — 두 번째 구현 슬라이스(기반 슬라이스 위)
- 기반 SSOT: `docs/plans/2026-06-25-fx-pipeline-design.md`(FX 기술설계, Codex 9건 hardening) · 정산엔진 §2.1(converted 정수 산식) · DB 설계(`exchange_rate*` 컬럼·`currencies` 룩업)
- 선행: 기반 슬라이스가 trip-mate-api `main`에 병합됨(commit 62cef97). `exchange_rate`(numeric 20,10)·`exchange_rate_date/source/provider/table_date/fetched_at`·`settlement_amount_source`·`fx_by_source` CHECK·`currencies.minor_unit`·`rateSourceEnum`(identity 포함) 존재. **trip_default 테이블·round-half 헬퍼·ofetch/redis/decimal은 미존재(이 슬라이스가 도입).**
- 성격: 새 기술설계가 아니라 hardening된 FX 기술설계를 구현으로 옮기는 슬라이스의 범위·순서·신규 의존성 정의.

## 1. 확정된 결정 (사용자 승인 2026-06-29)

| 결정 | 선택 | 근거 |
|---|---|---|
| 범위 경계 | **FX 해결·동결 모듈 격리** | `resolveFx(입력)→동결필드`. expense 저장경로(서비스/라우트)는 아직 미설계 → 후속 API 슬라이스. 모듈+계약 단위로 자기완결 검증 |
| Valkey 캐시 테스트 | **CachePort + in-memory fake + testcontainers redis** | repo-port 패턴(architecture §10.2) 일관. 단위는 fake, redis(Valkey) 어댑터는 testcontainers 통합 1세트. `ioredis` 추가 |
| trip_default | **신규 `trip_fx_defaults` 테이블 추가** | 4단계 체인 ⑤ 완성(FX 설계 §5). best-effort 시드/승격은 모듈 함수(트리거 아님) |
| cross-rate 산술 | **decimal.js** | FX 설계의 "고정밀 Decimal" 직역. 나눗셈(usd[quote]/usd[base])·반올림 가독·정확 |

## 2. 모듈 구조 (architecture §4.1 수직 슬라이스, functional core / imperative shell)

```
src/modules/fx/
├─ fx.types.ts              # FxInput·FxResult·UsdTable·FxProvider(포트)·CachePort(포트)·브랜디드 통화
├─ domain/
│  ├─ convert.ts            # round-half-away-from-zero + converted 정수 산식 + crossRate (순수·decimal.js)
│  └─ convert.test.ts
├─ provider/
│  ├─ oxr.ts                # OXR primary 어댑터 (ofetch)
│  ├─ currencyapi.ts        # currencyapi secondary 어댑터 (ofetch)
│  └─ provider.test.ts      # fetch mock: 스키마·9통화 검증·부분테이블→null·failover
├─ cache/
│  ├─ cache.port.ts         # CachePort 인터페이스
│  ├─ cache.redis.ts        # ioredis(Valkey) 어댑터
│  ├─ cache.memory.ts       # in-memory fake (단위·테스트)
│  └─ cache.test.ts         # testcontainers redis(실어댑터) + fake parity
├─ fx.service.ts            # resolveFx: 4단계 우선순위 체인
├─ fx.service.test.ts       # 체인 분기(provider mock·fake cache·trip_default)·max-age 결정성·card_billed skip
└─ trip-defaults.repo.ts    # trip_fx_defaults 포트+drizzle (get/upsert·best-effort 시드·승격)
src/db/schema/fx.ts          # trip_fx_defaults 테이블 (+ index.ts 재export·마이그레이션)
```

## 3. converted 정수 산식 (`domain/convert.ts` — 순수·decimal.js)

- `roundHalfAwayFromZero(d: Decimal): bigint` — 절댓값 0.5 올림, 음수 대칭(환불).
- `convert({ localMinor: bigint, rate: Decimal, localExp: number, settleExp: number }): bigint` = `round_half_away(localMinor × rate × 10^(settleExp − localExp))`.
- `crossRate(usd: UsdTable, base, quote): Decimal` = `usd[quote] / usd[base]` (precision ≥ 10dp).
- identity(base==quote): rate=1, settleExp==localExp → settlementMinor = localMinor.
- 테스트: §13.3(1,000 THB·rate 37.9·THB exp2·KRW exp0 → 37,900 KRW), cross-rate 저→고가 정밀(VND→GBP/CHF), round-half 음수 대칭, identity.

## 4. FxProvider 포트 + 어댑터 (`provider/`)

- `interface FxProvider { getUsdTable(date: Date): Promise<Record<Currency, Decimal> | null> }`.
- OXR: ofetch `GET /historical/:date.json?app_id&base=USD`(재시도·타임아웃). currencyapi: secondary.
- **테이블 검증(§4.2):** 지원 9통화 전부 present·양수·non-null·파싱가능 → 성공만 캐시/last_known. 하나라도 미달이면 부분테이블 → null(다음 provider failover).
- 키는 SealedSecret(env), 테스트는 fetch mock(키 불필요·학습 미사용 무관).
- 테스트: 성공/부분테이블→null/네트워크 장애→failover, 응답 스키마.

## 5. CachePort + 어댑터 (`cache/`)

- `CachePort`: `getUsdTable(date)`·`setUsdTable(date, table, ttl)`·`getLastKnown()`·`setLastKnown(table, tableDate, fetchedAt)`.
- 키: `fx:usdtable:{date}`(과거=장기 TTL·당일=단기), `fx:lastknown:usdtable`.
- redis 어댑터(ioredis, Valkey 호환) + in-memory fake.
- 테스트: testcontainers redis로 실어댑터 round-trip + fake가 동일 계약 충족(parity).

## 6. resolveFx 서비스 (`fx.service.ts` — 4단계 체인, FX 설계 §2)

입력 `FxInput`: `{ localMinor, localCurrency, settlementCurrency, date(현지 일자), manualRate?, settlementAmountSource, localExp, settleExp, tripId }`. 의존(포트 주입): provider(primary·secondary)·cache·trip-defaults repo.

- **card_billed** → FX skip(카드 청구액 그대로), `exchange_rate=null·source=null`.
- **converted 체인:** ⓪ identity(base==quote→rate=1, 체인 우회) → ① manual(입력 rate) → ② cache HIT(교차계산, source=auto) → ③ provider(primary→secondary, 검증 통과 시 cache+last_known 갱신, source=auto) → ④ last_known(`|table_date − date| ≤ MAX_AGE_DAYS`=7, source=last_known) → ⑤ trip_default(쌍별, source=trip_default) → ⑥ 모두 실패 → `needsManual` 신호(throw 아님, 저장 비차단 — 사용자 manual 입력 요구).
- 반환 `FxResult`: `{ exchange_rate(string for numeric), exchange_rate_date, exchange_rate_source, exchange_rate_provider?, exchange_rate_table_date?, exchange_rate_fetched_at?, settlement_amount(bigint) }` 또는 `{ needsManual: true }`. source ∉ {manual, auto, identity} → UI 경고 플래그(반환 메타).
- provenance: auto/last_known → provider·table_date·fetched_at 채움. identity/manual/trip_default → provider null.
- 테스트: 각 분기(provider mock·fake cache·trip_default repo), max-age 초과→강등, card_billed skip, 동일통화 identity, 전부 실패→needsManual, 결정성(같은 입력→같은 판정).

## 7. trip_fx_defaults 테이블 (`src/db/schema/fx.ts`)

- 컬럼: `trip_id`·`base_currency`·`settlement_currency`·`rate numeric(20,10)`·timestamps.
- 복합 PK `(trip_id, base_currency, settlement_currency)`. FK: `trip_id→trips(id) cascade`, `base_currency`/`settlement_currency`→`currencies(code)`.
- drizzle-kit 마이그레이션(기존 0000 다음 0001). repo(get/upsert). best-effort 시드(여행방 생성 시 1쌍 시도, 실패 비차단)·쌍별 승격(첫 auto 성공값)은 모듈 함수 — **이 슬라이스는 함수+테스트만, 여행방 생성 훅 연결은 후속**.

## 8. 신규 의존성

`ofetch`(외부 HTTP)·`decimal.js`(고정밀)·`ioredis`(Valkey). 전부 테스트는 mock/testcontainers라 실 키·실 redis 불필요(로컬은 testcontainers).

## 9. 테스트 전략 요약

| 대상 | 방식 |
|---|---|
| domain/convert | 순수 단위(§13.3·cross-rate 정밀·round-half·identity) |
| provider | fetch mock(스키마·9통화·부분테이블→null·failover) |
| cache | testcontainers redis 실어댑터 + fake parity |
| fx.service | 체인 분기·max-age 결정성·card_billed skip·needsManual |
| trip_fx_defaults | testcontainers PG16(기존 helpers 확장): 마이그레이션 적용 + 복합 PK·composite FK(trip cascade·currency) introspection/negative |

DoD: `bun run check` green + `bun run test` green + 0001 마이그레이션 PG16 클린 적용 + `db:generate` idempotent.

## 10. 제외 (후속 슬라이스)

expense 저장경로/서비스/라우트 통합 · OpenAPI 생성 · 편집 재계산 트리거(FX 설계 §6, 저장경로 슬라이스) · 여행방 생성→trip_default 시드 훅 연결 · 실 OXR/currencyapi 키·호출(mock만) · 레이트리밋/비용 상한 운영(모니터링 슬라이스).

## 11. 다음 단계 (hardened-planning)

본 설계 확정(승인 완료) → (선택) Phase A.5 → Phase A.7 `trip-mate-api` feat/fx-pipeline 워크트리 → Phase B writing-plans(`trip-mate-api/docs/plans/2026-06-29-fx-pipeline.md`) → Phase C Codex 적대적 리뷰 → Phase D 확정·executing-plans 핸드오프.
