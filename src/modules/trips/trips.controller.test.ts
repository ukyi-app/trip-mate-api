import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startDb,
  mkUser,
  mkTrip,
  mkMember,
  mkExpense,
  type Ctx,
} from "../../../tests/db/helpers.ts";
import { createApp } from "../../core/openapi.ts";
import { DrizzleTripRepo } from "./trips.repo.ts";
import { DrizzleMemberRepo } from "../members/members.repo.ts";
import { MembersService } from "../members/members.service.ts";
import { TripsService } from "./trips.service.ts";
import { DrizzleSettlementRepo } from "../settlements/settlements.repo.ts";
import { SettlementsService } from "../settlements/settlements.service.ts";
import { registerTripRoutes } from "./trips.controller.ts";
import { registerErrorFilter } from "../../core/errors.ts";
import type { SessionResolver } from "../../core/guards.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

function appFor(userId: string, email = "a@example.com") {
  const app = createApp(); // 422 defaultHook 상속
  registerErrorFilter(app);
  const tripsService = new TripsService(
    ctx.db,
    new DrizzleTripRepo(ctx.db),
    new MembersService(new DrizzleMemberRepo(ctx.db), { ttlHours: 168 }),
  );
  // 실 netLookup(mock 아님) — settlement축 개인 net 배치 계산.
  const settlements = new SettlementsService(ctx.db, new DrizzleSettlementRepo(ctx.db));
  const resolver: SessionResolver = async () => ({ user: { id: userId } });
  const memberLookup = (tripId: string, uid: string) =>
    new DrizzleMemberRepo(ctx.db).findMembership(tripId, uid);
  registerTripRoutes(app, {
    tripsService,
    resolver,
    emailOf: async () => email,
    nameOf: async () => "테스터",
    memberLookup,
    netLookup: (pairs) => settlements.netsForMemberships(pairs),
  });
  return app;
}
const body = () => ({
  title: "도쿄",
  start_date: "2026-08-01",
  end_date: "2026-08-05",
  destination_countries: ["JP"],
  timezone: "Asia/Tokyo",
  primary_local_currency: "JPY",
  settlement_currency: "KRW",
  admin_display_name: "여행대장",
});
const post = (app: ReturnType<typeof appFor>, b: unknown) =>
  app.request("/trips", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  });

