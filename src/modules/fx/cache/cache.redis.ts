import type Redis from "ioredis";
import type { CacheEntry, CachePort } from "../fx.types.ts";
import { fromWire, toWire, type Wire } from "./cache.memory.ts";

export class RedisCache implements CachePort {
  constructor(private readonly redis: Redis) {}
  async getUsdTable(date: string) {
    const v = await this.redis.get(`fx:usdtable:${date}`);
    return v ? fromWire(JSON.parse(v) as Wire) : null;
  }
  async setUsdTable(date: string, entry: CacheEntry, ttlSeconds: number) {
    await this.redis.set(`fx:usdtable:${date}`, JSON.stringify(toWire(entry)), "EX", ttlSeconds);
  }
  async getLastKnown() {
    const v = await this.redis.get("fx:lastknown:usdtable");
    return v ? fromWire(JSON.parse(v) as Wire) : null;
  }
  async setLastKnown(entry: CacheEntry) {
    const existing = await this.getLastKnown();
    if (existing && existing.tableDate > entry.tableDate) return; // monotonic (best-effort; 원자성은 single-flight 슬라이스, finding #1 pass5)
    await this.redis.set("fx:lastknown:usdtable", JSON.stringify(toWire(entry)));
  }
}
