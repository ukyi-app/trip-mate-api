---
bugfix: expense-mutation-authz
invariant-class: bugfix
entry-track: bug
review-track: full
pipeline-stage: release-gate
issue-tracker: local
symptom: "여행방의 임의 joined 멤버가, 자신이 작성하지도 결제하지도 않은 남의 지출을 PATCH·DELETE로 수정·삭제할 수 있다(현재 200 성공). admin이거나 작성자이거나 결제자가 아니면 403이어야 한다."
red-baseline: 81b6666a8d5187541b15315de7da98a9000f2b05
bugfix-lock: red
first-increment: [I-1]
increments: [I-1]
spike-1:
---

## Root cause

`PATCH /v1/trips/{tripId}/expenses/{expenseId}`와 `DELETE ...`의 라우트 미들웨어가
`[auth, member]`뿐이다(`src/modules/expenses/expenses.controller.ts:173,194`). 서비스
`ExpensesService.updateExpense`/`deleteExpense`(`expenses.service.ts:315-422`)는 넘겨받은
`actor.memberId`를 오직 `last_modified_by_member_id`(`expenses.repo.ts:355,472`)와 감사로그
`changed_by_member_id`(`:428,487`)에만 기록할 뿐 **소유권 검사가 없다.** 결과적으로 `member`
미들웨어를 통과한 여행방 멤버라면 누구든 남의 지출을 수정·삭제할 수 있다.

PRD §9.3(`~/workspace/trip-mate/docs/trip-mate-prd.md:406-418`)은 일반 멤버에게 "본인이 작성했거나
본인이 결제자인" 지출의 수정/삭제만 허용하고, §9.2는 admin에게 전권을 준다. 채택 진단:
`~/workspace/trip-mate/docs/plans/2026-07-09-backend-expense-identity-authz-design.md §B-2.1 (G3)`.
컨덕터가 기준 커밋 `d1a64a3`에서 모든 파일:라인을 재확인함.

**메커니즘이지 증상이 아님**: 증상은 "200으로 성공"이고, 메커니즘은 "서비스 변경/삭제 경로에 인가 술어가
부재"다. 미들웨어를 admin-only로 바꾸는 건 오답(작성자·결제자도 허용해야 함) — 인가는 대상 지출의
`created_by`/`paid_by`와 actor를 비교해야 하므로 **서비스 레이어**가 올바른 seam이다.

## The fix

`updateExpense`/`deleteExpense`의 **첫 단계**로 소유권 인가 술어를 평가한다:

```
allow(update|delete) ⇔ actor.role === "admin"
                     ∨ expense.created_by_member_id === actor.memberId
                     ∨ expense.paid_by_member_id     === actor.memberId
그 외 → 403 ForbiddenError (RFC 9457 problem+json — errors.ts:19에 이미 존재)
```

seam·제약(정확한 코드 형태는 구현자 재량, 아래 불변식 준수):

1. **평가 위치 — 잠금/버전보다 먼저.** 인가는 `assertTripOpen`(finalized `ConflictError` 409)과
   `repo.updateMeta`/`softDelete`의 version CAS보다 **앞서** 실행한다. 비권한자가 잠금 상태나 버전
   충돌을 탐지하지 못하게(정보 누출 차단). 이는 채택 진단 §B-2.1의 명시 요구.
2. **role 배선.** 컨트롤러가 `c.get("membership").role`(guards.ts의 `Membership`이 이미 보유)을
   변경/삭제 서비스 호출에 넘긴다. **생성 경로(`createExpense`)의 actor 계약은 바꾸지 않는다** — 생성은
   인가가 필요 없고, 유일한 모듈 밖 소비처인 `expense-drafts.service.ts:168`(createExpense 재사용)이
   변경되면 안 되므로. 권장: 변경/삭제 전용 actor가 `role`을 **필수로** 갖게 하고(타입이 role 누락을
   막음), 생성 actor는 `{ memberId }` 그대로.
