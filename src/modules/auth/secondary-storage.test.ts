import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import Redis from "ioredis";
import { RedisSecondaryStorage } from "./secondary-storage.ts";

let container: StartedRedisContainer;
let redis: Redis;
beforeAll(async () => {
  container = await new RedisContainer("redis:7").start();
  redis = new Redis(container.getConnectionUrl());
});
afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
});

describe("RedisSecondaryStorage (Better Auth secondaryStorage 계약)", () => {
  it("set→get round-trip", async () => {
    const s = new RedisSecondaryStorage(redis);
    await s.set("k1", "v1");
    expect(await s.get("k1")).toBe("v1");
  });
  it("miss → null", async () => {
    const s = new RedisSecondaryStorage(redis);
    expect(await s.get("absent")).toBeNull();
  });
  it("ttl(초) 설정 시 만료", async () => {
    const s = new RedisSecondaryStorage(redis);
    await s.set("k2", "v2", 1);
    expect(await redis.ttl("k2")).toBeGreaterThan(0);
  });
  it("delete", async () => {
    const s = new RedisSecondaryStorage(redis);
    await s.set("k3", "v3");
    await s.delete("k3");
    expect(await s.get("k3")).toBeNull();
  });
});
