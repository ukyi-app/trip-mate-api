import type Redis from "ioredis";

/**
 * INCR 후 '방금 생성된 키에만' TTL을 건다(고정 윈도우).
 * 두 왕복(INCR → EXPIRE)으로 나누면 그 사이에 연결이 끊겼을 때 만료 없는 카운터가
 * 영구히 남아 해당 키의 rate limit이 영원히 잠긴다. Lua는 단일 원자 실행이라 그 창이 없다.
 * 증가할 때마다 만료를 갱신하지 않는 것도 계약이다 — 갱신하면 요청이 끊이지 않는 동안
 * 창이 계속 밀려 한도가 리셋되지 않는다.
 */
const INCR_FIXED_WINDOW = `
local v = redis.call('INCR', KEYS[1])
if v == 1 and tonumber(ARGV[1]) > 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return v
`;

/** Better Auth secondaryStorage 어댑터(Valkey/ioredis). ttl 단위=초. */
export class RedisSecondaryStorage {
  constructor(private readonly redis: Redis) {}
  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }
  /** 원자적 get+delete(GETDEL) — 1회용 값을 읽으며 소비한다. */
  async getAndDelete(key: string): Promise<string | null> {
    return this.redis.getdel(key);
  }
  /** 원자적 증가 — 증가 '후' 값을 돌려준다. 키 생성 시에만 ttl(초)을 건다. */
  async increment(key: string, ttl: number): Promise<number> {
    const v = await this.redis.eval(INCR_FIXED_WINDOW, 1, key, String(ttl));
    return Number(v);
  }
  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (ttl && ttl > 0) await this.redis.set(key, value, "EX", ttl);
    else await this.redis.set(key, value);
  }
  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