3. **소유권 조회 — DTO 불변.** 대상 지출의 `created_by_member_id`·`paid_by_member_id`만 읽는다.
   현재 `findById`/`COLS`/`ExpenseRow`에는 `created_by_member_id`가 노출되지 않음
   (`expenses.repo.ts:93-111`; 스냅샷 `:28`엔 존재). **응답 DTO(`toResponse`/`expenseResponseSchema`)와
   `ExpenseRow`의 API 표면을 넓히지 말 것** — 작성자/수정자 노출은 별건(G1/B-2.2)이고 이 fix는
   `openapi.json`을 바꾸면 안 된다(403은 이미 `errorResponses(403,…)`로 선언됨: controller `:178,201`).
   권장: 인가 전용 repo 읽기(예: `findMutationAuthz(tripId,id) → {createdBy, paidBy} | null`).
4. **TOCTOU 없음.** `created_by`/`paid_by`는 생성 후 불변(`MetaPatch`에 없음 — `expenses.repo.ts:65-91`).
   따라서 트랜잭션 밖 사전 조회가 안전하다.
5. **부재 지출 → 404 보존.** 인가 조회가 null이면 `NotFoundError`(404) — 현재 동작 유지(멤버는 어차피
   목록/상세 조회로 존재를 알 수 있으므로 존재 은닉은 불필요). 잠금/버전 상태만 은닉 대상.

## Single-Flip Contract

**단일 플립 = 인가 불변식 하나: "비인가 actor는 대상 지출·요청 상태와 무관하게 403."** 근본원인 1개,
증상 여러 개, 전부 하나의 fix-seam diff 안에서 해소된다. 여행방 joined 멤버지만 대상 지출의 **admin도
작성자도 결제자도 아닌** 사용자의 `PATCH`/`DELETE` 결과가:

| 대상 지출 / 요청 상태 | before (현재) | after (fix) |
|---|---|---|
| open trip · fresh version | 200 성공 | **403** |
| **finalized trip** | 409 (finalized) | **403** |
| **stale version** | 409 (version conflict) | **403** |

아래 두 행(409→403)은 authz를 finalized-lock·version-CAS보다 **먼저** 평가하는 순서(설계 §B-2.1의
정보누출 차단 요구)의 **필연적 귀결**이다. 세 행은 모두 동일 근본원인(인가 술어 부재)의 증상 —
비인가 actor는 잠금/버전 상태를 관측할 수 없어야 하고(403이 셋을 구별불가로 만든다), 따라서 하나의
불변식이지 별도 파이프라인이 아니다. (plan-gate P-1 반영.)

- 변경 표면(`scope[]`): `src/modules/expenses/**` — 그 밖의 소스 변경은 두 번째 플립(별도 파이프라인).
- `flips[]`: 1행(근본원인 1개), `symptomToken: G3-AUTHZ`. 세 증상 전부 RED 회귀 테스트로 커버.
  두 엔드포인트 × 세 상태가 한 fix-seam diff 안에서 해소됨을 릴리스 게이트가 확인.

## Preserved Contract

전부 `characterizationCmd`(`vitest run src/modules/expenses src/modules/expense-drafts`)로 GREEN 유지:

- **작성자**의 수정/삭제 → 200 (기존 controller 테스트 `expenses.controller.test.ts:118,135`).
- **결제자(비작성자)**·**admin(비작성·비결제)**의 수정/삭제 → 200 — 기존 스위트에 없던 양성 경로.
  I-1에서 **양성 인가 테스트로 추가**(과차단 방지 증명).
- **비멤버** → 403 (`member` 미들웨어, 불변).
- **부재 지출** → 404 NotFound (불변).
- **인가된 actor의 finalized trip 변경 → 409**(인가 통과 후 잠금 그대로), **인가된 actor의 version 충돌
  → 409.** 이 둘은 이제 비인가 403과 대비되는 경계이므로 I-1에서 **양성 케이스로 명시 테스트**
  (authorized finalized→409, authorized stale→409) — 인가 술어가 잠금/버전 로직을 삼키지 않음을 증명.
