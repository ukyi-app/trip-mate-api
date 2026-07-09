<!--
State stub — committed source of truth before the bugfix-plan exists.
Path: docs/reviews/expense-mutation-authz/state.md
Written at Rule 0 (gated-bugfix). Once design writes docs/bugfixes/expense-mutation-authz.md,
that plan becomes the source of truth.
-->

---
bugfix: expense-mutation-authz
invariant-class: bugfix
entry-track: bug
review-track: full
pipeline-stage: design
issue-tracker: local
symptom: "여행방의 임의 joined 멤버가, 자신이 작성하지도 결제하지도 않은 남의 지출을 PATCH·DELETE로 수정·삭제할 수 있다(현재 200 성공). admin이거나 작성자이거나 결제자가 아니면 403이어야 한다."
red-baseline: af587a63bbb937882d2223fb460d299be39060ca
bugfix-lock: red
spike-1:
---

## Track note

- **단일 플립**: `PATCH/DELETE /v1/trips/{tripId}/expenses/{expenseId}`에서 비소유·비결제·비어드민
  멤버의 변경/삭제가 **200(허용) → 403(금지)** 으로 바뀐다. 그 외 행동은 전부 보존.
- **invariant-class 판정**: 정확히 한 관측 행동이 플립(인가 불변식) → `bugfix`. net-new/다중 플립 아님.
- **entry-track**: bug — web-expenses intake grilling이 찾은 재현 가능한 인가 갭(G3). 운영 사고 보고가 아니라
  설계 검토발이라 `incident` 아님.
- **review-track**: full — 보안·인가 표면이므로 plan + structure + release 세 게이트 전부.

### diagnose (채택 — 확정 근본원인)

diagnosing-bugs를 새로 돌리지 않고, **커밋된 설계문서의 진단을 채택**한다:
`~/workspace/trip-mate/docs/plans/2026-07-09-backend-expense-identity-authz-design.md §B-2.1 (G3)`.
컨덕터가 현재 HEAD `d1a64a3`에서 모든 파일:라인을 직접 재확인함:

- 근본원인: `expenses.controller.ts:173,194` — PATCH·DELETE 미들웨어가 `[auth, member]`뿐. 서비스
  `expenses.service.ts:315-422`의 `updateExpense`/`deleteExpense`는 `actor.memberId`를
  `last_modified_by`(`expenses.repo.ts:355,472`)·audit(`:428,487`)에만 쓰고 **소유권 검사가 전무**.
  `Membership`(`guards.ts:8-12`)은 `{id, role, status}`를 이미 보유 → 컨트롤러가 role을 서비스에 넘길 수 있음.
- **올바른 seam 존재**(NOT Fork B): 서비스 레이어(`updateExpense`/`deleteExpense`). finalized 잠금
  (`ConflictError`)·version CAS 검사보다 **먼저** 인가를 평가하면 비권한자가 잠금/버전 상태를 탐지 못 함.
- 인가 규칙: `허용 ⇔ actor.role==='admin' ∨ expense.created_by_member_id===actor.memberId
  ∨ expense.paid_by_member_id===actor.memberId`; 그 외 → 403 `ForbiddenError`(`errors.ts:19` 이미 존재).
- 주의: `findById`가 반환하는 `ExpenseRow`/`COLS`에 `created_by_member_id`가 **없다**
  (`expenses.repo.ts:93-111`; 스냅샷 `:28`엔 있음). 인가 조회 방식은 design에서 결정(모두 `src/modules/expenses/**` 안).
- 범위 경계: 이 fix는 응답 DTO를 바꾸지 않는다(작성자/수정자 노출은 G1/B-2.2 별건). `openapi.json` 무변경
  (403은 이미 `errorResponses(403,…)`로 선언됨: controller `:178,201`).

### 다음

red-capture: `tests/regression/expenses-mutation-authz.test.ts`에 비소유자 PATCH/DELETE→403 회귀 테스트를
쓰고 baseline에 RED 커밋, `bugfix-lock.json` 작성, `--verify-red`로 RED 증명.
