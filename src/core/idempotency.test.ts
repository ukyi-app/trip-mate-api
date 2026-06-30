import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { startDb, type Ctx } from "../../tests/db/helpers.ts";
import { idempotency } from "./idempotency.ts";
import { registerErrorFilter, ValidationError } from "./errors.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

// user를 강제로 셋하는 테스트용 앱. /x·/y는 경로 격리, /boom은 throw(lock 해제 검증).
function app(userId = "u1") {
  const a = new Hono();
  registerErrorFilter(a);
  a.use("*", async (c, next) => {
    c.set("user", { id: userId });
    await next();
  });
  const store = { db: ctx.db };
  a.use("/x", idempotency(store));
  a.use("/y", idempotency(store));
  a.use("/boom", idempotency(store));
  let calls = 0;
  a.post("/x", (c) => {
    calls++;
    return c.json({ ok: true, calls }, 201);
  });
  a.post("/y", (c) => c.json({ from: "y" }, 201));
  a.post("/boom", () => {
    throw new ValidationError("nope");
  });
  return a;
}
const post = (a: ReturnType<typeof app>, path: string, key: string | null, body: unknown) =>
  a.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    body: JSON.stringify(body),
  });

describe("idempotency 미들웨어(DB)", () => {
  it("헤더 없으면 매번 통과", async () => {
    const a = app();
    expect((await post(a, "/x", null, { n: 1 })).status).toBe(201);
    expect((await post(a, "/x", null, { n: 1 })).status).toBe(201);
  });
  it("같은 키·같은 body → 저장된 동일 응답(핸들러 1회)", async () => {
    const a = app("u-replay");
    const r1 = (await (await post(a, "/x", "k1", { n: 1 })).json()) as { calls: number };
    const r2 = (await (await post(a, "/x", "k1", { n: 1 })).json()) as { calls: number };
    expect(r2.calls).toBe(r1.calls); // 핸들러 재실행 안 됨
  });
  it("같은 키·다른 body → 409", async () => {
    const a = app("u-conflict");
    expect((await post(a, "/x", "k2", { n: 1 })).status).toBe(201);
    expect((await post(a, "/x", "k2", { n: 2 })).status).toBe(409);
  });
  it("다른 user 같은 키 → 격리(각자 처리)", async () => {
    expect((await post(app("uA"), "/x", "shared", { n: 1 })).status).toBe(201);
    expect((await post(app("uB"), "/x", "shared", { n: 1 })).status).toBe(201);
  });
  it("다른 경로 같은 키 → 격리(교차-trip 프록시)", async () => {
    const a = app("u-path");
    expect((await post(a, "/x", "samekey", { n: 1 })).status).toBe(201);
    expect((await post(a, "/y", "samekey", { n: 1 })).status).toBe(201); // 다른 경로 → 독립
  });
  it("핸들러 throw(422) → lock 해제, 같은 키 재시도 가능", async () => {
    const a = app("u-boom");
    expect((await post(a, "/boom", "bk", { n: 1 })).status).toBe(422);
    expect((await post(a, "/boom", "bk", { n: 1 })).status).toBe(422); // lock 풀림 → 재실행
  });
  it("처리중(lock) 행 존재 → 409 in-progress", async () => {
    const a = app("u-lock");
    await ctx.sql`insert into idempotency_keys (scope_key, request_hash, expires_at)
      values (${"u-lock:/x:lk"}, 'x', now() + interval '1 hour')`; // status null=처리중
    expect((await post(a, "/x", "lk", { n: 1 })).status).toBe(409);
  });
  it("완료 행 DB 영속 → 새 미들웨어 인스턴스에서도 replay(durable)", async () => {
    const r1 = await post(app("u-dur"), "/x", "dk", { n: 1 });
    expect(r1.status).toBe(201);
    const j1 = (await r1.json()) as { calls: number };
    const r2 = await post(app("u-dur"), "/x", "dk", { n: 1 }); // 다른 app 인스턴스, 같은 DB
    expect(r2.status).toBe(201);
    expect(((await r2.json()) as { calls: number }).calls).toBe(j1.calls); // 저장본 replay
  });
  it("만료된 행은 부재 취급 → 재처리", async () => {
    const a = app("u-exp");
    expect((await post(a, "/x", "ek", { n: 1 })).status).toBe(201);
    await ctx.sql`update idempotency_keys set expires_at = now() - interval '1 second' where scope_key=${"u-exp:/x:ek"}`;
    expect((await post(a, "/x", "ek", { n: 1 })).status).toBe(201); // 만료 → 재처리
  });
});
