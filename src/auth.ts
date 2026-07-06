import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type Redis from "ioredis";
import type { DB } from "./db/client.ts";
import { RedisSecondaryStorage } from "./modules/auth/secondary-storage.ts";
import { assertGoogleEmailVerified } from "./modules/auth/email-verified.ts";

export interface AuthDeps {
  db: DB;
  redis: Redis;
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  useSecureCookies: boolean;
  google?: { clientId: string; clientSecret: string };
}

/** 완전 DI 팩토리 — top-level env read·IO·싱글톤 없음(finding #2 pass2). 테스트는 fake만 주입,
 *  운영 싱글톤은 main.ts 컴포지션 루트가 구성(`new IoRedis(env.TRIP_MATE_REDIS_URL)` 등은 거기서). */
export function createAuth(deps: AuthDeps) {
  const storage = new RedisSecondaryStorage(deps.redis);
  return betterAuth({
    database: drizzleAdapter(deps.db, { provider: "pg" }),
    secret: deps.secret,
    baseURL: deps.baseURL,
    trustedOrigins: deps.trustedOrigins,
    // 인증 엔드포인트 rate limit(로그인/OAuth 브루트포스 방어). Redis(secondaryStorage) 스토리지.
    // enabled는 Better Auth 기본(prod 자동 on) — 재사용, storage만 분산 Redis로 지정.
    rateLimit: { storage: "secondary-storage" },
    // 세션: Valkey(secondaryStorage) — Postgres 세션 테이블 비대화 회피(설계 D2)
    secondaryStorage: {
      get: (k) => storage.get(k),
      set: (k, v, ttl) => storage.set(k, v, ttl),
      delete: (k) => storage.delete(k),
    },
    // 계정 링킹 금지: Google sub 1:1, 이메일 기반 병합 차단(설계 §1·pass2)
    account: { accountLinking: { enabled: false } },
    socialProviders: {
      google: {
        clientId: deps.google?.clientId ?? "",
        clientSecret: deps.google?.clientSecret ?? "",
        // email_verified=false Google 계정 거부(§34.4). mapProfileToUser에서 가드.
        mapProfileToUser: (profile) => {
          assertGoogleEmailVerified(profile as { email: string; email_verified?: boolean });
          return { email: profile.email, name: profile.name, image: profile.picture };
        },
      },
    },
    // 쿠키: host-only(__Host- 강제는 enforceHostCookie 미들웨어, Task 5) — Domain 미설정·Secure·Path=/·SameSite=Lax·HttpOnly.
    advanced: {
      useSecureCookies: deps.useSecureCookies,
      crossSubDomainCookies: { enabled: false }, // 명시적 host-only(Domain 없음) — 형제 서브도메인 노출 차단(설계 §2)
      defaultCookieAttributes: {
        sameSite: "lax",
        httpOnly: true,
        path: "/",
        secure: deps.useSecureCookies,
      },
    },
  });
}
