import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { enforceHostCookie } from "./host-cookie.ts";

describe("enforceHostCookie", () => {
  it("__Secure- 세션 쿠키 → __Host- 정규화, Domain 제거, Secure 보장", async () => {
    const app = new Hono();
    app.use("*", enforceHostCookie({ secure: true }));
    app.get("/x", (c) => {
      c.header(
        "set-cookie",
        "__Secure-better-auth.session_token=abc; Domain=.ukyi.app; Path=/; HttpOnly; SameSite=Lax; Secure",
      );
      return c.body("ok");
    });
    const sc = (await app.request("/x")).headers.get("set-cookie") ?? "";
    expect(sc.startsWith("__Host-")).toBe(true);
    expect(sc).not.toMatch(/Domain=/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/Path=\//i);
  });
  it("secure=false(로컬 http) → 미변경(__Host- 불가)", async () => {
    const app = new Hono();
    app.use("*", enforceHostCookie({ secure: false }));
    app.get("/x", (c) => {
      c.header("set-cookie", "better-auth.session_token=abc; Path=/");
      return c.body("ok");
    });
    expect((await app.request("/x")).headers.get("set-cookie")).toBe(
      "better-auth.session_token=abc; Path=/",
    );
  });
});
