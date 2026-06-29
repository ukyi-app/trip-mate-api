import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { decideCsrf, csrf } from "./csrf.ts";

const ALLOW = ["https://app.ukyi.app"];

describe("decideCsrf (순수 판정)", () => {
  it("안전 메서드는 origin 무관 allow", () => {
    expect(decideCsrf("GET", null, null, ALLOW)).toEqual({ allow: true });
  });
  it("정확 origin 일치 → allow", () => {
    expect(decideCsrf("POST", "https://app.ukyi.app", null, ALLOW)).toEqual({ allow: true });
  });
  it("형제 서브도메인 → deny", () => {
    expect(decideCsrf("POST", "https://evil.ukyi.app", null, ALLOW).allow).toBe(false);
  });
  it("외부 origin → deny", () => {
    expect(decideCsrf("POST", "https://evil.com", null, ALLOW).allow).toBe(false);
  });
  it("Origin 누락(unsafe) → deny", () => {
    expect(decideCsrf("POST", null, null, ALLOW).allow).toBe(false);
  });
  it("Sec-Fetch-Site=cross-site는 origin 일치해도 deny(추가 신호)", () => {
    expect(decideCsrf("POST", "https://app.ukyi.app", "cross-site", ALLOW).allow).toBe(false);
  });
  it("Sec-Fetch-Site=same-origin + 정확 origin → allow", () => {
    expect(decideCsrf("POST", "https://app.ukyi.app", "same-origin", ALLOW).allow).toBe(true);
  });
});

describe("csrf 미들웨어", () => {
  const app = new Hono();
  app.onError((e, c) => c.body(null, (e as { status?: number }).status === 403 ? 403 : 500));
  app.use("*", csrf(ALLOW));
  app.post("/x", (c) => c.json({ ok: true }));
  app.get("/x", (c) => c.json({ ok: true }));

  it("정확 origin POST → 200", async () => {
    const res = await app.request("/x", {
      method: "POST",
      headers: { origin: "https://app.ukyi.app" },
    });
    expect(res.status).toBe(200);
  });
  it("형제 origin POST → 403", async () => {
    const res = await app.request("/x", {
      method: "POST",
      headers: { origin: "https://evil.ukyi.app" },
    });
    expect(res.status).toBe(403);
  });
  it("Origin 없는 POST → 403", async () => {
    const res = await app.request("/x", { method: "POST" });
    expect(res.status).toBe(403);
  });
  it("GET은 origin 없이도 200", async () => {
    const res = await app.request("/x", { method: "GET" });
    expect(res.status).toBe(200);
  });
});
