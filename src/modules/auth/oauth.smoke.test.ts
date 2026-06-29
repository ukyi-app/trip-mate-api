import { describe, it, expect } from "vitest";

const e = process.env;
const hasKeys =
  !!e.GOOGLE_CLIENT_ID &&
  !!e.GOOGLE_CLIENT_SECRET &&
  !!e.VALKEY_URL &&
  !!e.DATABASE_URL &&
  !!e.BETTER_AUTH_SECRET &&
  !!e.BETTER_AUTH_URL;

describe.skipIf(!hasKeys)("Better Auth 실 OAuth smoke (pre-deploy)", () => {
  it("auth 인스턴스 부팅 + /api/auth 핸들러 응답", async () => {
    const { createAuth } = await import("../../auth.ts");
    const { createDb } = await import("../../db/client.ts");
    const IoRedis = (await import("ioredis")).default;
    const redis = new IoRedis(e.VALKEY_URL!);
    try {
      const auth = createAuth({
        db: createDb(e.DATABASE_URL!),
        redis,
        secret: e.BETTER_AUTH_SECRET!,
        baseURL: e.BETTER_AUTH_URL!,
        trustedOrigins: (e.WEB_ORIGINS ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        useSecureCookies: false,
        google: { clientId: e.GOOGLE_CLIENT_ID!, clientSecret: e.GOOGLE_CLIENT_SECRET! },
      });
      const res = await auth.handler(new Request("http://localhost/api/auth/ok"));
      expect([200, 401, 404]).toContain(res.status);
    } finally {
      redis.disconnect();
    }
  });
});
