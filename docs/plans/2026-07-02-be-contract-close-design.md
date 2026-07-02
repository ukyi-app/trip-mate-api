# BE-contract-close 설계 (2026-07-02)

계약 설계에는 있으나 미구현이거나 계약에 노출되지 않은 백엔드 표면 4가지를 완결하여, 프론트엔드 착수 전에 OpenAPI 계약을 안정화한다. 프론트 client 재생성 churn과 타입 안전 공백을 줄이는 것이 목적이다.

- **대상 레포:** `trip-mate-api`
- **DB 마이그레이션:** 없음 (4기능 전부 — cascade·`uq_one_admin`·`invite_expired` enum·멱등 테이블 모두 기존재)
- **방식:** 기존 계약우선 사슬(Zod → `@hono/zod-openapi` → `openapi.json` → FE Hey API)에 편입. 새 규칙 없음, `trips/members/expenses/settlements` 레퍼런스 패턴 재사용, TDD.

---

## 확정된 설계 결정

| # | 결정 | 선택 | 비고 |
|---|---|---|---|
| 1 | Idempotency-Key 노출 대상 | **미들웨어 배선된 5개 라우트 전부** | idempotency-atomicity-adr §2 SSOT와 일치. 문서 §5/D3 "지출생성만" → 5개로 갱신 |
| 2 | `DELETE /trips` 가드 | **무가드 즉시 삭제** | finalized·paid transfer 있어도 어드민이 즉시 삭제. tx+`FOR UPDATE`로 race만 방지. cascade 데이터 소실은 어드민 권한 정책으로 수용 |
| 3 | 어드민 양도 형태 | **`POST /trips/{tripId}/members/{mid}/transfer-admin`** | 전용 트랜잭션 액션을 SSOT로 확정. `api-contract-design.md:16` PATCH 표기 갱신 |
| 4 | 재초대 방식 | **`createInvite` revive-upsert 확장** | 취소/만료 행 재활용. 재취소는 멱등 no-op(200) |
| 5 | 나가기/탈퇴(self-withdraw) | **이번 스코프 배제(forward-ref)** | 어드민 양도 완료 의존 + 지출기록 보존 상태전이 + enum 값 결정 파생. YAGNI |

---

## 공통 규약 (4기능 모두 준수)

- **배선 단일 진실원:** `src/app.ts`의 `buildV1App(deps)` 안에서만 `/v1` 라우트 등록. 새 `OpenAPIHono` 인스턴스 생성 금지 — `main.ts`·`gen:openapi`·doc 테스트가 `buildV1App` 하나만 호출한다. 서비스 의존성은 `V1Deps`에 추가.
- **라우트 패턴:** bare `app.get/post` 금지, 반드시 `app.openapi(createRoute({...}), handler)`. `z`는 `@hono/zod-openapi`의 확장 `z`. 모든 요청/응답 DTO는 `.openapi("Name")`으로 컴포넌트 등록(drift 테스트가 `components.schemas.Name` 존재 단언).
- **에러 모델:** RFC 9457 `application/problem+json` 고정. `core/errors.ts`의 `AppError` 서브클래스(`ForbiddenError`403 · `NotFoundError`404 · `ConflictError`409 · `ValidationError`422) throw만 — `c.json`으로 에러 수동 조립 금지. `registerErrorFilter`/`defaultHook`이 매핑. SQLSTATE(23505 unique · 23503 FK · 23514 check)는 서비스에서 도메인 에러로 변환(`members.service.ts:21-26` `isUniqueViolation` 관례, raw 500 금지).
- **에러 선언:** 각 라우트 `responses`에 발생 가능한 status를 `errorResponses(...statuses)`로 선언. 성공은 200 관례(201 미사용).
- **권한:** DELETE·양도·취소 3기능 모두 `middleware:[auth, requireTripMember(memberLookup,'admin')]` + `security:[{cookieAuth:[]}]`. trip 스코프 경로 파라미터명은 반드시 `{tripId}`(가드가 `c.req.param('tripId')` 읽음). 하위 자원 id는 `{memberId}`/`{inviteId}` 등 별도 이름. 미들웨어가 매 요청 멤버십 재조회 → 양도 후 구admin은 다음 요청 자동 403.
- **동시성:** `trip_members`에 `version` 컬럼 없음(`api-routes.md:26` 명시). 멤버십 mutation은 version 미도입, 대신 trip row `FOR UPDATE` 직렬화 + CAS WHERE predicate(전이조건 전부 WHERE에 포함, read-then-write 금지, TOCTOU 제거)로 안전 보장. version 도입은 하우스 스타일 이탈이므로 금지.
- **drift CI:** 라우트/DTO 변경 후 반드시 `bun run gen:openapi`로 `openapi.json` 재생성·커밋(`.github/workflows/ci.yml`의 `openapi-drift` 잡이 `git diff --exit-code`로 강제). 신규 경로/컴포넌트는 대응 `*-doc.test.ts`에 존재/속성 단언 추가.
- **검증 게이트:** 각 커밋 전 `bun run fmt && bun run check`(oxlint+oxfmt+tsc) 통과. strict-TS 함정 준수(`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` → 조건부 spread, DB 에러는 `e.code ?? e.cause?.code`로 SQLSTATE 추출).
- **gen:openapi 무-IO 불변식:** `createRoute` config는 순수(스키마·미들웨어 참조만), 실제 IO는 handler → service 위임. stub deps로 스펙 생성·doc 테스트가 핸들러 미실행으로 안전해야 함.

