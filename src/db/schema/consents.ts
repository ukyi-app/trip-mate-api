import { check, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk } from "./_shared.ts";
import { user } from "./auth-schema.ts";

/** 서버측 동의 기록(PB-1) — 가입·초대수락·사용내역파싱 시점의 약관/처리방침/LLM고지 동의를 영속 기록.
 *  불변 append-only 이벤트라 updated_at 없음(accepted_at만). user.id는 Better Auth text. */
export const userConsents = pgTable(
  "user_consents",
  {
    id: pk(),
    user_id: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    consent_type: text().notNull(), // tos | privacy | llm_disclosure
    document_version: text().notNull(), // 서버 소유 문서 버전
    source: text().notNull(), // signup | invite_accept | usage_parse | settings
    accepted_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
    ip: text(), // 감사용(nullable, best-effort)
  },
  (t) => [
    // 일회성-per-version 멱등의 근거 — 재수락 = ON CONFLICT DO NOTHING. (user_id) prefix라 listByUser도 커버.
    uniqueIndex("uq_user_consent").on(t.user_id, t.consent_type, t.document_version),
    check("consent_type_check", sql`${t.consent_type} IN ('tos','privacy','llm_disclosure')`),
    check(
      "consent_source_check",
      sql`${t.source} IN ('signup','invite_accept','usage_parse','settings')`,
    ),
  ],
);
