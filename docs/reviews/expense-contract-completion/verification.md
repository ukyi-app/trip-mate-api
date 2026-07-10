# Verification — expense-contract-completion (B-1 통화 + B-2.2 Expense DTO + B-2.3 신원)

web-expenses 백엔드 계약 완결(G3 인가는 PR #28로 선행 완료). 5 슬라이스 전부 구현·검증.

## 슬라이스 & 갭 해소

| 슬라이스 | 갭 | 결과 |
|---|---|---|
| I-1 B-1.2 | G5 | `CURRENCY_SEED` 28 + 멱등 마이그레이션 0008(부팅 자동) + `oxr.SUPPORTED` 28 + `coverage.test.ts` |
| I-2 B-1.1 | G4 | `GET /v1/currencies`(auth, minor_unit만, iso_exponent 미노출, private cache) |
| I-3 B-2.2 | G1 | Expense DTO +4필드(created_by·last_modified_by·created_at·updated_at) |
| I-4 B-2.3a | G2+F-B1 | Trip `my_member_id` + 목록 순정산(my_member_id/my_role/my_net_amount/net_currency), skeleton |
| I-5 B-2.3b | F-B1 | `GET /v1/me/invites`(user-scoped 대기 초대, discovery-only) |

## Claims (검증됨)

명령은 워크트리 `feat/expense-contract-completion`(HEAD `7d374b0`)에서 fresh 실행.

1. **전체 스위트 green** — `bun run test`:
   ```
   Test Files  68 passed | 4 skipped (72)
        Tests  615 passed | 10 skipped (625)
   ```
   baseline(main) 590 passed → **+25 신규**(coverage·currencies·expense DTO·trip net·me/invites), 회귀 0.
2. **openapi-drift clean** — `bun run gen:openapi` (28 paths) → `git diff --stat openapi.json` **비어있음**(커밋본 = 재생성본).
   신규: `/v1/currencies`(+Currency) · `/v1/me/invites`(+MyInvite) · Trip +my_member_id · +TripListItem · Expense +4필드.
   `grep -c user_id openapi.json` = **0**(신원 노출은 my_member_id뿐).
3. **provider coverage green** — `src/modules/fx/provider/coverage.test.ts`: `SUPPORTED ⊇ CURRENCY_SEED`(28), USD 포함, 무중복.
4. **`bun run check`** — oxlint · oxfmt · tsc 전부 exit 0.

## Testing Decisions seam 커버 (design §Testing Decisions)

- I-1: coverage(SUPPORTED⊇seed 정적), provider.test 28 정합, schema-introspection 28.
- I-2: currencies.controller.test — authed 200·미인증 403·iso_exponent 부재·Cache-Control·특정 코드 minor_unit; openapi-doc iso_exponent 부재 락.
- I-3: expenses.controller.test — 4필드 왕복(생성 last_modified null → 수정 후 non-null); expenses-doc 4필드.
- I-4: trips.controller.test + settlements — my_member_id·목록 net·**무활동→"0"**·**부호 net**·**corrupt→null(라우트 seam)**·user_id 부재; 같은-trip-두-멤버 복합키(netKey).
- I-5: members.routes.test — 이메일 정규화 매칭·status/만료 필터·미인증 403·토큰/user_id/member_id 미노출·빈 이메일 → [].

## Gates

- **design(plan) gate**: r1 needs-attention 4(P-1 마이그레이션·P-2 zero-activity·P-3 HUF=0·P-4 seams) → 반영 → **r2 approve**.
- **structure gate(I-4 skeleton)**: r1 needs-attention 2(S-1 net port 복합키·S-2 route-level null) → 반영 → **r2 approve**.
- 컨덕터 `/code-review`: I-2 Spec clean + Standards 2 소수정(private cache·iso_exponent 락).
- **release gate**: (다음 단계.)

## Out of scope (발주 밖)

§30.3 감사로그 read 엔드포인트 · FX 자동 seed/promotion · user_id 노출.