---

## 기능별 설계

### ① Idempotency-Key 계약 노출 (순수 계약, 최저위험 — 먼저)

**현재:** 멱등 런타임 완비, `openapi.json`에 `in:header` 파라미터 0건. 미들웨어(`src/core/idempotency.ts`)는 `c.req.header("idempotency-key")` 소문자로 읽고, 없으면 `return next()`(no-op), 길이 > 200이면 `ValidationError`(422).

**대상 5개 라우트** (미들웨어 배선된 것만):
1. `POST /v1/trips/{tripId}/expenses` (`expenses.controller.ts:74`)
2. `POST /v1/trips/{tripId}/settlement/finalize` (`settlements.controller.ts:80`)
3. `POST /v1/trips/{tripId}/settlement/unlock` (`settlements.controller.ts:102`)
4. `POST /v1/trips/{tripId}/settlement/transfers/{transferId}/mark-paid` (`settlements.controller.ts:118`)
5. `POST /v1/trips/{tripId}/settlement/transfers/{transferId}/mark-unpaid` (`settlements.controller.ts:133`)

**설계:**
- `src/core/http.ts`에 공용 헬퍼 정의 (DRY, drift 방지):
  ```ts
  export const idempotencyKeyHeader = z.object({
    'Idempotency-Key': z.string().max(200).optional().openapi({
      param: { name: 'Idempotency-Key', in: 'header', required: false },
      description: '클라 생성 멱등키(nanoid 권장). 5xx/네트워크 실패 시 같은 키로 재시도.',
      example: 'V1StGXR8_Z5jdHi6B-myT',
    }),
  })
  ```
- 5개 `createRoute`의 `request.headers`에 스프레드.
- **필수 함정 방어:**
  - **반드시 `z.object`** — 배열형은 `@hono/zod-openapi`의 `zValidator("header", schema)`가 `safeParseAsync` 부재로 런타임 크래시.
  - **반드시 `.optional()`(`required:false`)** — required면 헤더 없는 모든 요청을 422로 거부해 기존 no-op·전 테스트 파괴.
  - **`.max(200)`만, `.min(1)` 금지** — `.min(1)`은 빈 문자열 헤더를 422로 바꿔 동작 변경(미들웨어는 빈 문자열을 falsy no-op 처리).
- 헤더 대소문자 무해(`@hono/zod-validator`가 case-insensitive remap). CORS `allowHeaders`에 `Idempotency-Key` 이미 포함(`app.ts:43`).
- **drift 단언:** `expenses-doc.test.ts`·`settlement-doc.test.ts`에 `parameters` 중 `name==='Idempotency-Key' && in==='header' && required===false && schema.maxLength===200` 존재 단언 추가.
- **문서 갱신:** `api-contract-design.md §5/D3` "지출생성만" → 5개 라우트로.

---

### ② `DELETE /trips/{tripId}` — 어드민 방 전체 삭제 (무가드)

