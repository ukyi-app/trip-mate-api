import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, type Ctx } from "../../../tests/db/helpers.ts";
import { createApp } from "../../core/openapi.ts";
import { registerErrorFilter } from "../../core/errors.ts";
import { DrizzleCurrencyRepo } from "./currencies.repo.ts";
import { CurrenciesService } from "./currencies.service.ts";
import { registerCurrencyRoutes } from "./currencies.controller.ts";
import type { SessionResolver } from "../../core/guards.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

// userId 있으면 인증, null이면 미인증(resolver null → 403).
function appFor(userId: string | null) {
  const app = createApp();
  registerErrorFilter(app);
  const service = new CurrenciesService(new DrizzleCurrencyRepo(ctx.db));
  const resolver: SessionResolver = async () => (userId ? { user: { id: userId } } : null);
  registerCurrencyRoutes(app, { service, resolver });
  return app;
}

type CurrencyDto = { code: string; minor_unit: number; symbol: string };

describe("currencies 라우트", () => {
  it("(a) 인증 GET /currencies → 200, 배열 반환", async () => {
    const u = await mkUser(ctx.sql);
    const res = await appFor(u).request("/currencies");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(Array.isArray(body)).toBe(true);
    expect((body as unknown[]).length).toBeGreaterThan(0); // 행 COUNT은 단언하지 않음(seed 증가 가능)
  });

  it("(b) 알려진 코드 minor_unit 정확 — KRW→0, USD→2, TWD→0(iso=2지만 minor=0)", async () => {
    const u = await mkUser(ctx.sql);
    const body = (await (await appFor(u).request("/currencies")).json()) as CurrencyDto[];
    const by = (code: string) => body.find((c) => c.code === code);
    expect(by("KRW")?.minor_unit).toBe(0);
    expect(by("USD")?.minor_unit).toBe(2);
    expect(by("TWD")?.minor_unit).toBe(0);
  });

  it("(c) 각 항목은 정확히 {code, minor_unit, symbol} — iso_exponent 키 없음", async () => {
    const u = await mkUser(ctx.sql);
    const body = (await (await appFor(u).request("/currencies")).json()) as Record<
      string,
      unknown
    >[];
    for (const item of body) {
      expect(Object.keys(item).sort()).toEqual(["code", "minor_unit", "symbol"]);
      expect(item).not.toHaveProperty("iso_exponent");
    }
  });

  it("(d) 미인증(resolver null) → 403", async () => {
    const res = await appFor(null).request("/currencies");
    expect(res.status).toBe(403);
  });

  it("(e) Cache-Control 응답 헤더 설정", async () => {
    const u = await mkUser(ctx.sql);
    const res = await appFor(u).request("/currencies");
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
  });
});
