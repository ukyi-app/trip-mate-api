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
  it("getAndDelete: 값을 돌려주고 같은 호출로 키를 소비한다", async () => {
    const s = new RedisSecondaryStorage(redis);
    await s.set("k4", "v4");
    expect(await s.getAndDelete("k4")).toBe("v4");
    expect(await s.get("k4")).toBeNull();
  });
  it("getAndDelete: 없는 키는 null", async () => {
    const s = new RedisSecondaryStorage(redis);
    expect(await s.getAndDelete("absent-getdel")).toBeNull();
  });
  it("increment: 증가 후 값을 돌려주고 생성 시 ttl을 건다", async () => {
    const s = new RedisSecondaryStorage(redis);
    expect(await s.increment("c1", 100)).toBe(1);
    expect(await s.increment("c1", 100)).toBe(2);
    expect(await redis.ttl("c1")).toBeGreaterThan(0);
  });
  it("increment: 재증가는 만료를 연장하지 않는다(고정 윈도우)", async () => {
    const s = new RedisSecondaryStorage(redis);
    await s.increment("c2", 50);
    // 두 번째 호출이 더 긴 ttl을 줘도 창은 최초 생성 시점 기준으로 유지돼야 한다.
    await s.increment("c2", 5000);
    expect(await redis.ttl("c2")).toBeLessThanOrEqual(50);
  });
  it("increment: ttl<=0이면 만료를 걸지 않는다", async () => {
    const s = new RedisSecondaryStorage(redis);
    expect(await s.increment("c3", 0)).toBe(1);
    expect(await redis.ttl("c3")).toBe(-1); // -1 = 키는 있으나 만료 없음
  });
});
