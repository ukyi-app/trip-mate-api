import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startDb,
  type Ctx,
  insertSecondActiveAdmin,
  insertCrossTripExpense,
  insertConvertedWithoutRate,
  insertCardBilledWithSource,
  insertValidEnumExpense,
  insertInvalidPaymentMethod,
  insertSelfRefund,
  insertCrossTripRefund,
  insertDuplicateInvite,
  insertDuplicateInviteToken,
  insertCurrencyDriftExpense,
  insertDuplicateParticipant,
  insertSecondActiveSnapshot,
  insertTransferNonPositive,
  insertTransferSelf,
  insertTransferPaidHalfState,
  insertPaidLocalTransfer,
  insertDuplicateFxDefault,
  insertFxDefaultBadCurrency,
  insertFxDefaultNonPositiveRate,
} from "./helpers.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

// 강한 단언: "옳은 이유로 실패"를 증명. postgres.js 에러는 e.code(SQLSTATE)·e.constraint_name 제공.
// SQLSTATE: 23503 FK · 23505 unique · 23514 check · 23502 not-null.
async function expectViolation(fn: () => Promise<unknown>, code: string, constraint?: string) {
  try {
    await fn();
  } catch (e) {
    const err = e as { code?: string; constraint_name?: string };
    expect(err.code, "SQLSTATE").toBe(code);
    if (constraint) expect(err.constraint_name).toBe(constraint);
    return;
  }
  throw new Error("expected a DB violation but the insert succeeded");
}

describe("DB 제약 (negative — 단일 위반만 주입, 유효 fixture 먼저, 고유 id 격리)", () => {
  it("positive: 유효 enum 값 expense insert 성공 (값집합 허용 실증)", async () => {
    await expect(insertValidEnumExpense(ctx)).resolves.toBeDefined();
  });

  it("uq_one_admin: 두 번째 active admin 거부", () =>
    expectViolation(() => insertSecondActiveAdmin(ctx), "23505", "uq_one_admin"));
  it("cross-trip paid_by FK: 다른 trip 멤버 결제자 거부", () =>
    expectViolation(() => insertCrossTripExpense(ctx), "23503"));
  it("fx_by_source: converted인데 rate NULL 거부", () =>
    expectViolation(() => insertConvertedWithoutRate(ctx), "23514", "fx_by_source"));
  it("fx_by_source: card_billed인데 source 있음 거부", () =>
    expectViolation(() => insertCardBilledWithSource(ctx), "23514", "fx_by_source"));
  it("transfer amount<=0 거부", () =>
    expectViolation(() => insertTransferNonPositive(ctx), "23514", "transfer_amount_pos"));
  it("transfer from==to 거부", () =>
    expectViolation(() => insertTransferSelf(ctx), "23514", "transfer_distinct"));
  it("transfer paid half-state 거부", () =>
    expectViolation(() => insertTransferPaidHalfState(ctx), "23514", "paid_consistency"));
  it("local_not_tracked: basis=local인데 paid 거부", () =>
    expectViolation(() => insertPaidLocalTransfer(ctx), "23514", "local_not_tracked"));
  it("uq_member_email: 중복 초대 거부", () =>
    expectViolation(() => insertDuplicateInvite(ctx), "23505", "uq_member_email"));
  it("refund_self 거부", () =>
    expectViolation(() => insertSelfRefund(ctx), "23514", "refund_self"));
  it("cross-trip refund FK 거부", () => expectViolation(() => insertCrossTripRefund(ctx), "23503"));
  it("uq_settlement_active: 두 번째 active 스냅샷 거부", () =>
    expectViolation(() => insertSecondActiveSnapshot(ctx), "23505", "uq_settlement_active"));
  it("settlement_currency drift 거부 (composite FK→trips)", () =>
    expectViolation(() => insertCurrencyDriftExpense(ctx), "23503"));
  it("expense_participants 복합 PK: 중복 참여자 거부", () =>
    expectViolation(() => insertDuplicateParticipant(ctx), "23505"));
  it("uq_invite_token: 같은 해시 2개 pending 거부", () =>
    expectViolation(() => insertDuplicateInviteToken(ctx), "23505", "uq_invite_token"));
  it("invalid payment_method 값 거부", () =>
    expectViolation(() => insertInvalidPaymentMethod(ctx), "23514", "payment_method_check"));
  it("trip_fx_defaults 복합 PK 중복 거부", () =>
    expectViolation(() => insertDuplicateFxDefault(ctx), "23505"));
  it("trip_fx_defaults 잘못된 통화 FK 거부", () =>
    expectViolation(() => insertFxDefaultBadCurrency(ctx), "23503"));
  it("trip_fx_defaults rate<=0 거부", () =>
    expectViolation(() => insertFxDefaultNonPositiveRate(ctx), "23514", "fx_default_rate_pos"));
});
