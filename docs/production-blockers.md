# 프로덕션 블로커

공개 프로덕션(실사용자) 활성화 전에 **반드시** 해소해야 하는 항목. 우선순위 P-1이 가장 높다(미해소 시 기능/서비스 활성 금지).

> **현재 미해소 P-1 없음** — PB-1 해소(2026-07-08, PR #26).

## P-1

### PB-1. 서버측 동의(약관·개인정보) 캡처 — ✅ 해소

- **상태**: ✅ **해소(2026-07-08, PR #26 squash→main `5e60aba`)**. 이력: ~2026-07-06 P-1 블로커로 유예 → 2026-07-07 설계·구현(TDD) → 2026-07-08 머지.
- **요구(PRD §42.2)**: 이용약관·개인정보 처리방침 제공, **가입(최초 Google 로그인)·초대 수락 시점에 수집·이용 동의를 서버측에 기록**, 수집 항목별 목적·보유기간·파기 시점 고지. 한국 PIPA 주 대상, GDPR 적용 가능성 고려(§42.1).
- **해소 내역**:
  - `user_consents`(user_id·consent_type[tos|privacy|llm_disclosure]·document_version·source[signup|invite_accept|usage_parse|settings]·accepted_at·ip?, `uq_user_consent` 멱등 unique, FK cascade, 마이그레이션 0007) 영속 저장.
  - `POST/GET /v1/consents`(auth): tos+privacy batch 수락 · 버전 ≠ 서버 current면 **409 stale** · 미동의 조회. **버전은 서버 소유**(`CONSENT_VERSIONS`, 실 문서 확정 시 갱신).
  - 사용내역 파싱은 `disclosure_accepted=true` 수신 시 `llm_disclosure` 동의를 **외부 LLM 전송 직전 fail-closed로 기록**(source=usage_parse; 기록 실패 시 전송 중단 = "전송분엔 동의 기록 존재").
  - FE 통합 계약: `docs/contract-consumption.md` §6.
- **이 슬라이스 밖(별도·미구현)**: 강제는 **FE 게이트**(백엔드 403 게이트 없음, 기록만) · 실 약관/처리방침 **문서 내용**(owner/법무) · **파기·열람 요청 처리 경로**(§43 보존·삭제, 별도 슬라이스) · 제3자(피초대자) 통지·거절/삭제(§42.4, 초대 UX).
- **활성화 게이트 연동**: PB-1 해소로 "최소 `llm_disclosure` 동의 기록" 전제 **충족**. 사용내역 파싱 prod 활성화의 남은 게이트는 **FE 고지 UI 배포 → codex 엔진 봉인(`USAGE_PARSER_ENGINE=codex`+`USAGE_PARSER_CODEX_AUTH`) → `replicas:1` 무중첩 롤아웃**([[usage-import-parse-design]] §배포). 전부 owner 작업.

## 참고

- PRD: `docs/trip-mate-prd.md` §42(개인정보·약관·동의)·§43(보존·삭제).
- 사용내역 파싱 설계: `docs/plans/2026-07-06-usage-import-parse-design.md`.
