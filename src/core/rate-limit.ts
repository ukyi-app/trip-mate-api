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
