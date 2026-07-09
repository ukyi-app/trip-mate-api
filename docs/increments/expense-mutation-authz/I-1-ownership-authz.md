---
id: I-1
title: 지출 수정/삭제에 소유권 인가 술어 추가 (finalized-lock·version-CAS보다 먼저)
status: done
blocked-by: [none]
plan: docs/bugfixes/expense-mutation-authz.md
created: 2026-07-09
closed: 2026-07-09
---

## What the fix does here

`ExpensesService.updateExpense`/`deleteExpense`의 **첫 단계**로 소유권 인가를 평가한다:

```
allow ⇔ actor.role === "admin"
      ∨ expense.created_by_member_id === actor.memberId
      ∨ expense.paid_by_member_id     === actor.memberId
그 외 → ForbiddenError (403)
```

- **잠금/버전보다 먼저.** `assertTripOpen`(finalized 409)·`repo.updateMeta`/`softDelete`의 version CAS보다
  앞서 평가 — 비권한자가 잠금/버전 상태를 관측하지 못하게(설계 §B-2.1 정보누출 차단).
- **role 배선.** 컨트롤러가 `c.get("membership").role`을 변경/삭제 호출에 넘긴다. `createExpense`의 actor
  계약은 불변(생성은 인가 불필요, `expense-drafts.service.ts:168` 소비처 무영향). 권장: 변경/삭제 전용
  actor가 `role`을 필수로 갖게(타입이 누락을 막음).
- **소유권 조회 — DTO 불변.** 대상 지출의 `created_by_member_id`·`paid_by_member_id`만 읽는다. 응답
  DTO(`toResponse`/`expenseResponseSchema`)·`ExpenseRow`의 API 표면·`openapi.json`을 넓히지 말 것
  (작성자/수정자 노출은 별건 G1/B-2.2). 권장: 인가 전용 repo 읽기(`findMutationAuthz` 류). `created_by`/
  `paid_by`는 생성 후 불변(`MetaPatch`에 없음)이라 트랜잭션 밖 사전 조회가 안전(TOCTOU 없음).
- **부재 지출 → 404 보존**(인가 조회 null → NotFoundError).
- scope: `src/modules/expenses/**`.

## Acceptance

- [ ] 회귀 6케이스(`regressionCmd`) — PATCH·DELETE × {open, finalized, stale} 비인가 actor → 403 — 이
      diff의 **프로덕션 변경**으로 GREEN(테스트 수정 아님)
- [ ] characterization(`characterizationCmd`: `src/modules/expenses` + `src/modules/expense-drafts`) GREEN 유지
- [ ] 양성 수용 테스트 추가(과차단 방지·경계 증명): 작성자→200, 결제자(비작성자)→200,
      admin(비작성·비결제)→200, **인가된 actor의 finalized→409·인가된 actor의 stale→409**
- [ ] 변경 non-test 경로 전부 `scope[]`(`src/modules/expenses/**`) 안 — DTO·openapi 무변경
- [ ] `bun run check`(oxlint·oxfmt·tsc) green
- [ ] anti-cheat: 어떤 테스트도 약화/skip/xfail 없음, 증상 특수케이스 처리 아님

## Result

- commit `53b5148`. `authorizeMutation`(update/delete 첫 줄, 잠금/버전보다 먼저) + `ExpenseMutationActor`(role 필수)
  + `repo.findMutationAuthz`(created_by/paid_by만, DTO 미확장). 회귀 6/6 GREEN, characterization 113/113 GREEN,
  `bun run check` exit 0.
- 컨덕터 `/code-review`(Spec·Standards 병렬): Spec `created_by` 단독검증 갭 + Standards 소수정 2건 → fix 라운드로 해소
  (세 disjunct 각각 단독 테스트로 변이내성 확보, 컨트롤러 dedup, repo snake_case 정합). 이연 없음.
