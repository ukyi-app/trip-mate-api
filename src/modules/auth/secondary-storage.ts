import type Redis from "ioredis";

/** Better Auth secondaryStorage 어댑터(Valkey/ioredis). ttl 단위=초. */
export class RedisSecondaryStorage {
  constructor(private readonly redis: Redis) {}
  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }
  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (ttl && ttl > 0) await this.redis.set(key, value, "EX", ttl);
    else await this.redis.set(key, value);
  }
  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
