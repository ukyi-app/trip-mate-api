# trip-mate API 계약 설계 (OpenAPI · 계약 우선)

- 작성일: 2026-06-29
- 대상: `trip-mate-api`(Hono + @hono/zod-openapi) ↔ `trip-mate-web`(Hey API codegen)
- 기반: architecture §3(계약 사슬)·§4.5(에러)·§3(DTO 경계), tech-stack §3·§8.1(R2 핀), PRD §32(화면)·§45·§34.5, DB/엔진/FX/auth 설계
- 원칙: **계약이 SSOT** — Zod→OpenAPI→FE 타입·훅. 노출 경계는 route별 DTO로 좁힘.

## 1. 계약 사슬 & 버전
- `Drizzle → drizzle-zod → Zod(v4) → @hono/zod-openapi(openapi() 메서드, bare get/post 금지) → OpenAPI → Hey API(FE 타입+TanStack Query 훅)`.
- **API 버전: `/v1` 경로 프리픽스**(D4) — Hono `basePath('/v1')`. PWA 설치형 stale 클라이언트 공존 대비, breaking은 `/v2` 병행. R2 스펙 핀(commit-sha)은 빌드 재현·major 내 additive 흐름(상호보완).
- 인증: Better Auth가 `/api/auth/*` 관리. OpenAPI security = **cookie scheme**(session 쿠키, apiKey in cookie). FE는 `credentials:'include'`.

## 2. 리소스 & 엔드포인트 (PRD §32 → REST, 전부 `/v1` 하위)
```
trips       GET /trips(내 여행방 §32.11) · POST /trips(§32.2) · GET/PATCH/DELETE /trips/{id}(§32.5·§32.10)
members     GET /trips/{id}/members · PATCH /trips/{id}/members/{mid}(비활성·표시이름·어드민 양도 §9)
invites     POST /trips/{id}/invites(§32.3) · POST .../invites/{iid}:resend · POST /invites/{token}:accept(§32.4)
expenses    GET /trips/{id}/expenses(목록+필터+커서 §32.7) · POST(§32.6) · GET/PATCH/DELETE .../expenses/{eid}(§32.8)
            POST .../expenses:preview (저장 전 환율·정산 미리보기, FX §1)
settlement  GET /trips/{id}/settlement(현재 계산 + 포함 지출 seen_versions §32.9) · GET .../settlement/precheck(§29)
            POST .../settlement:finalize(seen_expense_versions 필수, §5) · POST .../settlement:unlock · POST .../transfers/{tid}:mark-paid(§31.7)
```
- **비-CRUD 액션은 `:verb` 액션 엔드포인트**(finalize·unlock·accept·resend·mark-paid) — 상태 PATCH보다 의도·인가·동시성(§7) 명확.

## 3. 에러 모델 (RFC 9457 problem+json, architecture §4.5)
```
{ type, title, status, code, detail, [meta] }
```
| status | code | 사례 |
|---|---|---|
| 422 | ValidationError | zod-openapi 자동(입력 검증 §45) |
| 403 | ForbiddenError | 멤버십·인가(§4.4)·이메일 불일치(auth) |
| 404 | NotFoundError | 리소스 부재 |
| 409 | ConflictError | 낙관적 version·초대 rebind·동시 확정(§7) |
| 422 | SettlementInvariantError | Σ≠0 등(§18.2.2) → 저장 차단 |
- `code`(머신 식별자)로 FE 분기, `detail` 표시(§34.5). 에러 스키마도 OpenAPI에 포함 → FE 타입.

