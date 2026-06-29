# trip-mate 정산 엔진 설계 (computeSettlement)

- 작성일: 2026-06-25
- 대상: `trip-mate-api` 정산 도메인 순수 함수(functional core)
- 기반: PRD §18(정산 계산)·§48(통화 최소단위)·§47(환불), DB 설계 `2026-06-25-trip-mate-db-design.md`
- 성격: **IO 없는 순수 함수, BigInt 정수, 결정적**(스냅샷 재현 §31). 부동소수점 0.

## 1. I/O 계약

```ts
// 입력: 서비스가 부분 인덱스로 필터한 "정산 포함·미삭제" expenses (+참여자)
computeSettlement(input: {
  expenses: Array<{
    id: ExpenseId
    paid_by: MemberId
    participants: MemberId[]                 // ≥1 (검증됨)
    local: Money                             // Money = { amount: Minor(bigint), currency }
    settlement: Money                        // settlement.currency = trip 정산통화(단일)
    refund_of?: ExpenseId                    // §47 링크된 환불(하이브리드 분배)
  }>
  members: MemberId[]
}): {
  settlement: AxisResult                     // 1통화(trip 정산통화)
  local: Record<Currency, AxisResult>        // 통화별(Phase3 다통화)
}
// AxisResult = { transfers: Transfer[], summaries: Summary[], total: Minor }
// Transfer   = { from: MemberId, to: MemberId, amount: Minor, currency }
// Summary    = { member: MemberId, total_paid, total_share, net: Minor }
```
- 엔진은 **환산을 안 한다.** `settlement.amount`는 저장 시점에 정수로 동결된 값(converted 반올림은 upstream FX). 엔진은 받은 정수만 분배.
- 같은 통화만 합산(Money VO가 컴파일 차단, architecture §10.3). 통화 혼합 시 throw.
- **refund_of 닫힘:** 링크 환불이 입력에 있으면 그 원지출(+참여자)도 입력에 포함된다(서비스가 보장, §6.3). 닫힘 위반 시 엔진은 `SettlementInvariantError`.

## 2. 지출별 분배 (§18.2.2)

```ts
function splitExpense(amount: Minor, members: MemberId[]): Map<MemberId, Minor> {
  const n = BigInt(members.length)
  const base = floorDiv(amount, n)            // ★ -∞ floor (BigInt '/'는 0 방향 절삭)
  const remainder = amount - base * n         //   0 ≤ remainder < n (음수에도 성립)
  const sorted = [...members].sort(byIdAsc)   // D1: member_id 오름차순(결정적)
  return new Map(sorted.map((m, i) => [m, base + (BigInt(i) < remainder ? 1n : 0n)]))
}

function floorDiv(a: Minor, b: Minor): Minor { // b > 0
  const q = a / b, r = a % b
  return (r !== 0n && r < 0n) ? q - 1n : q     // 음수 몫을 -∞ 방향으로 보정
}
```
- **gotcha:** JS `BigInt` 나눗셈은 0 방향 절삭(`-100n/3n = -33n`). 환불(음수)에서 잔여 불변식이 깨지므로 **-∞ floor 직접 구현**.
  - 양수: 10,000/3 → base 3,333, r=1 → `3,334 / 3,333 / 3,333`
  - 음수: −10,000/3 → base −3,334, r=2 → `−3,333 / −3,333 / −3,334`
- 불변식: `Σ(분배몫) == amount` (어서션, 위반 시 `SettlementInvariantError`).

### D1 — 잔여 배분: member_id asc 유지 (확정)
나머지 +1은 항상 member_id 오름차순 앞에서부터. uuid v4(여행방마다 랜덤)라 실사용자 편향이 누적되지 않고, 불공정액은 여행당 수십 원. 회전(지출 해시) 대안은 해시 함수를 스냅샷 계약에 영구 결합시키는 비용 대비 이득이 없어 기각. **추후 회전 추가 시에도 과거 스냅샷은 불변**(신규 계산에만 적용).

## 3. 멤버별 집계 (§18.2.3)

```
total_paid[m]  = Σ(m이 결제자인 지출 amount)
total_share[m] = Σ(m이 참여자인 지출에서 splitExpense 결과의 m 몫)
net[m]         = total_paid[m] − total_share[m]
```
- 불변식: `Σ net == 0` (축·통화별). 어서션 위반 시 `SettlementInvariantError`.

## 4. 최소 송금 (§18.4) — greedy

