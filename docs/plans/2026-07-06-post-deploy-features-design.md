# Post-deploy 기능 설계 — 초대 이메일 · rate limit · 영수증 · 사용내역 파싱

배포 완료(공개 라이브) 이후 감사로 확인된 잔여 gap 4건. functional core/imperative shell·port+adapter·strict TS 기존 규약 유지.

## ① 초대 이메일 발송 (Resend)

**gap**: `MembersService.createInvite/resendInvite`가 `{token, link}`만 반환("실 발송은 caller") → 초대받은 사람이 알림을 못 받음.

- **포트**: `Mailer` (`src/modules/notifications/mailer.port.ts`): `sendInvite({to, inviteUrl, tripName?, inviterName?}): Promise<void>`.
- **어댑터**: `mailer.resend.ts` — ofetch로 Resend HTTP API(`POST https://api.resend.com/emails`, Bearer). 미설정(RESEND_API_KEY 없음) 시 no-op 어댑터(로컬·graceful).
- **배선**: controller(imperative shell)가 `service.createInvite()` → `{link}` → `mailer.sendInvite()` **best-effort**(try/catch, 실패 로깅, 초대는 성공 반환). service는 순수 유지.
- **링크**: `${WEB_ORIGINS[0]}/invite/${token}` = `https://trip-mate.ukyi.app/invite/{token}`.
- **config**: `RESEND_API_KEY`(sealed, optional), `MAIL_FROM`(검증된 도메인 발신).
- **테스트**: fake Mailer 주입 → controller가 초대 후 sendInvite 호출·인자 검증. Resend는 opt-in smoke.

## ② Rate limiting (인증 + 민감 라우트)

**gap**: 공개 인증 API인데 throttle 없음.

- **/api/auth/***: Better Auth `rateLimit: { enabled, window, max, storage: "secondary-storage" }`(Redis) — 로그인/OAuth 브루트포스 방어. prod 활성.
- **/v1 민감 라우트**: `src/core/rate-limit.ts` Redis 고정윈도우 미들웨어. key=`rl:{scope}:{ip}`, INCR+EXPIRE, 초과 시 **429 problem+json + Retry-After**. IP = `CF-Connecting-IP`(Cloudflare Tunnel) ?? `X-Forwarded-For` first ?? conn. 적용: 초대 create/resend/accept, expense create, trip create 등 쓰기/증폭.
- **config**: 한도 상수(쓰기 ~60/min/IP, 초대 ~20/min).
- **테스트**: 미들웨어 유닛(Redis testcontainer, N+1→429·Retry-After).

## ④ 영수증 업로드 (files 서버 프록시)

files 서버: 내부(`files.home.ukyi.app`) · API-key(Bearer) · PUT raw 바이너리 `/api/files/{bucket}/object` → `ObjectMeta` · utoipa openapi `/openapi.json`.

- **클라이언트 생성**: `@hey-api/openapi-ts`(dev dep)로 files openapi.json → `src/modules/files/generated/`(커밋). `bun run gen:files-client`(URL은 Tailnet 필요 → owner/CI 실행).
- **래퍼**: `files.client.ts` — baseURL(`FILES_BASE_URL`) + `Authorization: Bearer FILES_API_KEY`. putObject/getObject/deleteObject.
- **흐름(프록시)**: FE → trip-mate-api(공개) → files(내부, 인-클러스터). files는 정적 key+내부라 FE 직접 불가 → 프록시가 유일 안전 경로. bucket=`trip-mate`, key=`receipts/{tripId}/{expenseId}/{uuid}`.
- **엔드포인트**(trip 멤버 인가 재사용): `POST /v1/trips/{tripId}/expenses/{expenseId}/receipt`(raw+Content-Type)→putObject→expense ref 저장→201 · `GET .../receipt`(프록시 스트림) · `DELETE .../receipt`.
- **데이터**: `expenses.receipt_object_key text`(1/expense, MVP). 마이그레이션 추가.
- **config**: `FILES_BASE_URL`·`FILES_API_KEY`(sealed)·`FILES_BUCKET=trip-mate`. 크기 제한.
- **테스트**: fake FilesClient 주입 → 프록시 유닛. files 계약 smoke(opt-in).

## ⑤ 사용내역 파싱 → 지출 초안

**목표**: 카드 문자내역 업로드 → 파싱 → 지출 **초안** → 확인 후 확정.

- **입력**: 텍스트(붙여넣기) [MVP] / 파일(이미지·CSV) [후속, ④ files 재사용].
- **파서 결정(착수 전 확정 필요)**: (A) 정규식-per-발급사(결정적·무료·brittle) / (B) **LLM 추출(Claude Haiku)** — 한국 카드 SMS 형식 다양성에 강건·구현 빠름·API키+비용+지연 / (C) 하이브리드. **추천: B**.
- **출력**: `[{amount, currency, merchant→description, date, confidence}]`.
- **모델**: **무상태 MVP** — 파싱 결과를 응답으로 반환, FE가 확인/편집 후 **기존 지출 생성 API 재사용**으로 확정(DB 스키마 최소). (스테이징 `expense_drafts` 테이블은 후속.)
- **흐름**: `POST /v1/trips/{tripId}/usage-imports/parse` {text} → 파서 → 초안 배열 반환 → FE 확인 → expense create.
- **config**: `ANTHROPIC_API_KEY`(sealed, LLM 시).
- **테스트**: 파서 유닛(샘플 SMS→기대 필드). LLM은 계약 smoke + 프롬프트 스냅샷.

## 구현 순서

1. **② rate-limit** — 독립·빠름, 공개 API 보호 우선
2. **① 초대 이메일** — 독립·빠름, MVP gap
3. **④ 영수증** — files 클라이언트 인프라(⑤도 재사용)
4. **⑤ 사용내역 파싱** — 최대·불확실, ④ 위에. 착수 전 파서 확정.

각 슬라이스: TDD → verify(Docker/testcontainers) → PR. 각 config는 `.env.example`(로컬)·`deploy/.env`(prod sealed)·homelab conn/secret에 반영.
