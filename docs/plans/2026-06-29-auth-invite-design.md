# trip-mate 인증·초대 플로우 설계

- 작성일: 2026-06-29
- 대상: `trip-mate-api`(Better Auth) + `trip-mate-web`(SPA) 인증·초대·세션
- 기반: PRD §7(인증)·§8(어드민/초대)·§10(멤버 상태)·§11.1(권한)·§34.4(보안), architecture §4.4/§4.7, tech-stack §5.2, DB 설계(trip_members)
- 핵심 긴장: **FE(`app.ukyi.app`) ↔ API(`api.ukyi.app`) 교차 서브도메인 세션** + **초대는 이메일 매칭(토큰≠권한)**

## 1. Better Auth 통합 (D1 확정)
- Better Auth 관리 테이블: **`user` · `session` · `account` · `verification`** (Drizzle 어댑터, `cli generate`로 스키마).
- **D1: Better Auth `user.id`를 앱 전역 안정 식별자로 채택.** 커스텀 `users` 테이블 폐기.
  - `trip_members.user_id → user.id`(생성 uuid, 이메일 변경 무관).
  - **`google_account_id` = `account.accountId`**(`providerId='google'`) — OAuth 링크·중복 로그인 방지·감사용 보존. (PRD §7.3 "안정 식별자=google_account_id" → "안정 식별자=user.id, google sub는 account에 보존"으로 매핑.)
  - `user`(email·name·image·emailVerified)가 PRD users 필드 충족. 추가 도메인 속성은 `user.additionalFields` 또는 별도 profile 테이블.
  - ⚠️ **불변식(리뷰 pass2 — 계정링킹 탈취 차단):** Google `(providerId='google', accountId=sub)`를 **병합 불가 로그인 principal**로 둔다. **이메일 기반 계정 링킹 금지**(`account.accountLinking.enabled=false`/trustedProviders 미설정), **`unique(account.providerId, account.accountId)`** 강제, sign-in은 **Google sub로 resolve**(이메일 아님). `user.id ↔ 단일 Google sub` **1:1 불변** — 같은 이메일이 다른 Google 계정에 속해도 기존 user.id(멤버십)를 상속하지 못한다.
- `socialProviders.google { clientId, clientSecret }`(SealedSecret). `BETTER_AUTH_SECRET`·`BETTER_AUTH_URL` env.

