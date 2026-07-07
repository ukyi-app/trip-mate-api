import { check, index, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps } from "./_shared.ts";
import { trips } from "./trips.ts";

/** 사용내역 파싱 초안(지속형) — 파싱 결과를 저장 → 검토/편집 → confirm 시 기존 지출 생성 재사용.
 *  payload는 파싱된 CreateExpense 부분집합(title·amount·currency·spent_at·category·card_billed·confidence).
 *  결제자·참여자 등 파싱이 모르는 필드는 confirm 때 사용자가 채운다. */
export const expenseDrafts = pgTable(
  "expense_drafts",
  {
    id: pk(),
    trip_id: uuid()
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    created_by_member_id: uuid().notNull(), // composite FK(trip_id,…) 아님 — 앱 스코핑(간결·MVP)
    source: text().notNull().default("text"), // text | image
    status: text().notNull().default("pending"), // pending | confirmed | discarded
    payload: jsonb().notNull(), // 파싱된 초안 필드(UsageDraft)
    confidence: numeric({ precision: 4, scale: 3 }).notNull(), // 정렬·필터용 상위 컬럼(payload에도 있음)
    // confirm 진입(claim) 시점에 확정 body(결제자·참여자 등)를 바인딩 — 부분 실패 후 복구/경합 시
    // **최초 claim한 body만** 결정적으로 재사용(동시 다른 body confirm이 지출을 뒤엎는 것 방지).
    confirm_payload: jsonb(),
    confirmed_expense_id: uuid(), // confirm 시 생성된 지출 id
    source_object_key: text(), // 이미지 원본 object key(④ files, slice4)
    // parse 지속 멱등키(Idempotency-Key) — 미들웨어 크래시-갭(완료기록 실패/프로세스 death)에도
    // 같은 키 재시도가 배치를 재삽입하지 않게 데이터-레벨 replay(같은 (trip,member,import_key) 기존 배치 반환).
    import_key: text(),
    ...timestamps,
    deleted_at: timestamp({ withTimezone: true }), // discard = soft delete
  },
  (t) => [
    index("ix_draft_trip_status").on(t.trip_id, t.status),
    check("draft_source_check", sql`${t.source} IN ('text','image')`),
    check("draft_status_check", sql`${t.status} IN ('pending','confirmed','discarded')`),
  ],
);