```ts
function minTransfers(net: Map<MemberId, Minor>, currency: Currency): Transfer[] {
  const cred = entries(net).filter(v > 0n).sort(amtDesc, idAsc)         // 채권자(받을)
  const debt = entries(net).filter(v < 0n).map(negate).sort(amtDesc, idAsc) // 채무자(보낼)
  const out: Transfer[] = []
  let i = 0, j = 0
  while (i < cred.length && j < debt.length) {
    const give = min(cred[i].amt, debt[j].amt)
    out.push({ from: debt[j].id, to: cred[i].id, amount: give, currency })
    cred[i].amt -= give; debt[j].amt -= give
    if (cred[i].amt === 0n) i++
    if (debt[j].amt === 0n) j++
  }
  return out
}
```
- 정수 연산이라 매 단계 ≥1명 잔액 0 → **≤ (n−1)건**·결정적.
- **greedy 채택(확정):** 이론적 최소 거래수는 NP-hard(subset-sum). greedy의 ≤n−1·결정성이 실용 표준(Splitwise 류). 최적화는 복잡도/비결정성 손해가 큼.

## 5. 이중 축 / 다통화 (§18.2.4)
- `settlement` 축(1통화=trip 정산통화) + `local` 축. local은 **통화별 독립 서브축**(Phase3 다통화). 각 축이 §2~§4를 독립 실행 → 송금 그래프가 서로 다를 수 있음(정상, §18.6, 실제 송금 기준은 settlement 축 하나).
- 각 축의 `total` = Σ(정산 대상 지출 amount). settlement 축 total → `settlements.total_settlement_amount`, local 축 통화별 total → `settlement_currency_totals`.

## 6. 환불 분배 (§47) — D2 하이브리드 (확정, pass1 정밀화)