- **응답 DTO·`openapi.json` 불변**(작성자/수정자 미노출) — `src/openapi-doc.test.ts`·`expenses-doc.test.ts`
  영향 없음(계약 무변경이라 characterization 대상서 제외해도 안전).
- **expense-drafts confirm 흐름**(createExpense 재사용) 불변 — characterization에 포함해 회귀 감시.

## Regression test (RED at red.sha — P-1 반영 재캡처)

- seam: 컨트롤러 통합(HTTP 상태 블랙박스). `tests/regression/expenses-mutation-authz.test.ts`.
- **6 케이스**(비인가 outsider): `PATCH`·`DELETE` × {open+fresh version, finalized trip, stale version}
  각각 → **403** 기대. baseline에서 각각 200 / 409(finalized) / 409(stale)로 RED.
- `regressionCmd`: `… && bunx vitest run tests/regression/expenses-mutation-authz.test.ts`.
- `symptomToken`: `G3-AUTHZ`(모든 케이스 제목·단언 메시지). RED 출력에 존재.
- RED 증명 레코드 커밋됨(`--verify-red`): regression FAIL@red +토큰, characterization green@red.

## Increment plan

| id | what the fix does here | blocked-by | notes |
|---|---|---|---|
| I-1 | 서비스 변경/삭제 경로에 소유권 인가 술어 추가(finalized-lock·version-CAS보다 **먼저**) + 컨트롤러 role 배선 + 인가 전용 조회(DTO 불변). 회귀 6케이스 GREEN화 + 양성 수용 테스트 추가: 작성자·결제자·admin→200, **인가된 actor의 finalized→409·stale→409**(인가가 잠금/버전을 삼키지 않음 증명) | none | fix-seam = `first-increment`. characterization STAYS GREEN. |

증분 1개 = fix-seam. 종료 후 structure-gate → verification → release-gate.

## Follow-up backlog

- **F-1**: 나머지 신원·인가 발주(B-2.2 Expense DTO 작성자/수정자 노출, B-2.3 my_member_id·/me/invites)는
  이 fix 밖 — net-new 표면이라 gated-pipeline(feature). 이 fix는 인가 술어만.
- **F-2(문서 드리프트, 이 레포 밖)**: 설계문서 후속 F-D3(감사로그 "확장" 오기) 등은 별도.

## Review Decision Log

### Codex Plan Review — r1: needs-attention (1 finding)

- **P-1** (Major / high, `expense-mutation-authz.md:47-49`) — *Single-Flip Contract가 요구되는 409→403
  우선순위 변경을 누락* → **Accept (a안)**. 근거: authz-first 순서는 설계 §B-2.1의 명시 요구이고, 그
  귀결인 비인가 finalized/stale의 409→403은 동일 근본원인(인가 술어 부재)의 증상이다. 조치: Single-Flip
  Contract를 세 상태(open/finalized/stale)로 확장, 회귀 테스트에 outsider finalized/stale→403 RED
  케이스 4개 추가, RED 락 재캡처(red.sha 갱신)+`--verify-red`, plan-gate r2. (사용자 triage 2026-07-09:
  accept as proposed / "권고대로 진행".)

### Codex Plan Review — r2: clean

- P-1 resolved. `verdict: approve`, 0 findings (`docs/reviews/expense-mutation-authz/plan-r2.json`).
  비인가 actor→403을 open/finalized/stale 무관 단일 인가 불변식으로 규정, RED 락 재캡처 @`e469e4b`
  (verify-red: regression FAIL +G3-AUTHZ, characterization green). "No new critical issue."

### Codex Structure Review — r1: clean

- fix-seam(I-1) diff vs main. `verdict: approve`, 0 findings (`docs/reviews/expense-mutation-authz/structure-r1.json`).
  "first-increment diff가 계획된 서비스-레이어 authz seam을 구현, RED 회귀 테스트 무손상, 선언 스코프 내,
  추가 테스트가 내부가 아닌 라우트 레벨 행동을 고정." 컨덕터측 `/code-review`(Spec/Standards)도 사전 통과.
