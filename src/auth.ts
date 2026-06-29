import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createDb } from "./db/client.ts";
import { env } from "./core/config.ts";

// cli generate용 최소 설정 (라우트 핸들러 마운트는 후속 인증 slice).
// 이메일 기반 계정 링킹 금지 → Google sub 1:1 (auth 설계 §1).
export const auth = betterAuth({
  database: drizzleAdapter(createDb(env.DATABASE_URL), { provider: "pg" }),
  account: { accountLinking: { enabled: false } },
  socialProviders: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
    },
  },
});
