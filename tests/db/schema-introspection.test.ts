import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, type Ctx } from "./helpers.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startDb();
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

const CHECKS = [
  "currency_code_len",
  "trip_dates",
  "fx_by_source",
  "refund_self",
  "payment_method_check",
  "category_check",
  "input_source_check",
  "change_type_check",
  "transfer_amount_pos",
  "transfer_distinct",
  "paid_consistency",
  "local_not_tracked",
  "fx_default_rate_pos",
];
const INDEXES = [
  "uq_trip_settlement_ccy",
  "ix_trip_creator",
  "uq_member_email",
  "uq_member_user",
  "uq_one_admin",
  "uq_member_trip_id",
  "uq_invite_token",
  "ix_member_user",
  "ix_exp_trip_spent",
  "ix_exp_paid_by",
  "ix_exp_created_by",
  "ix_exp_settle",
  "uq_expense_trip_id",
  "ix_exp_refund",
  "ix_part_member",
  "ix_audit_expense",
  "ix_audit_trip",
  "uq_settlement_active",
  "uq_settlement_version",
  "uq_settlement_trip_id",
  "ix_settlement_finalizer",
  "uq_transfer_pair",
  "ix_transfer_settlement",
  "ix_transfer_from",
  "ix_transfer_to",
  "uq_summary",
  "ix_summary_settlement",
  "ix_summary_member",
];
// auto-name FK는 정의 부분일치로 검증
const FK_DEFS = [
  "FOREIGN KEY (trip_id, paid_by_member_id) REFERENCES trip_members(trip_id, id)",
  "FOREIGN KEY (trip_id, created_by_member_id) REFERENCES trip_members(trip_id, id)",
  "FOREIGN KEY (trip_id, last_modified_by_member_id) REFERENCES trip_members(trip_id, id)",
  "FOREIGN KEY (trip_id, settlement_currency) REFERENCES trips(id, settlement_currency)",
  "FOREIGN KEY (trip_id, refund_of_expense_id) REFERENCES expenses(trip_id, id)",
  "FOREIGN KEY (trip_id, expense_id) REFERENCES expenses(trip_id, id)",
  "FOREIGN KEY (trip_id, member_id) REFERENCES trip_members(trip_id, id)",
  "FOREIGN KEY (trip_id, changed_by_member_id) REFERENCES trip_members(trip_id, id)",
  "FOREIGN KEY (trip_id, finalized_by_member_id) REFERENCES trip_members(trip_id, id)",
  "FOREIGN KEY (trip_id, settlement_id) REFERENCES settlements(trip_id, id)",
  "FOREIGN KEY (trip_id, from_member_id) REFERENCES trip_members(trip_id, id)",
  "FOREIGN KEY (trip_id, to_member_id) REFERENCES trip_members(trip_id, id)",
  "FOREIGN KEY (trip_id, marked_by_member_id) REFERENCES trip_members(trip_id, id)",
];