**현재:** trips 모듈에 DELETE 전무(`trips.controller.ts`는 POST/GET/GET/PATCH 4개). `TripRepo`(`trips.repo.ts:19-24`)에 delete 없음. trips 테이블에 `deleted_at`/`version` 없음. trip_id 참조 전 테이블이 `onDelete:"cascade"`(trip_members `members.ts:14`, expenses `expenses.ts:31`, expense_audit_logs, settlements `settlements.ts:28`, trip_fx_defaults `fx.ts:12`), 자식도 composite FK로 cascade.

**설계:**
- 라우트: `DELETE /trips/{tripId}`, `middleware:[auth, requireTripMember(memberLookup,'admin')]`.
- `TripsService.deleteTrip(tripId)` → `db.transaction`에서 trip row `SELECT ... FOR UPDATE`로 잠근 뒤 `TripRepo.delete(tripId)` 단일 `DELETE FROM trips WHERE id=$1`(자식 전부 FK cascade 자동 정리 — 애플리케이션 레벨 순차 삭제 불필요).
- 응답: `200 { id, deleted: true }`(expenses DELETE 컨벤션 `expenses.controller.ts:199,208` 재사용, 204 전례 없음).
- `errorResponses(403, 404)`. **409 없음**(결정 2: 무가드).
- version/deleted_at 없음 → CAS 불가. hard-delete라 2회차 호출은 자연히 404(멱등키 미적용).

**결정 2 — 데이터 소실 수용(명시):** finalized 정산·paid `settlement_transfer`가 있어도 어드민은 즉시 삭제 가능하며, cascade로 `settlements`·`settlement_currency_totals`·`settlement_transfers`·`settlement_summaries`·`settlement_transfer_events`가 hard-delete되어 결제완료 기록이 영구 소실된다. 이는 어드민 권한 정책으로 의도적으로 수용한다(unlock의 `hasActivePaidSettlementTransfer` 가드와 비대칭인 점을 인지). `FOR UPDATE`는 삭제 중 동시 expense 추가/finalize와의 race만 방지한다.

**엣지케이스:** 비멤버 403 · 비어드민 403 · 없는/삭제된 tripId 404 · CSRF(DELETE는 비안전 메서드, Origin 검사 통과 필요, `app.ts:46`) · cascade 다이아몬드(expenses↔trip_members, settlements↔trip_members, expense_participants↔trip_members 복합 FK가 NO ACTION — RESTRICT 위반은 안 나지만 실제 Postgres 동작을 통합테스트로 반드시 검증).

---

### ③ 초대 취소/폐기 — `POST /trips/{tripId}/invites/{inviteId}/revoke`

**현재:** revoke/cancel 전무. members 모듈은 `createInvite`/`resendInvite`/`acceptInvite`/`updateMember`/`listMembers`/`ensureCreatorMembership` 제공. **`invite_expired`는 죽은 enum값** — 정의·응답 스키마·타입에는 있으나 write하는 코드가 없음(시간만료는 `acceptInviteCas`의 WHERE `invite_token_expires_at > now()`로 지연 차단만, status는 영구 'invited'). pending 초대 = `trip_members(status='invited', user_id=null)` 한 행이며 그 `id`가 곧 `inviteId`(PATCH `/members/{mid}`의 `mid`와 동일 id 공간).

**설계:**
- 라우트: `POST /trips/{tripId}/invites/{inviteId}/revoke`(resend의 `invites/{inviteId}`와 대칭), `middleware:[auth, admin]`.
- 서비스 → repo 단일 원자 CAS UPDATE(`rotateInviteToken` `members.repo.ts:129` 패턴 복제):
  ```sql
  UPDATE trip_members
     SET status='invite_expired', invite_token_hash=NULL, invite_token_expires_at=NULL
   WHERE trip_id=$1 AND id=$2 AND status='invited'
  RETURNING ...
  ```
  0행 → `ConflictError`(409). **행 보존(hard-delete 아님)** — 대리입력 지출(§11.1)이 참조하는 pending 행 FK 안전.
