import { createHash } from "node:crypto";
import type { Context, Next } from "hono";
import { and, eq, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { idempotencyKeys } from "../db/schema/idempotency.ts";
import { ConflictError } from "./errors.ts";

// DB-durable 멱등(§5). Redis 대체 — Postgres 영속으로 재시작/eviction에도 replay 보장.
export interface IdempotencyStore {
  db: PostgresJsDatabase<Record<string, unknown>>;
  ttlSeconds?: number;
}
const hashBody = (raw: string) => createHash("sha256").update(raw).digest("hex");

/** §5 멱등. scope=(principal + 실 요청 경로 + client key). requireAuth 뒤 적용. 헤더 없으면 no-op.
 *  INSERT ON CONFLICT DO NOTHING으로 single-flight, status NULL=처리중·정수=완료(replay).
 *  throw/non-2xx면 lock 행 삭제(재시도 허용). 만료 행은 부재 취급. */
export function idempotency(store: IdempotencyStore) {
  const ttl = store.ttlSeconds ?? 86_400;
  const db = store.db;
  return async (c: Context, next: Next) => {
    const clientKey = c.req.header("idempotency-key");
    if (!clientKey) return next();
    const user = c.get("user");
    const raw = await c.req.raw.clone().text(); // clone → 핸들러의 valid("json") 보존
    const reqHash = hashBody(raw);
    // c.req.path = 실 tripId 포함(/v1/trips/<uuid>/expenses) → 교차-trip 격리(finding #4 pass1)
    const key = `${user.id}:${c.req.path}:${clientKey}`;

    // 만료 행 제거 → 부재 취급(재처리 허용)
    await db
      .delete(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope_key, key), lt(idempotencyKeys.expires_at, sql`now()`)));

    const existing = await db
      .select({
        request_hash: idempotencyKeys.request_hash,
        status: idempotencyKeys.status,
        response_body: idempotencyKeys.response_body,
      })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.scope_key, key));
    const rec = existing[0];
    if (rec) {
      if (rec.status === null) throw new ConflictError("idempotent request in progress", { key });
      if (rec.request_hash !== reqHash)
        throw new ConflictError("idempotency key reused with different body", { key });
      return c.json(JSON.parse(rec.response_body ?? "null"), rec.status as 200); // replay
    }

    // lock 선점: INSERT ON CONFLICT DO NOTHING(동시 같은 키 single-flight)
    const inserted = await db
      .insert(idempotencyKeys)
      .values({
        scope_key: key,
        request_hash: reqHash,
        expires_at: sql`now() + (${ttl} * interval '1 second')`,
      })
      .onConflictDoNothing()
      .returning({ k: idempotencyKeys.scope_key });
    if (inserted.length === 0) throw new ConflictError("idempotent request in progress", { key }); // 동시 선점됨

    // 에러 경로에서도 lock 반드시 해제 — 미해제 시 TTL 동안 재시도 차단.
    try {
      await next();
    } catch (e) {
      await db.delete(idempotencyKeys).where(eq(idempotencyKeys.scope_key, key)); // throw → lock 해제, 원에러 보존
      throw e;
    }
    if (c.res.status >= 200 && c.res.status < 300) {
      const body = await c.res.clone().text();
      await db
        .update(idempotencyKeys)
        .set({ status: c.res.status, response_body: body })
        .where(eq(idempotencyKeys.scope_key, key));
    } else {
      await db.delete(idempotencyKeys).where(eq(idempotencyKeys.scope_key, key)); // non-2xx → 재시도 허용
    }
  };
}