## 4. DTO & 직렬화
- route별 **public 응답 / 입력 / 내부** DTO 분리(architecture §3). 응답에서 audit·provenance·`account` 내부·soft-delete 등 내부 컬럼 omit. **단 `version`은 omit하지 않는다** — CAS mutation을 먹이는 응답(expense·settlement)에 **public 동시성 토큰**으로 노출(§5).
- ⚠️ **돈 = `string`(D1):** bigint 최소단위를 JSON `"37900"`로. **OpenAPI-facing 스키마는 명시적 `z.string().regex(/^-?\d+$/)`(+pattern·examples)** — 생성 FE 타입이 string임을 보장(`z.bigint().transform`는 codegen이 bigint/number로 낼 수 있어 **금지**, 리뷰 #1). **bigint↔string 변환은 emit 스키마 밖(서비스/repo 경계)**. 부호 per-field: 대부분 비음수(`^\d+$`), 환불 amount만 signed(§47). FE는 통화 exponent(§48)로 포맷.
- 돈 표현: `{ amount: string(minor), currency: string }`. AmountDisplay가 현지+정산 둘 다 필요 → `local`·`settlement` 모두 내려줌.

## 5. 동시성 & 멱등성
- **낙관적 잠금(D2 — body `version`):** `version`은 **public 동시성 토큰**(리뷰 #2) — CAS-feeding 응답(expense·settlement)에 노출 + 수정/확정 요청 **스키마에 필수 필드**(클라가 읽은 값 echo). 서버 CAS(version 일치) → 불일치 시 **409 ConflictError**(stale client 안전 read-modify-write). DB §7·§31.6.
- **finalize reviewed-set(리뷰 pass3 — DB §7.1 정합):** 정산 확정은 단일 settlement version으론 부족. `GET /settlement`·`precheck` 응답이 포함 지출의 **`[{expense_id, version}]`(또는 잠긴 집합 reviewed-set digest)** 를 노출하고, `:finalize` 요청이 그 **`seen_expense_versions`를 필수**로 echo. 서버는 **trip lock 하에서 현재 포함 집합과 대조**(architecture §4.6 seenVersions) → drift 시 **409 ConflictError**(사용자가 본 집합이 바뀜).
- **멱등성(D3 — `Idempotency-Key` 헤더):** 지출 생성에 클라이언트 nanoid 키. **scope = (인증 principal + endpoint)**, Valkey에 `scoped_key → {request_hash, result}`(TTL) 저장 (리뷰 #3):
  - 재시도(같은 키·같은 body) → 저장된 동일 응답.
  - **같은 키·다른 body → 409 ConflictError**(키 오용 차단).
  - **동시 같은 키 → single-flight**(`SET NX` lock): 첫 요청만 처리, 나머지는 대기 후 저장 결과(또는 409 in-progress).
  - 여행 중 재시도·오프라인 큐(§26.2·§34.2) 중복 저장 방지.

## 6. 페이지네이션 · 필터
- 지출 목록(§32.7): **커서 페이지네이션** `?cursor=&limit=`. 정렬 `(spent_at desc, id desc)`, 커서=마지막 `(spent_at, id)` — **불변 `id` 타이브레이커로 중복 방지**.
- **안정성 계약(리뷰 pass2):** 커서는 타 row의 insert/soft-delete엔 본질 안정(offset과 달리 위치 아닌 값 기반). **mutation(지출 POST/PATCH/DELETE)은 목록 쿼리 무효화** → FE 처음부터 refetch(TanStack Query `invalidateQueries`). 잔여 위험(미페이지 row의 `spent_at` 편집 skip/dup)은 무효화 + ≤300 bounded(§34.2)로 완화. 엄격 스냅샷 필요 시 `?as_of`(list-version) 추가 — 현재 defer.
- 필터 query: `category`·`payment_method`·`currency`·`member`(결제자|참여자)·`state`(included|personal|record_only). 멤버 필터는 DB `ix_part_member` 활용.

## 7. 테스트 고려
- 계약: OpenAPI 스펙 생성·drift 체크(tech-stack §8.1), Hey API 생성물 일치.
- 직렬화: 돈 **생성 OpenAPI 타입=string 검증**(codegen 산출물), round-trip(입력 regex→bigint, 응답 bigint→string), 큰 값·음수(환불만).
- 동시성: version token 응답 존재+mutation 필수, CAS 409(stale), Idempotency 재시도 동일 응답·**같은키 다른body 409**·동시 same-key single-flight.
- finalize: `seen_expense_versions`가 GET 응답 존재+`:finalize` 필수, **trip lock 하 drift 시 409**(다른 멤버 수정 후 확정 차단, DB §7.1).
- 에러: 각 code의 problem+json 스키마, zod 422 형식.
- 인가: cookie scheme, 비멤버 403, 액션 엔드포인트 권한(§9).

## 8. 결정 로그
| 결정 | 선택 | 근거 |
|---|---|---|
| 돈 직렬화(D1) | `string`(minor), 명시 string 스키마 | bigint 정밀도; 변환은 emit 밖(codegen이 string 보장) |
| 동시성 노출(D2) | body `version` 필드 | 단순·codegen 친화(Zod), 409 충돌 |
| 멱등성(D3) | `Idempotency-Key` 헤더(nanoid) | 여행 재시도·오프라인 중복 저장 방지 |
| API 버전(D4) | `/v1` 경로 | 지금 저비용·PWA stale 공존, R2 핀과 상호보완 |
| 비-CRUD | `:verb` 액션 엔드포인트 | 의도·인가·동시성 명확 |
| finalize 검증 | `seen_expense_versions`(또는 reviewed-set digest) | 단일 version 불충분, DB §7.1 정합(pass3) |
| 에러 | RFC 9457 problem+json + code | 머신 분기 + 표시 분리 |

## 9. 적대적 리뷰 디스포지션 (Codex, branch mode — 3 passes)

codegen이 FE를 구동하는 계약. **5건 finding 전부 Accept·반영**(수렴 3→1→1). 최종 pass3 verdict는 `needs-attention`(finalize reviewed-set)였고 그 수정 반영 후 **사용자 결정으로 확정**.

| pass | # | finding | sev | 결정 | 반영 |
|---|---|---|---|---|---|
| 1 | 1 | 돈 스키마가 string 계약과 drift | high | Accept | 명시 `z.string().regex` 스키마, 변환은 emit 밖(§4) |
| 1 | 2 | version이 내부이자 필수(모순) | high | Accept | version=public 동시성 토큰, omit 제외(§4·§5) |
| 1 | 3 | Idempotency-Key scope/replay 부재 | high | Accept | (principal+endpoint) scope·request_hash·single-flight(§5) |
| 2 | 4 | 커서 페이지네이션 불안정 | high | Accept | 불변 id 타이브레이커·mutation 무효화·?as_of defer(§6) |
| 3 | 5 | finalize CAS가 검토 집합 미증명 | high | Accept | `seen_expense_versions` reviewed-set, trip lock drift 409(§2·§5) |

## 10. 다음 단계 (handoff)
- Codex 적대적 리뷰로 hardening된 API 계약. `@hono/zod-openapi` route 정의 + DTO 스키마(modules/*/*.schema)로 구현, R2 스펙 publish→web Hey API codegen(tech-stack §8.1).
- 구현 시 계약 테스트(§7): 돈 string codegen 타입, version/Idempotency/커서/finalize 동시성.
