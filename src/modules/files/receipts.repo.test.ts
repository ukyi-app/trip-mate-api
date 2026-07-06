import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  startDb,
  mkUser,
  mkTrip,
  mkMember,
  mkExpense,
  type Ctx,
} from "../../../tests/db/helpers.ts";
import { DrizzleReceiptRepo } from "./receipts.repo.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

describe("DrizzleReceiptRepo", () => {
  it("set/get/clear round-trip", async () => {
    const u = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const m = await mkMember(ctx.sql, trip, { userId: u, role: "admin", status: "joined" });
    const exp = await mkExpense(ctx.sql, trip, m);
    const repo = new DrizzleReceiptRepo(ctx.db);
    expect(await repo.getReceiptKey(trip, exp)).toBeNull(); // 영수증 없음
    expect(await repo.setReceiptKey(trip, exp, "receipts/x/y/z")).toBe(true);
    expect(await repo.getReceiptKey(trip, exp)).toBe("receipts/x/y/z");
    await repo.clearReceiptKey(trip, exp);
    expect(await repo.getReceiptKey(trip, exp)).toBeNull();
  });
  it("expense 없음 → getReceiptKey undefined · setReceiptKey false", async () => {
    const repo = new DrizzleReceiptRepo(ctx.db);
    expect(await repo.getReceiptKey(randomUUID(), randomUUID())).toBeUndefined();
    expect(await repo.setReceiptKey(randomUUID(), randomUUID(), "k")).toBe(false);
  });
  it("trip 스코핑 — 다른 trip의 expenseId면 undefined(교차 접근 차단)", async () => {
    const u = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const other = await mkTrip(ctx.sql, u);
    const m = await mkMember(ctx.sql, trip, { userId: u, role: "admin", status: "joined" });
    const exp = await mkExpense(ctx.sql, trip, m);
    const repo = new DrizzleReceiptRepo(ctx.db);
    expect(await repo.getReceiptKey(other, exp)).toBeUndefined(); // trip 불일치 → 없음
  });
});
