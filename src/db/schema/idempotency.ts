import { integer, pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

// DB-durable 멱등(§5). Redis 대체 — scope_key PK로 single-flight(INSERT ON CONFLICT DO NOTHING),
// status NULL=처리중(lock)·정수=완료(replay). expires_at TTL(만료 행은 미들웨어가 부재 취급).
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    scope_key: text().primaryKey(), // `${userId}:${path}:${clientKey}` (principal+endpoint+key 스코프)
    request_hash: text().notNull(), // 같은 키·다른 body → 409
    status: integer(), // null=처리중, 2xx면 응답 status
    response_body: text(), // null=처리중, 완료면 직렬화 본문
    created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
    expires_at: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index("ix_idempotency_expires").on(t.expires_at)], // 만료 정리 스캔용
);
