import { createHash } from "node:crypto";
import type { Context, Next } from "hono";
import type { Redis } from "ioredis";
import { ConflictError } from "./errors.ts";

export interface IdempotencyStore {
  redis: Redis;
  ttlSeconds?: number;
}
interface IdemRecord {
  lock?: true;
  request_hash: string;
  status?: number;
  body?: string;
}
const hashBody = (raw: string) => createHash("sha256").update(raw).digest("hex");

/** §5 멱등. scope=(principal + 실 요청 경로 + client key). requireAuth 뒤 적용. 헤더 없으면 no-op.
 *  SET NX lock → next() → 2xx면 결과 저장, throw/non-2xx면 lock 삭제(재시도 허용). */
export function idempotency(store: IdempotencyStore) {
  const ttl = store.ttlSeconds ?? 86_400;
  return async (c: Context, next: Next) => {
    const clientKey = c.req.header("idempotency-key");
    if (!clientKey) return next();
    const user = c.get("user");
    const raw = await c.req.raw.clone().text(); // clone → 핸들러의 valid("json") 보존
    const reqHash = hashBody(raw);
    // c.req.path = 실 tripId 포함(/v1/trips/<uuid>/expenses) → 교차-trip 격리(finding #4 pass1)
    const key = `idempotency:${user.id}:${c.req.path}:${clientKey}`;

    const existing = await store.redis.get(key);
    if (existing) {
      const rec = JSON.parse(existing) as IdemRecord;
      if (rec.lock) throw new ConflictError("idempotent request in progress", { key });
      if (rec.request_hash !== reqHash)
        throw new ConflictError("idempotency key reused with different body", { key });
      return c.json(JSON.parse(rec.body ?? "null"), (rec.status ?? 200) as 200); // replay
    }
    // SET NX EX — lock 선점(동시 같은 키 single-flight)
    const locked = await store.redis.set(
      key,
      JSON.stringify({ lock: true, request_hash: reqHash }),
      "EX",
      ttl,
      "NX",
    );
    if (locked !== "OK") throw new ConflictError("idempotent request in progress", { key });

    // 에러 경로에서도 lock 반드시 해제(finding #1 pass1) — 미해제 시 TTL 동안 재시도 차단.
    try {
      await next();
    } catch (e) {
      await store.redis.del(key); // throw(FxUnresolved·DB·검증) → lock 해제, 원에러 보존
      throw e;
    }
    if (c.res.status >= 200 && c.res.status < 300) {
      const body = await c.res.clone().text();
      await store.redis.set(
        key,
        JSON.stringify({ request_hash: reqHash, status: c.res.status, body }),
        "EX",
        ttl,
      );
    } else {
      await store.redis.del(key); // non-2xx(onError 변환 등) → 재시도 허용
    }
  };
}
