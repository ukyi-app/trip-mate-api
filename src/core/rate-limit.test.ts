import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import Redis from "ioredis";
import { Hono } from "hono";
import { clientIp, rateLimit, rateLimitWrites } from "./rate-limit.ts";
import { buildV1App } from "../app.ts";

const hdr = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });

describe("clientIp (순수)", () => {
  it("CF-Connecting-IP 우선(Cloudflare Tunnel)", () => {
    expect(clientIp(hdr({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }))).toBe(
      "1.2.3.4",
    );
  });
  it("CF 없으면 X-Forwarded-For 첫 홉", () => {
    expect(clientIp(hdr({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }))).toBe("9.9.9.9");
  });
  it("둘 다 없으면 빈 문자열", () => {
    expect(clientIp(hdr({}))).toBe("");
  });
});

let container: StartedRedisContainer;
let redis: Redis;
beforeAll(async () => {
  container = await new RedisContainer("redis:7").start();
  redis = new Redis(container.getConnectionUrl());
}, 120_000);
afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
});

describe("rateLimit (Redis 고정윈도우)", () => {
  it("한도 내 통과, 초과 시 429 + Retry-After + problem+json", async () => {
    const app = new Hono();
    app.use("*", rateLimit(redis, { scope: "t1", max: 2, windowSec: 60 }));
    app.get("/", (c) => c.text("ok"));
    const call = () => app.request("/", { headers: { "cf-connecting-ip": "5.5.5.5" } });
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const r = await call();
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(r.headers.get("content-type")).toContain("application/problem+json");
  });

  it("IP별 독립 카운트", async () => {
    const app = new Hono();
    app.use("*", rateLimit(redis, { scope: "t2", max: 1, windowSec: 60 }));
    app.get("/", (c) => c.text("ok"));
    const at = (ip: string) => app.request("/", { headers: { "cf-connecting-ip": ip } });
    expect((await at("1.1.1.1")).status).toBe(200);
    expect((await at("2.2.2.2")).status).toBe(200); // 다른 IP는 별도 카운트
    expect((await at("1.1.1.1")).status).toBe(429); // 같은 IP 재요청 → 초과
  });
});

describe("rateLimitWrites (unsafe 메서드만)", () => {
  it("GET은 한도 무시, POST만 제한", async () => {
    const app = new Hono();
    app.use("*", rateLimitWrites(redis, { scope: "t3", max: 1, windowSec: 60 }));
    app.get("/", (c) => c.text("ok"));
    app.post("/", (c) => c.text("created"));
    const get = () => app.request("/", { headers: { "cf-connecting-ip": "7.7.7.7" } });
    const post = () =>
      app.request("/", { method: "POST", headers: { "cf-connecting-ip": "7.7.7.7" } });
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(200); // GET 여러 번도 통과
    expect((await post()).status).toBe(200); // 첫 POST
    expect((await post()).status).toBe(429); // 두 번째 POST 초과
  });
});

describe("buildV1App rate-limit 배선", () => {
  it("반복 쓰기 → 429 (미들웨어가 라우트 전에 적용됨)", async () => {
    const v1 = buildV1App({
      tripsService: {} as never,
      membersService: {} as never,
      expensesService: {} as never,
      settlementsService: {} as never,
      tripDefaults: {} as never,
      resolver: async () => null,
      emailOf: async () => "",
      memberLookup: async () => null,
      idempotencyStore: null,
      webOrigins: ["https://trip-mate.ukyi.app"],
      rateLimit: rateLimit(redis, { scope: "wire", max: 1, windowSec: 60 }),
    });
    const post = () =>
      v1.request("/v1/trips", {
        method: "POST",
        headers: {
          "cf-connecting-ip": "8.8.8.8",
          origin: "https://trip-mate.ukyi.app",
          "content-type": "application/json",
        },
        body: "{}",
      });
    expect((await post()).status).not.toBe(429); // 1번째 통과(하위 auth/validation 거부돼도 429 아님)
    expect((await post()).status).toBe(429); // 2번째 → rate-limit 차단
  });
});
