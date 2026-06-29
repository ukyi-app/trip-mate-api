import type { Context, Next } from "hono";
import { ForbiddenError } from "./errors.ts";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** 순수 판정: unsafe 메서드는 Origin 정확 일치 필요, Sec-Fetch-Site=cross-site는 추가 deny. */
export function decideCsrf(
  method: string,
  origin: string | null,
  secFetchSite: string | null,
  allow: readonly string[],
): { allow: boolean; reason?: string } {
  if (SAFE.has(method.toUpperCase())) return { allow: true };
  if (secFetchSite === "cross-site") return { allow: false, reason: "sec-fetch-site:cross-site" };
  if (!origin) return { allow: false, reason: "origin-missing" };
  if (!allow.includes(origin)) return { allow: false, reason: "origin-not-allowed" };
  return { allow: true };
}

/** 앱 전역 미들웨어. 위반 시 ForbiddenError → onError(403). */
export function csrf(allow: readonly string[]) {
  return async (c: Context, next: Next) => {
    const d = decideCsrf(
      c.req.method,
      c.req.header("origin") ?? null,
      c.req.header("sec-fetch-site") ?? null,
      allow,
    );
    if (!d.allow) throw new ForbiddenError("csrf origin check failed", { reason: d.reason });
    await next();
  };
}