describe("trips 라우트", () => {
  it("POST /trips → 200, GET /trips → 내 trip 1개", async () => {
    const u = await mkUser(ctx.sql);
    const app = appFor(u);
    expect([200, 201]).toContain((await post(app, body())).status);
    const list = await app.request("/trips");
    expect(((await list.json()) as unknown[]).length).toBe(1);
  });
  it("GET /trips/{tripId} 비멤버 → 403", async () => {
    const u1 = await mkUser(ctx.sql);
    const u2 = await mkUser(ctx.sql);
    const created = await post(appFor(u1), body());
    const id = ((await created.json()) as { id: string }).id;
    expect((await appFor(u2).request(`/trips/${id}`)).status).toBe(403);
  });
  it("입력 검증 실패(title 빈값) → 422", async () => {
    const u = await mkUser(ctx.sql);
    expect((await post(appFor(u), { ...body(), title: "" })).status).toBe(422);
  });
  it("멤버 GET·어드민 PATCH happy-path → 200 (finding #1 pass3)", async () => {
    const u = await mkUser(ctx.sql);
    const app = appFor(u);
    const id = ((await (await post(app, body())).json()) as { id: string }).id;
    expect((await app.request(`/trips/${id}`)).status).toBe(200);
    const patched = await app.request(`/trips/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "오사카" }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { title: string }).title).toBe("오사카");
  });
  it("역순 날짜 → 422 (finding #2/3)", async () => {
    const u = await mkUser(ctx.sql);
    expect(
      (await post(appFor(u), { ...body(), start_date: "2026-08-09", end_date: "2026-08-01" }))
        .status,
    ).toBe(422);
  });
  it("잘못된 달력 날짜 → 422 (finding #3 pass5)", async () => {
    const u = await mkUser(ctx.sql);
    expect((await post(appFor(u), { ...body(), start_date: "2026-99-99" })).status).toBe(422);
  });
  it("미지 통화 → 422(DB FK→ValidationError) (finding #2 pass3)", async () => {
    const u = await mkUser(ctx.sql);
    expect((await post(appFor(u), { ...body(), settlement_currency: "XYZ" })).status).toBe(422);
  });
  it("잘못된 timezone → 422 (finding #3 pass5)", async () => {
    const u = await mkUser(ctx.sql);
    expect((await post(appFor(u), { ...body(), timezone: "Mars/Phobos" })).status).toBe(422);
  });

  // ── I-4: my_member_id (detail) + net (list) ──────────────────────────────
  it("(a) GET /trips/{id} → my_member_id = 호출자 멤버십 id, user_id 없음", async () => {
    const u = await mkUser(ctx.sql);
    const app = appFor(u);
    const id = ((await (await post(app, body())).json()) as { id: string }).id;
    const res = await app.request(`/trips/${id}`);
    const json = (await res.json()) as Record<string, unknown>;
    const rows = await ctx.sql<
      { id: string }[]
    >`select id from trip_members where trip_id=${id} and user_id=${u}`;
    expect(json.my_member_id).toBe(rows[0]!.id);
    expect(json).not.toHaveProperty("user_id");
    expect(JSON.stringify(json)).not.toContain("user_id");
  });

  it("(b) GET /trips 목록 아이템: my_member_id/my_role/my_net_amount/net_currency, user_id 없음", async () => {
    const u = await mkUser(ctx.sql);
    const app = appFor(u);
    await post(app, body());
    const list = (await (await app.request("/trips")).json()) as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    const item = list[0]!;
    expect(item.my_member_id).toBeTruthy();
    expect(item.my_role).toBe("admin");
    expect(item.my_net_amount).toBe("0"); // 지출 없음 → "0"
    expect(item.net_currency).toBe("KRW"); // = settlement_currency
    expect(JSON.stringify(list)).not.toContain("user_id");
  });

  it("(c·P-2) 비어있지 않은 trip에서 활동 없는 조인 멤버 → my_net_amount === '0'", async () => {
    const u1 = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u1);
    const admin = await mkMember(ctx.sql, trip, { userId: u1, role: "admin", status: "joined" });
    const u2 = await mkUser(ctx.sql);
    await mkMember(ctx.sql, trip, { userId: u2, role: "member", status: "joined" });
    // 지출은 admin 결제·참여자=admin만 → trip은 비어있지 않으나 u2는 summary 부재.
    const eid = await mkExpense(ctx.sql, trip, admin);
    await ctx.sql`insert into expense_participants (trip_id, expense_id, member_id) values (${trip}, ${eid}, ${admin})`;
    const list = (await (await appFor(u2).request("/trips")).json()) as Record<string, unknown>[];
    const item = list.find((t) => t.id === trip)!;
    expect(item).toBeTruthy();
    expect(item.my_net_amount).toBe("0"); // null 아님(P-2)
    expect(item.net_currency).toBe("KRW");
    expect(item.my_role).toBe("member");
  });

  it("(d) 받을/줄 멤버 → 부호 있는 net (admin +4660 / member -4660)", async () => {
    const u1 = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u1);
    const admin = await mkMember(ctx.sql, trip, { userId: u1, role: "admin", status: "joined" });
    const u2 = await mkUser(ctx.sql);
    const m2 = await mkMember(ctx.sql, trip, { userId: u2, role: "member", status: "joined" });
    const eid = await mkExpense(ctx.sql, trip, admin); // settlement_amount=9320, admin 결제
    await ctx.sql`insert into expense_participants (trip_id, expense_id, member_id) values (${trip}, ${eid}, ${admin}), (${trip}, ${eid}, ${m2})`;
    const adminList = (await (await appFor(u1).request("/trips")).json()) as Record<
      string,
      unknown
    >[];
    expect(adminList.find((t) => t.id === trip)!.my_net_amount).toBe("4660"); // 9320 − 4660
    const m2List = (await (await appFor(u2).request("/trips")).json()) as Record<string, unknown>[];
    expect(m2List.find((t) => t.id === trip)!.my_net_amount).toBe("-4660"); // 0 − 4660
  });

  it("(S-2) 손상 trip → GET /trips에서 my_net_amount === null (정상 형제는 실값 계산)", async () => {
    const u = await mkUser(ctx.sql);
    // 정상 trip: u=admin, m2 참여 → u net = +4660
    const healthy = await mkTrip(ctx.sql, u);
    const hAdmin = await mkMember(ctx.sql, healthy, { userId: u, role: "admin", status: "joined" });
    const u2 = await mkUser(ctx.sql);
    const hm2 = await mkMember(ctx.sql, healthy, { userId: u2, role: "member", status: "joined" });
    const he = await mkExpense(ctx.sql, healthy, hAdmin);
    await ctx.sql`insert into expense_participants (trip_id, expense_id, member_id) values (${healthy}, ${he}, ${hAdmin}), (${healthy}, ${he}, ${hm2})`;
    // 손상 trip: u도 멤버. included 지출인데 참여자 0명 → computeSettlement throw → route가 null 매핑.
    const corrupt = await mkTrip(ctx.sql, u);
    const cAdmin = await mkMember(ctx.sql, corrupt, { userId: u, role: "admin", status: "joined" });
    await mkExpense(ctx.sql, corrupt, cAdmin); // 참여자 row 미삽입 → throw
    const list = (await (await appFor(u).request("/trips")).json()) as Record<string, unknown>[];
    expect(list.find((t) => t.id === healthy)!.my_net_amount).toBe("4660"); // 정상 형제 실값
    expect(list.find((t) => t.id === corrupt)!.my_net_amount).toBeNull(); // 손상만 null(route seam 고정)
  });

  const del = (app: ReturnType<typeof appFor>, id: string) =>
    app.request(`/trips/${id}`, { method: "DELETE" });

  it("어드민 DELETE → 200 {id, deleted:true}, 이후 목록 비어있음", async () => {
    const u = await mkUser(ctx.sql);
    const app = appFor(u);
    const id = ((await (await post(app, body())).json()) as { id: string }).id;
    const res = await del(app, id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, deleted: true });
    expect(((await (await app.request("/trips")).json()) as unknown[]).length).toBe(0);
  });
  it("비멤버 DELETE → 403", async () => {
    const u1 = await mkUser(ctx.sql);
    const u2 = await mkUser(ctx.sql);
    const id = ((await (await post(appFor(u1), body())).json()) as { id: string }).id;
    expect((await del(appFor(u2), id)).status).toBe(403);
  });
  it("일반 멤버 DELETE → 403 (admin 가드)", async () => {
    const u1 = await mkUser(ctx.sql);
    const u2 = await mkUser(ctx.sql);
    const id = ((await (await post(appFor(u1), body())).json()) as { id: string }).id;
    await mkMember(ctx.sql, id, { userId: u2, role: "member", status: "joined" });
    expect((await del(appFor(u2), id)).status).toBe(403);
  });
  it("삭제 성공 후 같은 admin 재시도 → 403 (멤버십 cascade 제거로 admin 가드 우선, 404 아님)", async () => {
    const u = await mkUser(ctx.sql);
    const app = appFor(u);
    const id = ((await (await post(app, body())).json()) as { id: string }).id;
    expect((await del(app, id)).status).toBe(200);
    // 재시도: 삭제로 admin 멤버십이 cascade 제거됨 → requireTripMember(admin)가 먼저 403(deleteTrip이 404 낼 기회 없음).
    // 무가드·멱등 미적용 결정 하에서 이 403이 불가역 삭제의 수용된 재시도 계약이다(F1 반영).
    expect((await del(app, id)).status).toBe(403);
  });
});