describe("schema introspection (SSOT 객체 존재)", () => {
  it("모든 named CHECK 제약 존재", async () => {
    const rows = await ctx.sql`select conname from pg_constraint where contype='c'`;
    const names = new Set(rows.map((r) => r.conname as string));
    for (const c of CHECKS) expect(names, `missing CHECK ${c}`).toContain(c);
  });
  it("모든 named 인덱스 존재", async () => {
    const rows = await ctx.sql`select indexname from pg_indexes where schemaname='public'`;
    const names = new Set(rows.map((r) => r.indexname as string));
    for (const i of INDEXES) expect(names, `missing index ${i}`).toContain(i);
  });
  it("모든 same-trip composite FK 정의 존재", async () => {
    const rows =
      await ctx.sql`select pg_get_constraintdef(oid) as def from pg_constraint where contype='f'`;
    const defs = rows.map((r) => (r.def as string).replace(/"/g, ""));
    for (const fk of FK_DEFS) {
      expect(
        defs.some((d) => d.includes(fk)),
        `missing FK: ${fk}`,
      ).toBe(true);
    }
  });
  it("복합 PK 존재 (expense_participants·settlement_currency_totals)", async () => {
    const rows =
      await ctx.sql`select conrelid::regclass::text as tbl, pg_get_constraintdef(oid) as def from pg_constraint where contype='p'`;
    const find = (t: string) =>
      (
        (rows.find((r) => (r.tbl as string).replace(/^public\./, "") === t)?.def as string) ?? ""
      ).replace(/"/g, "");
    expect(find("expense_participants")).toContain("PRIMARY KEY (expense_id, member_id)");
    expect(find("settlement_currency_totals")).toContain("PRIMARY KEY (settlement_id, currency)");
  });
  it("trip_fx_defaults 복합 PK 존재", async () => {
    const rows =
      await ctx.sql`select conrelid::regclass::text as tbl, pg_get_constraintdef(oid) as def from pg_constraint where contype='p'`;
    const def = (
      (rows.find((r) => (r.tbl as string).replace(/^public\./, "") === "trip_fx_defaults")
        ?.def as string) ?? ""
    ).replace(/"/g, "");
    expect(def).toContain("PRIMARY KEY (trip_id, base_currency, settlement_currency)");
  });
  it("account(provider_id, account_id) 유니크 존재 (이메일 링킹 금지)", async () => {
    const rows =
      await ctx.sql`select indexdef from pg_indexes where schemaname='public' and tablename='account'`;
    const ok = rows.some(
      (r) =>
        /UNIQUE/i.test(r.indexdef as string) &&
        /provider_id/.test(r.indexdef as string) &&
        /account_id/.test(r.indexdef as string),
    );
    expect(ok, "account unique(provider_id, account_id) missing").toBe(true);
  });

  // ── 의미론 검증 (이름만으로는 over-broad 정의가 통과) ──
  it("부분유니크 WHERE 술어 정확 (over-broad UNIQUE 차단)", async () => {
    const rows =
      await ctx.sql`select indexname, indexdef from pg_indexes where schemaname='public'`;
    const def = (n: string) => (rows.find((r) => r.indexname === n)?.indexdef as string) ?? "";
    expect(def("uq_one_admin")).toMatch(
      /WHERE .*role.* = .*'admin'.* AND .*status.* = .*'joined'/s,
    );
    expect(def("uq_settlement_active")).toMatch(/WHERE .*status.* = .*'active'/s);
    expect(def("uq_invite_token")).toMatch(/WHERE .*invite_token_hash.* IS NOT NULL/s);
  });
  it("cascade ON DELETE 정확 — 테이블별 명시", async () => {
    const rows = await ctx.sql`
      select conrelid::regclass::text as child, confrelid::regclass::text as parent, confdeltype
      from pg_constraint where contype='f'`;
    const cascades = rows
      .filter((r) => r.confdeltype === "c")
      .map(
        (r) =>
          `${(r.child as string).replace(/^public\./, "")}->${(r.parent as string).replace(/^public\./, "")}`,
      );
    const required = [
      "trip_members->trips",
      "expenses->trips",
      "expense_audit_logs->trips",
      "settlements->trips",
      "expense_participants->expenses",
      "settlement_currency_totals->settlements",
      "settlement_transfers->settlements",
      "settlement_member_summaries->settlements",
      "trip_fx_defaults->trips",
    ];
    for (const r of required) expect(cascades, `missing ON DELETE CASCADE: ${r}`).toContain(r);
  });
  it("text-enum CHECK 값집합 정확", async () => {
    const rows =
      await ctx.sql`select conname, pg_get_constraintdef(oid) as def from pg_constraint where contype='c'`;
    const def = (n: string) => (rows.find((r) => r.conname === n)?.def as string) ?? "";
    expect(def("payment_method_check")).toMatch(
      /'cash'.*'card'.*'transit_card'.*'easy_pay'.*'other'/s,
    );
    expect(def("category_check")).toMatch(
      /'food'.*'cafe_snack'.*'transport'.*'lodging'.*'shopping'.*'sightseeing'.*'convenience'.*'other'/s,
    );
    expect(def("input_source_check")).toMatch(
      /'manual'.*'ai_oneline'.*'card_sms'.*'receipt'.*'card_capture'/s,
    );
    expect(def("change_type_check")).toMatch(/'create'.*'update'.*'delete'.*'restore'/s);
  });
  it("currencies seed 28통화 + TWD/HUF/IDR minor=0", async () => {
    const rows = await ctx.sql`select code, minor_unit from currencies`;
    expect(rows.length).toBe(28);
    // 정수만 유통(ISO 지수≠실무 minor_unit): 마이그레이션/seed가 minor_unit=0으로 심었는지 검증.
    for (const code of ["TWD", "HUF", "IDR"]) {
      expect(rows.find((r) => r.code === code)?.minor_unit).toBe(0);
    }
  });
});
