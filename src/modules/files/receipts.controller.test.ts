import { describe, it, expect } from "vitest";
import { createApp } from "../../core/openapi.ts";
import { registerErrorFilter } from "../../core/errors.ts";
import { registerReceiptRoutes } from "./receipts.controller.ts";
import type { ReceiptsPort } from "./receipts.service.ts";
import type { SessionResolver, MembershipLookup } from "../../core/guards.ts";

function appWith(service: ReceiptsPort, opts: { member?: boolean } = {}) {
  const app = createApp();
  registerErrorFilter(app);
  const resolver: SessionResolver = async () => ({ user: { id: "u1" } });
  const memberLookup: MembershipLookup = async () =>
    opts.member === false ? null : { id: "m1", role: "member", status: "joined" };
  registerReceiptRoutes(app, { service, resolver, memberLookup });
  return app;
}
const svc = (over: Partial<ReceiptsPort> = {}): ReceiptsPort => ({
  attach: async () => ({ objectKey: "receipts/t/e/x" }),
  get: async () => ({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" }),
  remove: async () => {},
  ...over,
});

describe("receipts 라우트", () => {
  it("POST 업로드 → 201 + attach(바이트 수·Content-Type)", async () => {
    const calls: { t: string; e: string; n: number; ct: string }[] = [];
    const app = appWith(
      svc({
        attach: async (t, e, b, ct) => {
          calls.push({ t, e, n: b.byteLength, ct });
          return { objectKey: "k" };
        },
      }),
    );
    const res = await app.request("/trips/t1/expenses/e1/receipt", {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(res.status).toBe(201);
    expect(calls[0]).toMatchObject({ t: "t1", e: "e1", n: 4, ct: "image/jpeg" });
  });
  it("POST 허용 안 된 Content-Type(text/html) → 415 (XSS 방어)", async () => {
    const res = await appWith(svc()).request("/trips/t1/expenses/e1/receipt", {
      method: "POST",
      headers: { "content-type": "text/html" },
      body: new Uint8Array([1, 2]),
    });
    expect(res.status).toBe(415);
  });
  it("POST charset 파라미터 붙은 image/png → 201(허용)", async () => {
    const res = await appWith(svc()).request("/trips/t1/expenses/e1/receipt", {
      method: "POST",
      headers: { "content-type": "image/png; charset=binary" },
      body: new Uint8Array([1, 2]),
    });
    expect(res.status).toBe(201);
  });
  it("GET 응답 하드닝 헤더(attachment·nosniff·CSP sandbox)", async () => {
    const res = await appWith(svc()).request("/trips/t1/expenses/e1/receipt");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });
  it("POST 빈 바디 → 422", async () => {
    const res = await appWith(svc()).request("/trips/t1/expenses/e1/receipt", {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: new Uint8Array([]),
    });
    expect(res.status).toBe(422);
  });
  it("GET → 200 + Content-Type", async () => {
    const res = await appWith(svc()).request("/trips/t1/expenses/e1/receipt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
  });
  it("DELETE → 204", async () => {
    const res = await appWith(svc()).request("/trips/t1/expenses/e1/receipt", { method: "DELETE" });
    expect(res.status).toBe(204);
  });
  it("비-멤버 → 403", async () => {
    const res = await appWith(svc(), { member: false }).request("/trips/t1/expenses/e1/receipt", {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(403);
  });
});
