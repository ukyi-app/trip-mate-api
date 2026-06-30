import { describe, it, expect, vi, afterEach } from "vitest";

const FULL: Record<string, string> = {
  TRIP_MATE_DATABASE_URL: "postgres://u:p@localhost:5432/db",
  BETTER_AUTH_URL: "http://localhost:3000",
  TRIP_MATE_REDIS_URL: "redis://localhost:6379",
  WEB_ORIGINS: "http://localhost:5173",
  BETTER_AUTH_SECRET: "x".repeat(32),
};
const stub = (over: Record<string, string>) => {
  for (const [k, v] of Object.entries({ ...FULL, ...over })) vi.stubEnv(k, v);
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("env 검증 (createEnv)", () => {
  it("32자 이상 시크릿 → 로드 성공", async () => {
    stub({});
    const { env } = await import("./config.ts");
    expect(env.BETTER_AUTH_SECRET.length).toBeGreaterThanOrEqual(32);
  });
  it("짧은 시크릿(<32) → 부팅 실패 (finding #1)", async () => {
    stub({ BETTER_AUTH_SECRET: "short" });
    await expect(import("./config.ts")).rejects.toThrow();
  });
});
