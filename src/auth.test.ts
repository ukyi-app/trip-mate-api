import { describe, it, expect, vi } from "vitest";
import { createAuth, type AuthDeps } from "./auth.ts";
import { createDb } from "./db/client.ts";

// 외부 IO 없음(finding #2): fake redis + lazy postgres 클라이언트(연결 안 함) 주입. env 미평가.
const fakeRedis = {
  get: vi.fn(async () => null),
  set: vi.fn(async () => "OK"),
  del: vi.fn(async () => 1),
} as unknown as import("ioredis").default;

const deps = (over: Partial<AuthDeps> = {}): AuthDeps => ({
  db: createDb("postgres://u:p@localhost:5432/db"), // postgres.js lazy — 구성만, 연결 X
  redis: fakeRedis,
  secret: "x".repeat(32),
  baseURL: "http://localhost:3000",
  trustedOrigins: ["https://app.ukyi.app"],
  useSecureCookies: false,
  ...over,
});

describe("createAuth 보안 불변식", () => {
  it("accountLinking 비활성(이메일 기반 링킹 금지)", () => {
    expect(createAuth(deps()).options.account?.accountLinking?.enabled).toBe(false);
  });
  it("trustedOrigins=주입 origin", () => {
    expect(
      createAuth(deps({ trustedOrigins: ["https://app.ukyi.app"] })).options.trustedOrigins,
    ).toContain("https://app.ukyi.app");
  });
  it("secondaryStorage 주입(세션 Postgres 비대화)", () => {
    expect(createAuth(deps()).options.secondaryStorage).toBeDefined();
  });
  it("쿠키는 Domain 미설정(host-only) — crossSubDomainCookies 비활성", () => {
    expect(createAuth(deps()).options.advanced?.crossSubDomainCookies?.enabled ?? false).toBe(
      false,
    );
  });
  it("prod(useSecureCookies) → Secure 강제·host-only(Domain 없음) (finding #1 pass4/5)", () => {
    const auth = createAuth(deps({ useSecureCookies: true }));
    expect(auth.options.advanced?.useSecureCookies).toBe(true);
    expect(auth.options.advanced?.crossSubDomainCookies?.enabled ?? false).toBe(false);
  });
});
