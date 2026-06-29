import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import IoRedis, { type Redis } from "ioredis";
import { Hono } from "hono";
import { idempotency } from "./idempotency.ts";
import { registerErrorFilter, ValidationError } from "./errors.ts";

let container: StartedTestContainer;
let redis: Redis;
beforeAll(async () => {
  container = await new GenericContainer("redis:7").withExposedPorts(6379).start();
  redis = new IoRedis(container.getMappedPort(6379), container.getHost());
}, 60_000);
afterAll(async () => {
  redis.disconnect();
  await container.stop();
});

// user를 강제로 셋하는 테스트용 앱. /x·/y는 경로 격리(=교차-trip 프록시), /boom은 throw(lock 해제 검증)
function app(userId = "u1") {
  const a = new Hono();
  registerErrorFilter(a);
  a.use("*", async (c, next) => {
    c.set("user", { id: userId });
    await next();
  });
  a.use("/x", idempotency({ redis }));
  a.use("/y", idempotency({ redis }));
  a.use("/boom", idempotency({ redis }));
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

describe("idempotency 미들웨어", () => {
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
  it("다른 경로 같은 키 → 격리(교차-trip 프록시, finding #4 pass1)", async () => {
    const a = app("u-path");
    expect((await post(a, "/x", "samekey", { n: 1 })).status).toBe(201);
    expect((await post(a, "/y", "samekey", { n: 1 })).status).toBe(201); // 다른 경로 → 독립
  });
  it("핸들러 throw(422) → lock 해제, 같은 키 재시도 가능(finding #1 pass1)", async () => {
    const a = app("u-boom");
    expect((await post(a, "/boom", "bk", { n: 1 })).status).toBe(422);
    // lock이 안 풀렸다면 두 번째는 409 in-progress → 풀렸으면 다시 422(핸들러 재실행)
    expect((await post(a, "/boom", "bk", { n: 1 })).status).toBe(422);
  });
});