## 2. 세션 & 쿠키 — 교차 서브도메인
- **세션 저장: Valkey `secondaryStorage`**(D2) — 빠름·TTL 네이티브, Postgres 비대화. (Valkey 재시작 시 재로그인 허용)
- **세션 쿠키는 host-only**(`api.ukyi.app`, `__Host-` prefix: `Secure`·`Path=/`·`Domain` 미설정). **`Domain=.ukyi.app`/crossSubDomainCookies 미사용**(리뷰 pass1 #1): host-only 쿠키도 `app→api` 요청에 전송되므로 부모도메인 스코프가 불필요하고, 그것은 오히려 **모든 형제 `*.ukyi.app`에 세션 노출·cookie tossing** 위험.
- `SameSite=Lax` + `HttpOnly` + `Secure`(`useSecureCookies` prod). ⚠️ Lax는 형제 서브도메인을 same-site로 보므로 **형제발 CSRF를 막지 못함** → §6 origin 체크로 보완.
- CORS: API가 FE origin 명시 allowlist + `Allow-Credentials`(와일드카드 금지). Better Auth **`trustedOrigins`=[FE origin]**.
- `session.expiresIn`(기본 7d)·`updateAge`(롤링 갱신). 로그아웃·`revokeSession`.
- OAuth 콜백: Google → API `/api/auth/callback/google`(세션 쿠키 set) → FE redirect.

## 3. 초대 → 참여 상태기계 (D3 확정)
```
어드민  trip_members 생성(user_id=null, normalized_invited_email, invite_token_hash, expires_at, status=invited)
        → Resend 초대 이메일(§41) + 링크 https://app.ukyi.app/invite/{raw_token}
피초대   링크 클릭 → FE invite-accept → "Google 로그인"
        → Better Auth Google OAuth → 세션 확립(user.id)
        → POST /invites/{token}/accept  (인증 필요, 단일 tx):
            ① token hash로 invite 조회(+trip) — **정확히 1 pending 행**이어야 함(아니면 실패, pass4). 만료/status 확인 · email_verified·정규화 이메일 == invite.normalized_invited_email
               (불일치/미검증 → ForbiddenError, 이 trip만 거부·세션 유지·명확 안내 §34.1)
            ② **원자 CAS 바인딩(검증 predicate 전부 WHERE 포함 — TOCTOU 제거, pass3 #2·pass4·pass5):**
               `UPDATE trip_members SET user_id=$me, status='joined', joined_at=now()
                WHERE id=$verified_invite_id AND status='invited' AND user_id IS NULL
                  AND invite_token_hash=$verified_h AND normalized_invited_email=$verified_email
                  AND invite_token_expires_at > now() RETURNING`
               · 1행 → 참여 성공
               · 0행 → 재발송/취소/이메일변경이 끼었거나 이미 바인딩: `user_id==$me`면 멱등 성공, 아니면 `ConflictError`(재검증·rebind 차단)
```
- **토큰 = invite/trip 포인터, 권한 아님.** 권한 = **email_verified 매칭**(§8.3). 유출돼도 다른 계정은 매칭 실패.
- **D3: 토큰은 join 전까지 멱등 재사용**(같은 이메일 재클릭 OK), join 후 멤버십이 governs.
- 토큰: `crypto.randomBytes(32)` → base64url(링크), DB는 `sha256` 해시 저장(`invite_token_hash`), `invite_token_expires_at`.

## 4. 인가 모델 (membership, defense-in-depth)
- Better Auth 세션 = **인증**. trip 접근 = **`trip_members` 멤버십**(architecture §4.4: 미들웨어 coarse + 서비스 가드 fine).
- 게이팅: `status=joined`만 접근, `deactivated`/`invite_expired`는 차단(단 정산 표시는 유지 — DB 설계 비활성 멤버 정책).

## 5. 엣지 케이스 / 결정
- **email_verified=false → 거부**: Google profile의 `email_verified`를 sign-in/sign-up before-hook(`databaseHooks`/`socialProviders.google` 매핑)에서 검사, false면 차단(§34.4).
- **이메일 불일치:** 세션은 있되 그 trip만 거부(다른 이메일로 초대됐을 수 있음).
- **토큰 만료 → `invite_expired`**, "어드민 재발송 요청" 안내.
- **재초대(이메일 수정·재발송):** 이전 토큰 폐기 + 새 hash(§9.2). status=invited 유지.
- **어드민 생성:** 생성자 첫 로그인 → 자기 `trip_members`(role=admin, status=joined, user_id 바인딩) 자동, 토큰 불필요.
- **거절(§10.5) → `invite_expired`**.
- **Google 이메일 변경 후:** `user.id` 고정 → 기존 멤버십 무관. 단 *새* 초대 매칭은 현재 정규화 이메일.
- **계정 링킹/이메일 재활용:** 이메일 기반 링킹 금지(§1 불변식). 동일 이메일·다른 Google sub는 **별개 user**(기존 멤버십 상속 불가). 재활용 이메일이 *미참여* 초대를 수락하는 것은 이메일 초대의 본질(만료로 완화).
- **동시 join:** `unique(trip_id, user_id)` + 멱등 → 중복 바인딩 차단.

## 6. CSRF / 보안
- ⚠️ Better Auth 내장 CSRF/origin check는 **`/api/auth` 라우트만** 커버. **우리 커스텀 Hono 라우트(지출·정산·초대수락·멤버 변경)는 별도 쿠키인증 → 자체 CSRF 방어 필수**(리뷰 pass1 #2).
- **앱 전역 CSRF/origin 미들웨어:** 모든 unsafe 메서드(POST/PUT/PATCH/DELETE)에서 **`Origin`이 FE allowlist와 정확히 일치할 때만 허용**(리뷰 pass3 #1). `Sec-Fetch-Site`는 **추가 deny 신호로만**(`same-site`라도 형제가 통과하므로 allow 대체 불가), **`Origin` 누락 시 거부**(실제 CSRF 토큰 경로 제외) + 필요 시 비단순 CSRF 헤더(double-submit). CORS는 form-POST CSRF를 못 막고 `SameSite=Lax`는 형제를 same-site로 보므로, **host-only 쿠키(§2) + 정확 origin 강제**가 형제발 CSRF까지 차단.
- `disableCSRFCheck`/`disableOriginCheck` **금지**. 레이트리밋: Better Auth `rateLimit`(secondary-storage=Valkey). 시크릿(Google·BETTER_AUTH_SECRET)은 SealedSecret(tech-stack §8). `trustedOrigins`=[FE origin].

## 7. DB 영향 (DB 설계 doc 반영 완료)
- **커스텀 `users` 테이블 → Better Auth `user`/`account`/`session`/`verification`로 대체**(D1). `cli generate` 스키마를 db/schema에 포함.
- `trip_members.user_id`의 FK 타깃 = Better Auth `user.id`. same-trip composite FK(§2.2)는 그대로(user.id 참조).
- `google_account_id`는 `account`(providerId='google', accountId)에서 조회. users 테이블의 google_account_id 컬럼 제거.
- 세션은 Valkey(secondaryStorage)라 `session` 테이블은 미사용 가능(또는 storeSessionInDatabase 비활성).
- **`trip_members`: `unique(invite_token_hash) where invite_token_hash is not null`**(pass4 — 한 해시 = 정확히 1 pending invite). 초대 수락 CAS는 검증된 invite row PK로 update.
- **`account`: `unique(provider_id, account_id)`**(pass2 — Google sub 1:1, 이메일 링킹 금지).

## 8. 테스트 고려
- 통합: Google OAuth mock → 세션 확립, **host-only 쿠키**(app→api 전송 확인), CORS+credentials, **적대적 형제 서브도메인·외부 origin·Origin 누락 unsafe 요청 거부**(CSRF origin 미들웨어, 정확 Origin만 allow).
- 초대 플로우: 정규화 매칭(§8.5 점/+ 제거) 일치/불일치, email_verified=false 거부, 만료, 멱등 재클릭, 재초대 토큰 폐기, 어드민 자동 멤버십.
- 식별/링킹: 동일 정규화 이메일·**다른 Google sub → 별개 user(멤버십 상속 X)**, 이메일 기반 링킹 시도 거부, `unique(providerId,accountId)` 위반.
- 동시 초대 수락: 동일 이메일·다른 sub가 같은 토큰 경쟁 → **CAS로 1명만 바인딩**(나머지 ConflictError). accept vs **재발송/취소/이메일수정** 경쟁 → stale accept 0행 실패(TOCTOU 없음).
- 인가: status별 게이팅, 비멤버 차단, 마지막 어드민 가드(§9.5).
- 토큰: hash 저장·**unique(정확 1 pending 조회)** 검증, 만료 경계, 재발송 무효화.

## 9. 결정 로그
| 결정 | 선택 | 근거 |
|---|---|---|
| 사용자 식별(D1) | Better Auth `user.id` (Google sub 1:1·이메일 링킹 금지) | 안정 식별자 + 병합불가 principal(계정링킹 탈취 차단, pass2) |
| 세션 저장(D2) | Valkey secondaryStorage | 빠름·TTL·Postgres 비대화 |
| 초대 토큰(D3) | join까지 멱등 재사용 | 이메일 게이팅이라 실사용 친화 |
| 쿠키 | **host-only `__Host-`(api.ukyi.app)**·SameSite=Lax·Secure·HttpOnly | 부모도메인 스코프 회피(형제 노출 차단) + 커스텀 라우트 origin 체크로 보완(pass1 #1/#2) |
| 권한 경계 | 토큰=포인터, email_verified 매칭=권한 | §8.3 유출 내성 |
| email_verified | true만 매칭 허용 | §34.4 |

## 10. 적대적 리뷰 디스포지션 (Codex, branch mode — 5 passes)

보안 크리티컬 인증·초대 설계. **7건 finding 전부 Accept·반영.** 쿠키/CSRF·계정 식별은 초반에 수렴, 이후 **초대수락 전이**를 점진 원자화. 최종 pass5 verdict는 `needs-attention`(TOCTOU)였고 그 수정을 반영한 뒤 **사용자 결정으로 확정**.

| pass | # | finding | sev | 결정 | 반영 |
|---|---|---|---|---|---|
| 1 | 1 | 부모도메인 쿠키가 형제 서브도메인 노출 | high | Accept | host-only `__Host-` 쿠키, Domain=.ukyi.app 제거(§2) |
| 1 | 2 | CSRF가 Better Auth만 커버, 커스텀 API 노출 | high | Accept | 앱 전역 origin 미들웨어(§6) |
| 2 | 3 | 멤버십이 병합 가능 user에 묶임(계정링킹 탈취) | high | Accept | Google sub 병합불가 principal, 이메일 링킹 금지, unique(provider,account)(§1) |
| 3 | 4 | Sec-Fetch-Site가 정확 Origin 대체 불가 | high | Accept | 정확 Origin allowlist만 allow(§6) |
| 3 | 5 | 동시 초대수락이 같은 row rebind | high | Accept | 원자 CAS(§3) |
| 4 | 6 | 한 토큰 해시로 다중 멤버십 UPDATE | high | Accept | unique(invite_token_hash) + 검증 row PK CAS(§3·§7) |
| 5 | 7 | accept vs 재발송/이메일수정 TOCTOU | high | Accept | 검증 predicate 전부 원자 CAS WHERE에 포함(§3) |

## 11. 다음 단계 (handoff)
- Codex 적대적 리뷰로 hardening된 인증·초대 설계. `modules/auth`(Better Auth 배선) + `modules/members`(초대/참여), `core/guards`(인가·origin 미들웨어)로 구현(architecture §4).
- **DB 영향(§7) 반영 완료:** 커스텀 `users` → Better Auth `user`/`account`/`session`/`verification`, `trip_members.uq_invite_token`(부분 unique), `account` unique(provider,accountId) — DB 설계 doc·architecture §4.3·PRD §11.2에 반영됨.
- 구현 시 보안 통합 테스트(§8): host-only 쿠키·정확 Origin CSRF·계정링킹·초대수락 동시성(재발송 경쟁).
