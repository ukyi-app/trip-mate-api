import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    PORT: z.coerce.number().int().positive().default(8080), // 공유 차트 ports.http 계약
    DATABASE_URL: z.string().url(), // 런타임(pgbouncer 풀러 권장)
    MIGRATE_DATABASE_URL: z.string().url().optional(), // boot self-migrate 직결(없으면 DATABASE_URL)
    BETTER_AUTH_SECRET: z
      .string()
      .min(32, "BETTER_AUTH_SECRET는 최소 32자(고엔트로피, openssl rand -base64 32) — finding #1"),
    BETTER_AUTH_URL: z.string().url(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    // ── 인증·초대 슬라이스 추가 ── 세션 secondaryStorage·FX 캐시(ioredis).
    // 계약 키는 REDIS_URL(homelab), 로컬 별칭 VALKEY_URL 폴백 — 하나는 필수(main.ts에서 해소·검증).
    REDIS_URL: z.string().url().optional(),
    VALKEY_URL: z.string().url().optional(),
    // FE origin allowlist(CSRF 정확 일치 + Better Auth trustedOrigins). 콤마구분 → 배열.
    WEB_ORIGINS: z
      .string()
      .min(1)
      .transform((s) =>
        s
          .split(",")
          .map((o) => o.trim())
          .filter(Boolean),
      ),
    INVITE_TOKEN_TTL_HOURS: z.coerce.number().int().positive().default(168), // 7d
    // ── FX 통합 슬라이스 추가 ── (provider 키 — 있으면 auto FX, 없으면 identity/manual만)
    OXR_APP_ID: z.string().optional(),
    CURRENCYAPI_KEY: z.string().optional(),
    USE_SECURE_COOKIES: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"), // prod=true, 로컬 http 개발만 false
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