- `invite_expired`의 **최초 writer**. 토큰 null화로 `uq_invite_token` 부분 unique 슬롯 자동 해제. 폐기된 토큰 accept는 `findByTokenHash` null → 기존 `ForbiddenError('invite not found or revoked')` (`members.service.ts:93`)로 자동 처리(별도 코드 불필요).
- **재취소 멱등 no-op:** 이미 `invite_expired`인 행 재취소는 200 반환(0행이지만 최종 상태 동일 → 서비스에서 현재 상태 조회 후 이미 취소면 성공 처리). *(구현 시 CAS 0행을 "이미 취소됨(200)" vs "invited 아님(409)"로 구분하는 조회 1회 추가.)*
- **재초대 revive-upsert(결정 4):** `createInvite`를 확장 — 같은 `(trip_id, normalized_invited_email)` 행이 `invite_expired`(또는 만료)이면 재INSERT 대신 `UPDATE status='invited', invite_token_hash=새 hash, invite_token_expires_at=새 expires, name/invited_email 갱신`. FULL `uq_member_email`(`members.ts:27`, 부분 아님 — 모든 상태가 이메일 슬롯 점유)이 재INSERT를 23505로 막으므로 revive가 유일 안전안. 이미 `invited`/`joined`인 행에 대한 재초대는 기존 동작(409/부적절) 유지.
- `errorResponses(403, 404, 409)`.
- **회귀 스윕:** `invite_expired`를 처음 write하므로 이 값을 소비하는 모든 경로(finalize·정산표시·멤버목록 응답 스키마 `members.schema.ts:8`·`requireTripMember`는 joined만 통과 `guards.ts:39`) 런타임 회귀 점검.

