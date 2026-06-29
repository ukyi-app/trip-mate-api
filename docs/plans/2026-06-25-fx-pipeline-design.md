# trip-mate 환율(FX) 파이프라인 설계

- 작성일: 2026-06-25
- 대상: `trip-mate-api` 환율 해결·동결(지출 저장 시점)
- 기반: PRD §14(환율 적용)·§18.5(정산통화 출처)·§13.3, DB 설계(`exchange_rate`/`exchange_rate_date`/`exchange_rate_source`), 정산 엔진 설계(converted 정수 산식), FX 벤더 조사(2026-06)
- 성격: 외부 의존 격리 + 결정적 동결. 정산 엔진은 동결된 `settlement_amount` 정수만 소비(FX를 모름).

## 1. 책임 & 타이밍
- FX 파이프라인은 **지출 저장 시점에 환율을 해결·동결**한다(PRD §14.3: 이후 자동 재조회로 덮어쓰지 않음).
- **`converted` 지출만** 대상. `card_billed`는 카드사 청구액 그대로 → FX 미호출, `exchange_rate=null`(참고용 effective rate는 선택 저장). 근거: 외부 API는 mid-market EOD라 카드 명세 환율과 다름 → `card_billed` 우선(§18.5)이 옳음.
- 동결 필드: `exchange_rate`(**numeric 20,10 — authoritative 고정밀**, display는 렌더 시 반올림) · `exchange_rate_date`(date, 지출 현지 일자) · `exchange_rate_source`(enum, **card_billed면 null**: `identity|manual|auto|last_known|trip_default`) · `settlement_amount`(bigint minor).
- **provenance(감사·stale, 리뷰 #4):** fallback/auto 시 추가 기록 — `exchange_rate_provider`(oxr|currencyapi|null) · `exchange_rate_table_date`(rate가 실제로 나온 테이블 일자 — fallback이면 `exchange_rate_date`와 다름) · `exchange_rate_fetched_at`. identity/manual은 provider null. (DB 컬럼·source별 CHECK는 §10)

## 2. 4단계 우선순위 해결 (§14.3)
```
입력: base=local_currency, quote=settlement_currency,
      date = (spent_at AT TIME ZONE trips.timezone)::date,   // 현지 일자
      (선택) manual_rate
⓪ base == quote (동일통화)                      → rate=1, source=identity, 체인 우회(settlement_amount = local_amount)
① manual_rate 있음                              → rate, source=manual
② 캐시 HIT  fx:usdtable:{date}                  → rate(교차계산), source=auto
③ provider.getUsdTable(date) [primary→secondary]
     검증 통과(§4.2) → 캐시 저장 + last_known 갱신 → rate, source=auto
     검증 실패/장애 → 다음 provider; 모두 실패 ↓  (부분 테이블은 캐시·last_known 미기록)
④ last_known fx:lastknown:usdtable (max-age 이내 §3) → rate(교차), source=last_known
⑤ trip_default[(trip,base,settlement)] (있으면)  → rate, source=trip_default
⑥ 모두 없음 → manual 환율 입력 강제(저장 차단 아님 — 사용자 입력 요구)
→ settlement_amount = round_half_away( local_minor × rate × 10^(settle_exp − local_exp) )  // 엔진 §2.1
→ source ∉ {manual, auto} 이면 UI "대체 환율로 계산됨" 표시(§14.3)
```
- `rate`(local→settlement)는 USD 테이블에서 교차: `rate = usd[quote] / usd[base]`. **고정밀 Decimal로 계산해 `exchange_rate`(numeric 20,10)에 authoritative로 동결**하고 그로부터 settlement_amount 산출. display는 렌더 시 반올림, **편집 재계산도 이 동결값 사용**(§4.3·§6).

## 3. 캐시 설계 (Valkey)
- **`fx:usdtable:{date}`** → 그 날짜의 USD 기준 전 통화 1행(JSON). 한 번의 provider 호출 결과를 통째로 캐시 → **모든 통화쌍을 1회 호출로 커버**(36쌍도 교차로 파생).
  - **과거 일자 = 불변**(역사 환율) → 장기 TTL/영구. 당일 = 짧은 TTL(일 대표값 확정 전, 익일 0시 이후 freeze).
- **`fx:lastknown:usdtable`** → 매 **검증 성공**마다 갱신(`table_date`·`fetched_at` 함께 저장), 벤더 장애 fallback. **max-age 결정적 계약(리뷰 pass2 #2):** 적용 가능 조건 = `|last_known.table_date − exchange_rate_date| ≤ MAX_AGE_DAYS`(설정값 기본 7, **이하** 포함). 즉 "now−fetched_at"이 아니라 **테이블 일자와 지출 일자의 격차**가 기준 → 같은 입력에 항상 같은 판정. 초과 시 last_known 미적용 → ⑤ → ⑥.
- 효과: **통화쌍 무관, 일자당 1 외부 호출** → 비용·레이트리밋 통제(§22.4). OXR 무료 1,000 req/월 대비 30일 여행 ≈ 30 req.

## 4. 벤더 (전략 포트, 오픈이슈 #1 해결)
```ts
interface FxProvider {
  getUsdTable(date: Date): Promise<Record<Currency, Decimal> | null>  // USD 기준 전 통화
}
```
- **primary = Open Exchange Rates (OXR)** — `/historical/:date.json`, 무료 Forever Free(1,000 req/월·historical 포함), 9통화 전부(TWD·VND 포함), USD base 강제(교차로 해결). 한 호출이 전 통화 반환.
- **secondary = currencyapi.com** — 9통화·historical 무료(단 300 req/월). OXR 장애 시 전략 포트로 폴백.
- ofetch(재시도·타임아웃). 키는 SealedSecret.
- **탈락:** Frankfurter(ECB — TWD·VND historical 없음, `not found` functional test 확인). Fixer/exchangerate.host/currencylayer(무료 100 req/월·base 게이팅).

### 4.1 조사 caveat (구현 전 확인)
- **확인 호출 1회:** OXR 무료가 특정 과거일 **TWD·VND를 non-NULL**로 주는지 1회 테스트(카탈로그엔 있으나 historical sparse 가능성, 낮음).
- 가격/한도는 2026-06 기준 시간 민감 → 착수 시 재확인. currencyapi.com은 이름충돌(currencyapi.**NET**/freecurrencyapi) 주의.

### 4.2 테이블 검증 (리뷰 #2)
provider 응답이 "성공"으로 캐시·last_known에 기록되려면 **지원 9통화 전부 present · 양수 Decimal · non-null · 파싱 가능**. 하나라도 미달이면 부분 테이블로 보고 **캐시 안 함 + 다음 provider failover**(sparse historical TWD/VND 오염 방지, 조사 §4.1 caveat). 필요 쌍(base·quote)이 빠지면 그 지출은 auto 불가 → fallback 체인 계속.

### 4.3 cross-rate 정밀도 + authoritative 저장 (리뷰 pass2 #3 + pass3 #1)
저→고가 통화쌍(예: VND→GBP/CHF, 1 VND ≈ 0.000032 GBP → 6dp는 유효숫자 2자리)에서 `numeric(18,6)`은 coarse → settlement drift. 따라서 **`exchange_rate`를 `numeric(20,10)` authoritative**로 동결하고(고정밀 cross-rate), settlement_amount·**편집 재계산 모두 이 값에서 산출**. display는 렌더 시 반올림. (별도 display 필드 대신 단일 고정밀 필드 — 편집 재계산이 lossy rate를 재사용하지 않음, pass3 #1.) 테스트에 최소 cross-rate 쌍(VND→GBP/CHF) 포함.

## 5. trip_default — best-effort 하이브리드 (D1 확정, 리뷰 #3 정정)
- **쌍별 키:** `trip_default(trip_id, base_currency, settlement_currency) → rate`. 다통화 여행(§17.2)에서 지출 통화마다 다른 default를 가짐(단일쌍 가정 제거).
- **생성 시 best-effort 시드:** 여행방 생성 시 `(primary_local, settlement)` 쌍을 1회 시도 → 성공 시 그 쌍 trip_default 세팅, **실패해도 생성은 진행**.
- **첫 자동조회 성공 시 쌍별 승격:** 각 `(base,settlement)` 쌍의 첫 성공값을 그 쌍 trip_default로 등록·갱신.
- **정직한 불변식(거짓 "항상 존재" 제거):** 특정 쌍의 trip_default가 **없을 수 있다**(시드 실패 + 그 쌍 첫 fetch 전 + 다통화 새 통화). 이 경우 fallback 체인 끝은 trip_default가 아니라 **manual 입력 강제**(§2 ⑥) — 저장을 차단하지 않되 사용자 환율 입력을 요구한다.

## 6. 편집 재계산 매트릭스
| 변경 | 동작 |
|---|---|
| local_amount만 | 동결 `exchange_rate`(고정밀 §4.3) 유지, settlement_amount만 재계산(정확) |
| spent_at(일자 변동) / 통화 | rate **재해결**(새 date·쌍) |
| manual rate 입력/수정 | source=manual, settlement_amount 재계산 |
| title/memo/category | FX 무관 |
- 재계산은 정산 `open` 상태에서만(확정 후엔 잠금, DB 설계 §7).

## 7. 실패·격리
- 벤더 timeout/error/부분테이블 → 다음 provider → ④ last_known(max-age 이내) → ⑤ trip_default(쌍별, 있으면) → ⑥ manual 강제. **저장 비차단**(최후엔 사용자 입력).
- source가 auto/identity가 아니면 UI 경고(§14.3). provenance(provider·table_date·fetched_at)로 감사·stale 판정.
- 레이트리밋/비용 상한: 캐시로 호출 최소화 + provider별 월 한도(OXR 1,000/currencyapi 300) 모니터·소진 시 failover(§46).

## 8. 테스트 고려
- 단위: identity(base==quote→1), 교차계산, converted 정수 산식(엔진 §2.1 round-half-away), 우선순위 분기(⓪~⑥).
- 통합: provider mock(성공/장애/**부분테이블→캐시 안 함·failover**), 캐시 HIT/MISS, last_known(**max-age 초과→강등**)·trip_default(**쌍별·없음→manual**) fallback, 현지 TZ 일자(자정·DST 경계).
- 계약: OXR/currencyapi 응답 스키마·9통화 검증, TWD·VND non-NULL 확인 호출, provenance(provider·table_date·fetched_at) 기록 검증.

## 9. 결정 로그
| 결정 | 선택 | 근거 |
|---|---|---|
| 벤더 primary | OXR | 9통화·historical 무료 1,000 req/월·일자당 1호출 |
| 벤더 secondary | currencyapi.com | 9통화·historical 무료(300/월), 전략 포트 폴백 |
| 캐시 키 | `fx:usdtable:{date}` | USD 테이블 1행→전 통화쌍, 호출 최소 |
| 교차환율 | USD base + 고정밀 Decimal 교차 | 무료티어 base 강제; settlement_amount는 고정밀 산출(6dp 누적 차단 §4.3) |
| trip_default(D1) | best-effort 하이브리드 + 쌍별 키 | 안전망 + 생성 비차단 + 신선도(다통화 수용) |
| 동일통화 | identity 분기(rate=1, 체인 우회) | 외부 호출 불필요·결정적 |
| provider 신뢰 | 9통화 검증 통과만 캐시/last_known + last_known max-age | 부분/stale 테이블 오염 차단 |
| converted 책임 | 저장 시 동결, 엔진은 정수만 | IO·비결정 유입 차단 |

## 10. DB 계약 (DB 설계 doc·architecture enums 반영 완료)
- `exchange_rate`: **`numeric(20,10)` authoritative 고정밀**(pass3 #1) — settlement_amount·편집 재계산의 기준. display는 렌더 시 반올림.
- `exchange_rate_source`: enum에 **`identity`** 추가(동일통화), **nullable**(card_billed, pass3 #2).
- provenance 컬럼: `exchange_rate_provider`(text) · `exchange_rate_table_date`(date) · `exchange_rate_fetched_at`(timestamptz).
- **settlement_amount_source 연계 CHECK(pass3 #2):**
  - `card_billed` → `exchange_rate`·`exchange_rate_source`·provenance **null 허용**(FX 미적용).
  - `converted` → `exchange_rate` NOT NULL · `exchange_rate_source` NOT NULL.
  - provenance: `auto`/`last_known` → provider·table_date·fetched_at NOT NULL; `identity`/`manual`/`trip_default` → provider null.

## 11. 적대적 리뷰 현황 (Codex, branch mode)

pass 1(4)·pass 2(3) 반영, pass 3(2) 일시 중단 후 **반영 완료**. 총 9건 Accept·반영(수렴 4→3→2).
- pass3 #1 authoritative 고정밀 rate → `exchange_rate numeric(20,10)`, 편집 재계산이 동결값 사용(§4.3·§6·§10).
- pass3 #2 card_billed source 계약 → `exchange_rate_source` nullable + settlement_amount_source 연계 CHECK(§10).
