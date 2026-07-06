import type { Context, MiddlewareHandler, Next } from "hono";
import type Redis from "ioredis";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** 클라이언트 IP 판정(순수). Cloudflare Tunnel의 CF-Connecting-IP 우선, 없으면 X-Forwarded-For 첫 홉. */
export function clientIp(headers: { get(name: string): string | null }): string {
  const cf = headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return "";
}

export interface RateLimitOpts {
  scope: string; // 카운터 네임스페이스(라우트군 구분)
  max: number; // windowSec 당 허용 요청 수
  windowSec: number;
}

// 원자 INCR+EXPIRE(첫 요청만 TTL 설정). 비원자 INCR→EXPIRE는 중간 실패 시 TTL 없는 스턱 키(영구 429) 위험.
const INCR_EXPIRE = `local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return c`;

// 이중 쿼터 원자 검사(user·trip): 둘 다 상한 미만일 때만 둘 다 INCR(all-or-nothing). 하나라도 초과면 아무것도 안 늘림
// → 거부된 요청이 다른 카운터를 소모하지 않는다. redis eval은 원자적이라 check-then-incr 레이스도 없음.
const DUAL_QUOTA = `local uMax, uWin, tMax, tWin = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local uc = tonumber(redis.call('GET', KEYS[1])) or 0
if uc >= uMax then local ttl = redis.call('TTL', KEYS[1]); if ttl < 0 then ttl = uWin end; return {1, ttl} end
local tc = tonumber(redis.call('GET', KEYS[2])) or 0
if tc >= tMax then local ttl = redis.call('TTL', KEYS[2]); if ttl < 0 then ttl = tWin end; return {2, ttl} end
local nu = redis.call('INCR', KEYS[1]); if nu == 1 then redis.call('EXPIRE', KEYS[1], uWin) end
local nt = redis.call('INCR', KEYS[2]); if nt == 1 then redis.call('EXPIRE', KEYS[2], tWin) end
return {0, 0}`;

export interface DualQuota {
  userKey: string;
  userMax: number;
  userWindowSec: number;
  tripKey: string;
  tripMax: number;
  tripWindowSec: number;
}

// 소비 환불(원자 DECR, 0 미만 방지). 슬롯 예약 실패(파서 busy) 등 작업 미수행 시 소비한 카운터를 되돌린다.
const REFUND_DUAL = `for i = 1, 2 do
  local v = tonumber(redis.call('GET', KEYS[i]))
  if v and v > 0 then redis.call('DECR', KEYS[i]) end
end
return 1`;

/** checkDualQuota로 소비한 user·trip 카운터 1건씩 환불(작업 미수행 시). */
export async function refundDualQuota(
  redis: Redis,
  keys: { userKey: string; tripKey: string },
): Promise<void> {
  await redis.eval(REFUND_DUAL, 2, keys.userKey, keys.tripKey);
}

/** user·trip 이중 쿼터 원자 소비. 초과 시 어느 것도 소모하지 않고 retryAfter(초) 반환. */
export async function checkDualQuota(
  redis: Redis,
  q: DualQuota,
): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const [status, retry] = (await redis.eval(
    DUAL_QUOTA,
    2,
    q.userKey,
    q.tripKey,
    String(q.userMax),
    String(q.userWindowSec),
    String(q.tripMax),
    String(q.tripWindowSec),
  )) as [number, number];
  return status === 0 ? { ok: true } : { ok: false, retryAfter: retry };
}

/** Redis 고정윈도우 rate limit 미들웨어. 초과 시 429 problem+json + Retry-After.
 *  원자 Lua로 INCR+EXPIRE, IP별(`rl:{scope}:{ip}`) 격리. */
export function rateLimit(redis: Redis, opts: RateLimitOpts): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const ip = clientIp(c.req.raw.headers) || "unknown";
    const key = `rl:${opts.scope}:${ip}`;
    const count = Number(await redis.eval(INCR_EXPIRE, 1, key, String(opts.windowSec)));
    if (count > opts.max) {
      const ttl = await redis.ttl(key);
      const retry = ttl > 0 ? ttl : opts.windowSec;
      return c.json(
        {
          type: "about:blank",
          title: "TooManyRequests",
          status: 429,
          code: "TooManyRequests",
          detail: `rate limit exceeded (${opts.max}/${opts.windowSec}s)`,
        },
        429,
        { "content-type": "application/problem+json", "Retry-After": String(retry) },
      );
    }
    await next();
    return;
  };
}

/** 쓰기(unsafe 메서드)만 제한 — GET/HEAD/OPTIONS는 통과. 공개 API의 증폭/브루트포스 방어. */
export function rateLimitWrites(redis: Redis, opts: RateLimitOpts): MiddlewareHandler {
  const mw = rateLimit(redis, opts);
  return async (c: Context, next: Next) => {
    if (SAFE.has(c.req.method.toUpperCase())) return next();
    return mw(c, next);
  };
}
