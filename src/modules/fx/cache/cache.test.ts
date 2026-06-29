import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Decimal from "decimal.js";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import Redis from "ioredis";
import { MemoryCache } from "./cache.memory.ts";
import { RedisCache } from "./cache.redis.ts";
import type { CacheEntry, CachePort } from "../fx.types.ts";

const entry = (): CacheEntry => ({
  table: { USD: new Decimal(1), KRW: new Decimal("1320.5") },
  provider: "oxr",
  tableDate: "2026-08-04",
  fetchedAt: "2026-08-04T00:00:00.000Z",
});

function suite(
  name: string,
  make: () => Promise<{ cache: CachePort; cleanup: () => Promise<void> }>,
) {
  describe(name, () => {
    it("usdtable set→get round-trip (Decimal 복원)", async () => {
      const { cache, cleanup } = await make();
      await cache.setUsdTable("2026-08-04", entry(), 60);
      const got = await cache.getUsdTable("2026-08-04");
      expect(got?.table.KRW?.toString()).toBe("1320.5");
      expect(got?.provider).toBe("oxr");
      await cleanup();
    });
    it("miss → null", async () => {
      const { cache, cleanup } = await make();
      expect(await cache.getUsdTable("2099-01-01")).toBeNull();
      await cleanup();
    });
    it("lastknown set→get", async () => {
      const { cache, cleanup } = await make();
      await cache.setLastKnown(entry());
      expect((await cache.getLastKnown())?.tableDate).toBe("2026-08-04");
      await cleanup();
    });
    it("lastknown monotonic: older tableDate는 덮지 않음 (finding #1 pass5)", async () => {
      const { cache, cleanup } = await make();
      await cache.setLastKnown({ ...entry(), tableDate: "2026-08-04" });
      await cache.setLastKnown({ ...entry(), tableDate: "2026-07-01" }); // older → 무시
      expect((await cache.getLastKnown())?.tableDate).toBe("2026-08-04");
      await cleanup();
    });
  });
}

suite("MemoryCache(fake)", async () => ({ cache: new MemoryCache(), cleanup: async () => {} }));

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
suite("RedisCache(ioredis)", async () => ({
  cache: new RedisCache(redis),
  cleanup: async () => {},
}));
