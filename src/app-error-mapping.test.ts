import { describe, it, expect } from "vitest";
import { createApp } from "./core/openapi.ts";
import { UnavailableError, registerErrorFilter } from "./core/errors.ts";
import { buildV1App } from "./app.ts";

// main.ts 합성 회귀: 루트 createApp + registerErrorFilter + app.route("/", v1).
// 마운트 시 에러는 루트 onError로 전파되므로 루트에도 필터가 있어야 problem+json(없으면 500).
function rootWithV1() {
  const app = createApp();
  registerErrorFilter(app);
  const v1 = buildV1App({
    tripsService: {} as never,
    membersService: {} as never,
    expensesService: {} as never,
    settlementsService: {} as never,
    tripDefaults: {} as never,
    resolver: async () => null, // 세션 없음 → requireAuth ForbiddenError(403)
    emailOf: async () => "",
    nameOf: async () => "",
    memberLookup: async () => null,
    idempotencyStore: null,
    expenseDrafts: {} as never,
    webOrigins: ["http://localhost:5173"],
  });
  app.route("/", v1);
  return app;
}

describe("루트 앱 에러 매핑(main.ts 합성)", () => {
  it("마운트된 v1 무인증 GET → 403 problem+json(500 아님)", async () => {
    const res = await rootWithV1().request("/v1/trips");
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });
  it("unsafe 메서드 무-Origin → CSRF 403", async () => {
    const res = await rootWithV1().request(
      "/v1/trips/11111111-1111-4111-8111-111111111111/expenses",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(res.status).toBe(403);
  });
  it("미존재 경로 → 404(루트 라우팅)", async () => {
    expect((await rootWithV1().request("/v1/nope")).status).toBe(404);
  });
});

describe("AppError meta.retryAfterSeconds → Retry-After 헤더", () => {
  function appThrowing(err: Error) {
    const app = createApp();
    registerErrorFilter(app);
    app.get("/boom", () => {
      throw err;
    });
    return app;
  }
  it("meta.retryAfterSeconds 있으면 Retry-After 세팅", async () => {
    const res = await appThrowing(new UnavailableError("busy", { retryAfterSeconds: 5 })).request(
      "/boom",
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
  });
  it("meta 없으면 Retry-After 미설정", async () => {
    const res = await appThrowing(new UnavailableError("off")).request("/boom");
    expect(res.headers.get("Retry-After")).toBe(null);
  });
});
