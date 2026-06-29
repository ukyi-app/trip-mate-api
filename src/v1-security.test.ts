import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, type Ctx } from "../tests/db/helpers.ts";
import { DrizzleTripRepo } from "./modules/trips/trips.repo.ts";
import { DrizzleMemberRepo } from "./modules/members/members.repo.ts";
import { TripsService } from "./modules/trips/trips.service.ts";
import { MembersService } from "./modules/members/members.service.ts";
import { buildV1App } from "./app.ts";
import type { SessionResolver } from "./core/guards.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

const ORIGIN = "https://app.ukyi.app";
function v1For(userId: string) {
  const members = new MembersService(new DrizzleMemberRepo(ctx.db), { ttlHours: 168 });
  const trips = new TripsService(ctx.db, new DrizzleTripRepo(ctx.db), members);
  const resolver: SessionResolver = async () => ({ user: { id: userId } });
  return buildV1App({
    tripsService: trips,
    membersService: members,
    expensesService: {} as never, // 본 테스트는 trips mutation만 검증 → expenses 핸들러 미실행
    settlementsService: {} as never,
    resolver,
    emailOf: async () => "a@example.com",
    memberLookup: (t, u) => new DrizzleMemberRepo(ctx.db).findMembership(t, u),
    idempotencyStore: null,
    webOrigins: [ORIGIN],
  });
}
const body = () => ({
  title: "도쿄",
  start_date: "2026-08-01",
  end_date: "2026-08-05",
  destination_countries: ["JP"],
  timezone: "Asia/Tokyo",
  primary_local_currency: "JPY",
  settlement_currency: "KRW",
});

describe("buildV1App 보안 체인(CSRF·CORS, finding #2 pass4)", () => {
  it("정확 Origin mutation → 200 + ACAO/ACAC", async () => {
    const u = await mkUser(ctx.sql);
    const res = await v1For(u).request("/v1/trips", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(body()),
    });
    expect([200, 201]).toContain(res.status);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
  it("형제 Origin mutation → 403(CSRF)", async () => {
    const u = await mkUser(ctx.sql);
    const res = await v1For(u).request("/v1/trips", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.ukyi.app" },
      body: JSON.stringify(body()),
    });
    expect(res.status).toBe(403);
  });
  it("Origin 누락 mutation → 403", async () => {
    const u = await mkUser(ctx.sql);
    const res = await v1For(u).request("/v1/trips", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body()),
    });
    expect(res.status).toBe(403);
  });
  it("OPTIONS preflight 정확 Origin → ACAO", async () => {
    const u = await mkUser(ctx.sql);
    const res = await v1For(u).request("/v1/trips", {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "POST" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });
  it("OPTIONS preflight가 Idempotency-Key 헤더 허용(finding #5 pass1)", async () => {
    const u = await mkUser(ctx.sql);
    const res = await v1For(u).request("/v1/trips/00000000-0000-4000-8000-000000000000/expenses", {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "idempotency-key",
      },
    });
    expect((res.headers.get("access-control-allow-headers") ?? "").toLowerCase()).toContain(
      "idempotency-key",
    );
  });
});
