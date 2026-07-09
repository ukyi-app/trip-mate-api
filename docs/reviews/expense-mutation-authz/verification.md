# Verification — expense-mutation-authz (G3 지출 수정/삭제 소유권 인가)

증거 원천: `bugfix-status.mjs --verify-flip`의 **스크립트 자체 재실행**(주장 아님).
- red.sha `81b6666` (fix 직전 baseline) · green.sha `db43bda` (fix + 원본 repro). red..green 비테스트 =
  fix 3소스(`src/modules/expenses/**`) + 게이트/verify 아티팩트(`docs/**`) — 둘 다 scope.

## Claim (gated-bugfix): 회귀 테스트 RED@red.sha → GREEN@fix, 주변 스위트 불변

명령: `node <SKILL>/scripts/bugfix-status.mjs --verify-flip --bug expense-mutation-authz`

결과: **flipOk: true**

```
red  @81b6666:  regression { exit:1, failed:true, symptomTokenPresent:true(G3-AUTHZ) }
                characterization { exit:0, green:true }
green@db43bda:  regression { exit:0, passed:true }
                characterization { exit:0, green:true }
                repro { exit:0, reproduces:false }   ← 원본 증상 더는 재현 안 됨
```

- 커밋된 verify-record:
  - `docs/reviews/expense-mutation-authz/bugfix-verify-red-a255d402…json` (treeSha=81b6666 tree)
  - `docs/reviews/expense-mutation-authz/bugfix-verify-green-d5fcc528…json` (treeSha=db43bda tree)
- ancestry: red.sha는 green.sha의 조상, 둘 다 HEAD에서 도달 가능(barrier 2).
- surface(barrier 4): `git diff 81b6666..db43bda` 비테스트 경로 = `expenses.controller.ts`·`expenses.repo.ts`·
  `expenses.service.ts`(fix, scope `src/modules/expenses/**`) + `docs/**`(게이트/verify 아티팩트, scope `docs/**`).
- **원본 증상 repro-gone (release R-1):** `reproCmd = bunx vitest run tests/regression/expenses-mutation-authz.repro.test.ts`
  — 비인가 멤버의 타인 지출 수정 시도(사용자 대면 원본 시나리오). `--verify-flip`이 green@db43bda에서 재실행해
  **`repro.reproduces:false`(exit 0, 403 응답)** 를 기록 → 스크립트 관측 출력으로 증상 소멸 증명.
  before(증상): red 레코드의 `regression FAILED@red`(비인가 수정이 200으로 성공) → after: 403.

## I-1 수용 기준 매핑 (모두 충족)

| 기준 | 증거 |
|---|---|
| 비인가 actor PATCH/DELETE → 403 (open·finalized·stale 무관) | 회귀 6케이스 GREEN@green (RED@red) |
| authz가 잠금/버전보다 먼저 (정보누출 차단) | `authorizeMutation` = update/delete 첫 줄; finalized/stale에서도 비인가 403(회귀 4케이스) |
| 세 disjunct(admin·작성자·결제자) 각각 단독 인가 | 양성 테스트 6건: 작성자단독·결제자·admin 각 PATCH/DELETE → 200 (변이내성) |
| 인가된 actor finalized→409 / stale→409 보존 | 양성 경계 테스트(controller.test.ts) GREEN |
| 부재 지출 → 404 보존 | `authorizeMutation` null→NotFoundError |
| DTO/openapi 불변 | `toResponse`/`expenseResponseSchema`/`COLS`/`openapi.json` diff 없음 |
| createExpense 계약 불변 | `ExpenseActor` 유지; expense-drafts characterization GREEN |
| 스코프 `src/modules/expenses/**` | diff --name-only 확인(위) |
| `bun run check` (oxlint·oxfmt·tsc) | green (fix 커밋 pre-commit + 구현자 실행) |
| 회귀 테스트 미약화(anti-cheat) | 회귀 파일 red..green diff에 없음(미변경); structure 게이트 approve |

## Gates

- plan r1 needs-attention(P-1) → 반영 → r2 **approve** (`plan-r2.json`)
- structure r1 **approve**, 0 findings (`structure-r1.json`)
- 컨덕터측 `/code-review`(Spec·Standards 병렬): 보안 코어 clean, 소수정 fix-round 해소