### 6.1 링크된 환불 (`refund_of` 있음) → 원지출 미러링
환불은 **개별 행이 아니라 원지출 단위로 누적 처리**한다(리뷰 pass2 — 다중 분할환불 합성 정확성). `refund_of`로 묶어:
- **검증:** 환불 행 음수 · 원지출 양수 · 통화 일치 · `paid_by == 원지출 paid_by`(환불은 원 결제자 환급, pass1 #2) · **누적 환불액 ≤ 원지출액**. 위반 시 `ValidationError`. (미러는 share만 상쇄, paid는 별도 집계되므로 payer 불일치 시 `Σnet`≠0·허위 송금)
- **누적 apportionment:** 누적 환불액 `R = Σ(해당 원지출의 환불 amount)`(음수)를 원 split에 정수 apportion → `cumShare[m]`:
  ```
  q[m]    = |R| × origShare[m] / |origAmount|        // 유리수 quota
  base[m] = floor(q[m]); 잔여 = |R| − Σ base
  잔여를 (소수부 desc, 동률 member_id asc) 1단위씩 배분 → |cumShare[m]|, 부호 음수
  어서션: Σ cumShare == R
  ```
- **행별 share = 누적 델타:** 각 환불 행 share = (그 행까지 누적 cumShare) − (직전까지 누적 cumShare). 행 순서는 결정적 정렬(환불 spent_at, 동률 id). → 분할 환불이 **합성해도 원 split을 정확히 미러**.
- **전액 환불**(누적 = 원액) → `cumShare == 원 split의 정확한 음수` → 전원 net 0.
- 예: 원 34/33/33(=100), −50 두 번. 누적 −50 → −17/−17/−16. 누적 −100 → −34/−33/−33. 2번째 행 델타 = (−34/−33/−33)−(−17/−17/−16) = **−17/−16/−17**. 합 −34/−33/−33 = 원 미러 ✓ (phantom 0)

### 6.2 언링크 음수 지출 (원지출 없는 할인·조정) → §2 독립 균등 분배

### 6.3 입력 닫힘 (리뷰 #3)
링크 환불의 **원지출(+참여자)은 정산 입력 집합에 항상 포함**되어야 한다(서비스 쿼리가 `refund_of` 닫힘 보장). 원지출이 soft-deleted/제외(personal·record_only)면 그 환불도 정산 비포함(무효). 엔진은 원 split을 입력에서 재계산하므로 원지출 부재 시 계산 불능 → 서비스가 닫힘을 강제하고, 엔진은 부재 시 `SettlementInvariantError`.

- 모델은 `refund_of_expense_id` nullable로 두 분기를 수용(DB 설계 §2.2). **환불 기능은 Phase 3**, 본 의미론만 지금 계약 고정.

## 7. 불변식 & 결정성
| 불변식 | 강제 |
|---|---|
| `Σ(분배몫) == 지출 amount` (지출별) | splitExpense 어서션 → `SettlementInvariantError` 저장 차단 |
| `Σ net == 0` (축·통화별) | 집계 어서션 → `SettlementInvariantError` |
| 송금 ≤ (n−1)건, from≠to, amount>0 | minTransfers 구조상 보장 + 테스트 |
| 동일 입력 → 동일 출력(스냅샷 재현 §31) | 정렬 키로만 순회(Map iteration 순서 의존 금지), 부동소수점 0 |

## 8. property 테스트 매트릭스
- **케이스:** n=1 / 나눠떨어짐·안떨어짐 / 음수(환불, floor 보정) / 동일 결제자 / 결제자가 참여자 아님 / 순환 채무(A→B→C) / 2·3·N명 / 다통화 local / 전액·부분 환불(미러링) / 언링크 음수 / **부분환불 apportionment 잔여** / **다중 분할환불 합성=원 정확 미러(phantom 0)** / **over-refund(누적>원액) → 거부** / **refund.paid_by ≠ original.paid_by → 거부** / **원지출 soft-deleted·제외 → 환불 무효**.
- **property(불변식):**
  - `Σ share == amount` (∀ 지출, 양·음수)
  - `Σ net == 0` (∀ 축·통화)
  - `transfers.length ≤ members − 1`, 모든 transfer `from≠to ∧ amount>0`
  - **결정성:** 동일 입력 → 동일 출력(입력 순서 셔플해도 동일)
  - **round-trip:** 산출된 transfer를 net에 적용하면 전원 0
  - **환불 미러링:** 전액 환불 시 원지출+환불 net == 0 (∀ 멤버, 찌꺼기 0)
- 수용 기준: 합계오차 허용 = 0 (PRD §35.4).

## 9. 결정 로그
| 결정 | 선택 | 기각 |
|---|---|---|
| 잔여 배분(D1) | member_id asc(PRD) | 지출 해시 회전(계약 결합 비용 > 이득) |
| 최소 송금 | greedy 결정적(≤n−1) | 이론적 최소(NP-hard·비결정) |
| 환불 분배(D2) | 하이브리드(링크=미러링·언링크=균등) | 일괄 독립균등(전액환불 찌꺼기) |
| floor | -∞ floor 직접 구현 | BigInt 기본 절삭(음수 오류) |
| 환산 책임 | upstream(저장 시 동결), 엔진은 정수만 분배 | 엔진 내 환산(IO·비결정 유입) |

## 10. 적대적 리뷰 디스포지션 (Codex, 3 passes → approve)

`hardened-planning` Codex 적대적 리뷰(branch mode, `--kind design`). 수렴 **3→1→0(approve)**. 4건 finding 전부 Accept·반영, 전부 **환불(D2) 의미론 정밀화**에 집중.

| pass | # | finding | sev | 결정 | 반영 |
|---|---|---|---|---|---|
| 1 | 1 | 부분환불 비례+반올림이 minor 생성/손실 | high | Accept | 정수 apportionment(floor+largest-remainder, Σ==R 어서션) |
| 1 | 2 | 전액환불이 payer 제약 없이는 net 0 아님 | high | Accept | `refund.paid_by == original.paid_by` 강제 |
| 1 | 3 | 링크환불의 원지출이 입력에 미보장 | med | Accept | 입력 계약 `refund_of` 닫힘(원지출+참여자 포함) |
| 2 | 4 | 다중 부분환불이 합성 안 됨(phantom 송금) | high | Accept | **원지출 단위 누적** apportionment + 행별 누적 델타 |
| 3 | — | (없음) | — | approve | — |

최종 pass3 `verdict: approve` — "cumulative per-original refund contract preserves integer conservation, installment behavior, deterministic ordering."

## 11. 다음 단계 (handoff)
- 이 문서는 **Codex 적대적 리뷰로 approve된 정산 엔진 설계**다. `settlements` 모듈의 `domain/compute.ts` 순수 함수로 구현(architecture §4.1).
- 구현 시 **TDD**(property-based 우선, §8 매트릭스): 불변식(Σshare==amount·Σnet==0·결정성·≤n−1)을 fast-check 등으로, 환불 케이스(누적·over-refund·payer 불일치·입력 닫힘) 명시 테스트.
- DB 설계 §7(동시성)·§10(불변식 강제)과 함께 finalize 트랜잭션에서 호출.
