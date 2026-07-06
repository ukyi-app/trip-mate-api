import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    PORT: z.coerce.number().int().positive().default(8080), // 공유 차트 ports.http 계약
    // DB conn 핸들(homelab create-database name=trip-mate → TRIP_MATE_*). 런타임=pgbouncer 풀러.
    TRIP_MATE_DATABASE_URL: z.string().url(),
    // boot self-migrate 직결(pg-rw). 없으면 TRIP_MATE_DATABASE_URL 사용(로컬·단일 conn).
    TRIP_MATE_MIGRATE_DATABASE_URL: z.string().url().optional(),
    BETTER_AUTH_SECRET: z
      .string()
      .min(32, "BETTER_AUTH_SECRET는 최소 32자(고엔트로피, openssl rand -base64 32) — finding #1"),
    BETTER_AUTH_URL: z.string().url(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    // ── 인증·초대 슬라이스 ── 세션 secondaryStorage·FX 캐시(ioredis). create-cache name=trip-mate.
    TRIP_MATE_REDIS_URL: z.string().url(),
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
    // ── 초대 이메일(Resend) ── 없으면 발송 skip(no-op)
    RESEND_API_KEY: z.string().optional(),
    MAIL_FROM: z.string().default("noreply@ukyi.app"), // Resend 검증된 발신 도메인
    // ── 파일 서버(영수증 업로드, files.home) ── BASE_URL·API_KEY 없으면 영수증 라우트 미등록
    FILES_BASE_URL: z.string().url().optional(),
    FILES_API_KEY: z.string().optional(),
    FILES_BUCKET: z.string().default("trip-mate"),

    USE_SECURE_COOKIES: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"), // prod=true, 로컬 http 개발만 false
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
