import { createHash } from "node:crypto";
import type { Context, Next } from "hono";
import { and, eq, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { idempotencyKeys } from "../db/schema/idempotency.ts";
import { ConflictError, ValidationError } from "./errors.ts";

// DB-durable 멱등(§5). Redis 대체 — Postgres 영속으로 재시작/eviction에도 replay 보장.
export interface IdempotencyStore {
  db: PostgresJsDatabase<Record<string, unknown>>;
  ttlSeconds?: number; // 완료 기록 보존(default 24h)
  lockLeaseSeconds?: number; // 처리중 lock 임대(default 5m) — 크래시 시 짧게 자가해제(24h 포이즈닝 방지)
}
const MAX_KEY_LEN = 200; // nanoid ~21자. 과대 키가 text PK(btree ~2704B)를 넘겨 500 나는 것 차단.

// 서버 전용 멱등 네임스페이스 — 초안 confirm이 지출 생성에 쓰는 `draft:<id>` 키가 여기 속한다.
// 클라가 이 프리픽스로 지출을 선점(같은 키로 무관 지출 생성)해 confirm이 엉뚱한 지출에 링크되는 것을 차단.
export const RESERVED_IDEMPOTENCY_PREFIX = "draft:";

/** §5 멱등. scope=(principal + 실 요청 경로 + client key). requireAuth 뒤 적용. 헤더 없으면 no-op.
 *  INSERT ON CONFLICT DO NOTHING으로 single-flight, status NULL=처리중·정수=완료(replay).
 *  lock은 짧은 임대(lease)로 INSERT → 완료 시 보존 TTL로 연장. throw/non-2xx면 lock 삭제(재시도 허용).
 *  ⚠️ 완료 기록은 핸들러 효과와 별도 tx(미들웨어 한계) — 실패 시 임대 만료로 자가치유(중복 위험 bounded). */
export function idempotency(store: IdempotencyStore) {
  const ttl = store.ttlSeconds ?? 86_400;
  const lease = store.lockLeaseSeconds ?? 300;
  const db = store.db;
  return async (c: Context, next: Next) => {
    const clientKey = c.req.header("idempotency-key");
    if (!clientKey) return next();
    if (clientKey.length > MAX_KEY_LEN)
      throw new ValidationError("idempotency key too long", { max: MAX_KEY_LEN });
    // 서버 전용 네임스페이스는 클라가 못 쓴다(초안 confirm 키 선점→오링크 방지).
    if (clientKey.startsWith(RESERVED_IDEMPOTENCY_PREFIX))
      throw new ValidationError("reserved idempotency key prefix", {
        prefix: RESERVED_IDEMPOTENCY_PREFIX,
      });
    const user = c.get("user");
    // 정규화한 쿼리(키 정렬)로 파라미터 순서·인코딩만 다른 동일 요청은 같은 해시로 리플레이(리뷰).
    const params = new URL(c.req.raw.url).searchParams;
    params.sort();
    const search = params.toString();
    // **하위호환**: 쿼리 없는 라우트(기존 지출·정산·텍스트파싱)는 **기존 body-only 텍스트 해시 유지** —
    // 배포 전 기록된 idempotency 행과 해시가 일치해 재시도가 409 대신 리플레이된다(리뷰 M). JSON은 UTF-8이라 무손실.
    // 쿼리 있는 라우트(parse-image, 신규)만 새 포맷: 쿼리+**바이트 정확** 해시(바이너리 바디 lossy·쿼리 시맨틱 반영).
    let reqHash: string;
    if (search === "") {
      const raw = await c.req.raw.clone().text();
      reqHash = createHash("sha256").update(raw).digest("hex");
    } else {
      const rawBytes = new Uint8Array(await c.req.raw.clone().arrayBuffer());
      reqHash = createHash("sha256").update(search).update("\n").update(rawBytes).digest("hex");
    }
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

    // lock 선점: INSERT ON CONFLICT DO NOTHING(동시 같은 키 single-flight). 짧은 임대.
    const inserted = await db
      .insert(idempotencyKeys)
      .values({
        scope_key: key,
        request_hash: reqHash,
        expires_at: sql`now() + (${lease} * interval '1 second')`,
      })
      .onConflictDoNothing()
      .returning({ k: idempotencyKeys.scope_key });
    if (inserted.length === 0) throw new ConflictError("idempotent request in progress", { key }); // 동시 선점됨

    // 에러 경로에서도 lock 반드시 해제 — 미해제 시 임대 동안 재시도 차단.
    try {
      await next();
    } catch (e) {
      await db.delete(idempotencyKeys).where(eq(idempotencyKeys.scope_key, key)); // throw → lock 해제, 원에러 보존
      throw e;
    }
    // 완료 기록(핸들러 효과와 별도 tx) — 실패해도 핸들러 응답은 반환. 짧은 임대가 자가치유.
    try {
      if (c.res.status >= 200 && c.res.status < 300) {
        const body = await c.res.clone().text();
        await db
          .update(idempotencyKeys)
          .set({
            status: c.res.status,
            response_body: body,
            expires_at: sql`now() + (${ttl} * interval '1 second')`, // 완료 → 보존 TTL로 연장
          })
          .where(eq(idempotencyKeys.scope_key, key));
      } else {
        await db.delete(idempotencyKeys).where(eq(idempotencyKeys.scope_key, key)); // non-2xx → 재시도 허용
      }
    } catch {
      // 완료 기록 실패: 핸들러는 이미 2xx로 성공·효과 커밋됨 → 그 응답 유지(500으로 덮지 않음).
      // 미기록 lock은 짧은 임대(lease)로 만료 → 재시도 가능(중복 위험은 임대 윈도로 bounded).
    }
  };
}

/** 만료 멱등 행 정리(Redis EX 자동 eviction 대체). 주기 실행 권장 — main.ts에서 setInterval로 배선. */
export async function sweepExpiredIdempotency(
  db: PostgresJsDatabase<Record<string, unknown>>,
): Promise<number> {
  const deleted = await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.expires_at, sql`now()`))
    .returning({ k: idempotencyKeys.scope_key });
  return deleted.length;
}