**주의:** PATCH `/members/{mid}`로 취소를 태우지 않는다(옵션 C 배제) — `updateMember` 하드닝(finding #3: `user_id` 바인딩된 joined↔deactivated만 허용)을 완화해야 하고 'invited→joined 위조 차단' 표면과 충돌.

---

### ④ 어드민 양도 — `POST /trips/{tripId}/members/{memberId}/transfer-admin` (최고 복잡도 — 마지막)

**현재:** 미구현. dead code 쌍이 대기(단, 양도엔 불필요): `MembersService.assertNotLastAdmin`(`members.service.ts:131-136`)·`MemberRepo.countActiveAdmins`(`members.repo.ts:206-218`) — 프로덕션 호출처 0건, 테스트만 참조. *(live인 last-admin 가드는 별개: `updateMember`가 `repo.isLastActiveAdmin`으로 "마지막 어드민 비활성화"만 차단 — 양도와 무관.)* `updateMemberSchema`가 role을 의도적 제외(`members.schema.ts:16-21`, 주석 "role(=admin 양도)은 후속 트랜잭션 액션"), `members.schema.test.ts:35-38`이 role strip을 계약으로 고정.

**설계:**
- 라우트: `POST /trips/{tripId}/members/{memberId}/transfer-admin`, `middleware:[auth, admin]`. `from` = `c.get('membership').id`(호출자 자신, 별도 파라미터 불필요), `to` = 경로 `{memberId}`.
- `MembersService.transferAdmin(tripId, fromMemberId, toMemberId)` → `db.transaction` + trip row `FOR UPDATE` 잠금 후 **2문 순서 강제:**
  1. **강등 선행:** `UPDATE trip_members SET role='member' WHERE trip_id=$ AND id=$from AND role='admin' AND status='joined'` — 0행 → `ForbiddenError`/`ConflictError`.
  2. **승격 후행:** `UPDATE trip_members SET role='admin' WHERE trip_id=$ AND id=$to AND status='joined' AND user_id IS NOT NULL AND role='member' AND id<>$from` — 0행 → `ConflictError`(대상 부적격) / `NotFoundError`(대상 부재).
- **순서가 안전성의 핵심:** `uq_one_admin`(`members.ts`, partial unique index ON `(trip_id) WHERE role='admin' AND status='joined'`)은 partial index라 DEFERRABLE 불가 → 문 완료 시점 즉시 체크. 승격을 먼저 하면 순간 "2 admin" 위반. 강등 선행 + `FOR UPDATE` 직렬화로 동시 양도·양도vs자기비활성 경쟁 방지. tx 원자성으로 부분 실패 시 admin 소실/이중 방지.
- 대상 자격(PRD §9.5/§8.1): `status='joined' AND user_id IS NOT NULL`(초대만 된 placeholder·비활성·만료 불가) AND `id<>from`.
- 응답: `memberResponseSchema`(신 admin). version 미도입(멤버십 선례).
- `errorResponses(403, 404, 409)`.
- **멱등:** Idempotency-Key 미적용. 재시도 시 호출자가 이미 구admin(role='member')이라 강등 CAS 0행 → 403/409(자연 멱등에 가까움, 명시 안내).
- **문서 갱신:** `api-contract-design.md:16` PATCH 표기 → 전용 액션으로. dead code(`assertNotLastAdmin`/`countActiveAdmins`)는 양도엔 미사용이므로 배선하지 않고 잔존(향후 '나가기'용).

---

## 구현 순서

의존성·격리도·위험 순:

1. **Idempotency-Key 계약 노출** — 순수 계약 변경(런타임·DB 무변경), 격리도 최고, FE codegen 재시도 키 인지 즉시 unblock. 저위험 워밍업.
2. **`DELETE /trips`** — 자기완결, 타 기능 무의존. 핵심은 cascade 다이아몬드 통합테스트.
3. **초대 취소** — `rotateInviteToken` 패턴 복제 + `invite_expired` 최초 writer 회귀 스윕 + `createInvite` revive-upsert.
4. **어드민 양도** — 최고 복잡도(2행 원자 swap·강등선행·`FOR UPDATE`·CAS WHERE). 향후 '나가기'의 선행조건이므로 마지막에 견고히.

---

## 테스트 전략 (TDD)

- **기능별:** schema/DTO 테스트 → service 단위(권한·불변식·CAS 0행 경로) → controller/route 테스트 → `*-doc.test.ts` drift 단언(경로·컴포넌트·파라미터 존재).
- **통합(testcontainers PG):**
  - DELETE cascade 다이아몬드 — trip 삭제 시 복합 FK(NO ACTION) 테이블이 실제로 함께 정리되고 위반 없는지 검증.
  - 어드민 양도 원자성·동시성 — 강등선행 순서로 `uq_one_admin` 위반 없음, `FOR UPDATE` 직렬화, 부분 실패 롤백.
  - 초대 취소 → revive 재초대 — 취소 후 같은 이메일 재초대가 23505 없이 성공(revive-upsert).
- **회귀:** `invite_expired` 소비 경로 스윕, 전체 `bun run check` green, `openapi.json` drift CI green.

---

## 위험 & 완화

| 위험 | 완화 |
|---|---|
| cascade 다이아몬드(복합 FK NO ACTION) | testcontainers 통합테스트로 실제 Postgres cascade 동작 검증 |
| `uq_one_admin` 순간 위반(partial index, non-deferrable) | 강등 선행 2문 순서 강제 + trip `FOR UPDATE` 직렬화 + tx 원자성 |
| `invite_expired` 최초 writer 회귀 | status 소비 경로(finalize·정산표시·멤버목록) 회귀 스윕 |
| Idempotency 계약 함정(required/min/배열형) | `z.object` + `.optional()` + `.max(200)`만 강제 |
| 재초대 슬롯 잠김(FULL `uq_member_email`) | `createInvite` revive-upsert 필수, pending 참조 행 hard-delete 금지 |
| DELETE 데이터 소실(결정 2) | 의도적 수용. `FOR UPDATE`로 race만 방지, 운영 정책으로 문서화 |
| 문서 SSOT 혼선 | `api-contract-design.md:16`(PATCH→액션)·§5/D3(1→5) 갱신, 코드/api-routes를 SSOT로 |
| 동시성 경쟁(양도·취소 vs accept/resend) | CAS WHERE 원자 UPDATE(0행 stale 실패) + `FOR UPDATE` 직렬화 |

---

## 스코프 밖 (명시)

- **나가기/탈퇴**(멤버 self-withdraw) — 어드민 양도 완료 의존, 지출기록 보존 상태전이, `memberStatusEnum` 'left' 값 추가/재사용 결정 파생. 별도 후속 슬라이스.
- **삭제 감사로그** — 현재 audit 로깅 out-of-scope(api-routes §31).
- **멱등 미들웨어 확장** — 정산/이체는 자연 멱등, 지출만 실위험(ADR §2). trips/members mutation은 CAS/자연 멱등에 의존.

---

## 문서 갱신 필요 (구현과 함께)

1. `docs/plans/2026-06-29-api-contract-design.md:16` — 어드민 양도 PATCH 표기 → `POST .../transfer-admin` 전용 액션.
2. `docs/plans/2026-06-29-api-contract-design.md §5/D3` — Idempotency-Key "지출생성만" → 5개 라우트.
