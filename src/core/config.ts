import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
    BETTER_AUTH_SECRET: z
      .string()
      .min(32, "BETTER_AUTH_SECRET는 최소 32자(고엔트로피, openssl rand -base64 32) — finding #1"),
    BETTER_AUTH_URL: z.string().url(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    // ── 인증·초대 슬라이스 추가 ──
    VALKEY_URL: z.string().url(), // 세션 secondaryStorage (ioredis). 예 redis://localhost:6379
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
    USE_SECURE_COOKIES: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"), // prod=true, 로컬 http 개발만 false
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
