import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps } from "./_shared.ts";
import { trips } from "./trips.ts";
import { user } from "./auth-schema.ts";
import { memberStatusEnum, roleEnum } from "./enums.ts";

export const tripMembers = pgTable(
  "trip_members",
  {
    id: pk(),
    trip_id: uuid()
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    user_id: text().references(() => user.id), // Better Auth user.id (text), null = 초대만 됨(대리입력)
    invited_email: text().notNull(),
    normalized_invited_email: text().notNull(), // §8.5
    invite_token_hash: text(), // 해시만 저장
    invite_token_expires_at: timestamp({ withTimezone: true }),
    display_name: text().notNull(),
    role: roleEnum().notNull().default("member"),
    status: memberStatusEnum().notNull().default("invited"),
    joined_at: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_member_email").on(t.trip_id, t.normalized_invited_email), // 중복 초대 방지
    uniqueIndex("uq_member_user").on(t.trip_id, t.user_id), // 같은 user 1회(null 다중 허용)
    uniqueIndex("uq_one_admin")
      .on(t.trip_id)
      .where(sql`role = 'admin' AND status = 'joined'`), // active 어드민 ≤1
    uniqueIndex("uq_member_trip_id").on(t.trip_id, t.id), // composite FK 타깃
    uniqueIndex("uq_invite_token")
      .on(t.invite_token_hash)
      .where(sql`invite_token_hash IS NOT NULL`), // 한 해시=정확히 1 pending
    index("ix_member_user").on(t.user_id),
  ],
);
