import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import * as schema from "../../src/db/schema/index.ts";
import { seedCurrencies } from "../../src/db/seed/currencies.ts";

type SQL = ReturnType<typeof postgres>;
export interface Ctx {
  container: StartedPostgreSqlContainer;
  sql: SQL;
  db: PostgresJsDatabase<typeof schema>;
}

export async function startDb(): Promise<Ctx> {
  const container = await new PostgreSqlContainer("postgres:16").start();
  const sql = postgres(container.getConnectionUri());
  const db = drizzle(sql, { schema, casing: "snake_case" });
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  await seedCurrencies(db);
  return { container, sql, db };
}

// ── 빌더 (각 호출 고유 id → per-test 격리) ──────────────────────────────
export async function mkUser(sql: SQL): Promise<string> {
  const id = randomUUID();
  await sql`insert into "user" (id, name, email, email_verified) values (${id}, 'U', ${`${id}@e.com`}, true)`;
  return id;
}

export async function mkTrip(
  sql: SQL,
  userId: string,
  settlementCurrency = "KRW",
): Promise<string> {
  const id = randomUUID();
  await sql`insert into trips (id, title, start_date, end_date, destination_countries, timezone, primary_local_currency, settlement_currency, created_by_user_id)
    values (${id}, 'T', '2026-01-01', '2026-01-05', ARRAY['JP']::text[], 'Asia/Seoul', 'KRW', ${settlementCurrency}, ${userId})`;
  return id;
}

export async function mkMember(
  sql: SQL,
  tripId: string,
  opts: {
    userId?: string | null;
    role?: string;
    status?: string;
    email?: string;
    tokenHash?: string | null;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const email = opts.email ?? `${id}@e.com`;
  await sql`insert into trip_members (id, trip_id, user_id, invited_email, normalized_invited_email, display_name, role, status, invite_token_hash)
    values (${id}, ${tripId}, ${opts.userId ?? null}, ${email}, ${email}, 'M', ${opts.role ?? "member"}, ${opts.status ?? "invited"}, ${opts.tokenHash ?? null})`;
  return id;
}

interface ExpenseOpts {
  id?: string;
  settlementCurrency?: string;
  source?: "converted" | "card_billed";
  rate?: string | null;
  rateSource?: string | null;
  paymentMethod?: string;
  refundOf?: string | null;
}
export async function mkExpense(
  sql: SQL,
  tripId: string,
  memberId: string,
  o: ExpenseOpts = {},
): Promise<string> {
  const id = o.id ?? randomUUID();
  const source = o.source ?? "converted";
  const rate = o.rate !== undefined ? o.rate : source === "converted" ? "9.32" : null;
  const rateSource =
    o.rateSource !== undefined ? o.rateSource : source === "converted" ? "auto" : null;
  await sql`insert into expenses (id, trip_id, title, local_amount, local_currency, settlement_amount, settlement_currency,
      exchange_rate, exchange_rate_date, exchange_rate_source, settlement_amount_source,
      payment_method, category, input_source, expense_settlement_state,
      paid_by_member_id, created_by_member_id, spent_at, refund_of_expense_id, version)
    values (${id}, ${tripId}, 'E', 1000, 'JPY', 9320, ${o.settlementCurrency ?? "KRW"},
      ${rate}, '2026-01-01', ${rateSource}, ${source},
      ${o.paymentMethod ?? "cash"}, 'food', 'manual', 'included',
      ${memberId}, ${memberId}, '2026-01-02T00:00:00Z', ${o.refundOf ?? null}, 0)`;
  return id;
}

export async function mkSettlement(
  sql: SQL,
  tripId: string,
  memberId: string,
  opts: { version?: number; status?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await sql`insert into settlements (id, trip_id, version, status, finalized_by_member_id, finalized_at, total_settlement_amount)
    values (${id}, ${tripId}, ${opts.version ?? 1}, ${opts.status ?? "active"}, ${memberId}, now(), 0)`;
  return id;
}

// ── 위반 주입 (각자 유효 fixture 생성 후 단일 위반만) ───────────────────
export async function insertSecondActiveAdmin(ctx: Ctx) {
  const u1 = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, u1);
  await mkMember(ctx.sql, trip, { userId: u1, role: "admin", status: "joined" });
  const u2 = await mkUser(ctx.sql);
  await mkMember(ctx.sql, trip, { userId: u2, role: "admin", status: "joined" }); // 2번째 active admin → uq_one_admin
}

export async function insertCrossTripExpense(ctx: Ctx) {
  const uA = await mkUser(ctx.sql);
  const tripA = await mkTrip(ctx.sql, uA);
  const uB = await mkUser(ctx.sql);
  const tripB = await mkTrip(ctx.sql, uB);
  const memberB = await mkMember(ctx.sql, tripB, { userId: uB, role: "admin", status: "joined" });
  await mkExpense(ctx.sql, tripA, memberB); // tripA 지출인데 결제자=tripB 멤버 → composite FK 23503
}

export async function insertConvertedWithoutRate(ctx: Ctx) {
  const u = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, u);
  const m = await mkMember(ctx.sql, trip, { userId: u, role: "admin", status: "joined" });
  await mkExpense(ctx.sql, trip, m, { source: "converted", rate: null, rateSource: null }); // fx_by_source
}

export async function insertCardBilledWithSource(ctx: Ctx) {
  const u = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, u);
  const m = await mkMember(ctx.sql, trip, { userId: u, role: "admin", status: "joined" });
  await mkExpense(ctx.sql, trip, m, { source: "card_billed", rate: null, rateSource: "auto" }); // fx_by_source
}

export async function insertValidEnumExpense(ctx: Ctx): Promise<string> {
  const u = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, u);
  const m = await mkMember(ctx.sql, trip, { userId: u, role: "admin", status: "joined" });
  return mkExpense(ctx.sql, trip, m, { paymentMethod: "easy_pay" }); // 유효 enum → 성공
}

export async function insertInvalidPaymentMethod(ctx: Ctx) {
  const u = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, u);
  const m = await mkMember(ctx.sql, trip, { userId: u, role: "admin", status: "joined" });
  await mkExpense(ctx.sql, trip, m, { paymentMethod: "bogus" }); // payment_method_check
}

export async function insertSelfRefund(ctx: Ctx) {
  const u = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, u);
  const m = await mkMember(ctx.sql, trip, { userId: u, role: "admin", status: "joined" });
  const id = randomUUID();
  await mkExpense(ctx.sql, trip, m, { id, refundOf: id }); // refund_of == id → refund_self
}

export async function insertCrossTripRefund(ctx: Ctx) {
  const uA = await mkUser(ctx.sql);
  const tripA = await mkTrip(ctx.sql, uA);
  const mA = await mkMember(ctx.sql, tripA, { userId: uA, role: "admin", status: "joined" });
  const uB = await mkUser(ctx.sql);
  const tripB = await mkTrip(ctx.sql, uB);
  const mB = await mkMember(ctx.sql, tripB, { userId: uB, role: "admin", status: "joined" });
  const expB = await mkExpense(ctx.sql, tripB, mB);
  await mkExpense(ctx.sql, tripA, mA, { refundOf: expB }); // tripA 지출이 tripB 지출 환불 → composite FK 23503
}

export async function insertDuplicateInvite(ctx: Ctx) {
  const u = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, u);
  await mkMember(ctx.sql, trip, { email: "dup@e.com" });
  await mkMember(ctx.sql, trip, { email: "dup@e.com" }); // 같은 trip 동일 정규화 이메일 → uq_member_email
}

export async function insertDuplicateInviteToken(ctx: Ctx) {
  const u = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, u);
  await mkMember(ctx.sql, trip, { tokenHash: "samehash" });
  await mkMember(ctx.sql, trip, { tokenHash: "samehash" }); // 같은 해시 2 pending → uq_invite_token
}

export async function insertCurrencyDriftExpense(ctx: Ctx) {
  const u = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, u, "KRW"); // trip 정산통화=KRW
  const m = await mkMember(ctx.sql, trip, { userId: u, role: "admin", status: "joined" });
  await mkExpense(ctx.sql, trip, m, { settlementCurrency: "USD" }); // != trip → composite FK→trips 23503
}

export async function insertDuplicateParticipant(ctx: Ctx) {
  const u = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, u);
  const m = await mkMember(ctx.sql, trip, { userId: u, role: "admin", status: "joined" });
  const exp = await mkExpense(ctx.sql, trip, m);
  await ctx.sql`insert into expense_participants (trip_id, expense_id, member_id) values (${trip}, ${exp}, ${m})`;
  await ctx.sql`insert into expense_participants (trip_id, expense_id, member_id) values (${trip}, ${exp}, ${m})`; // 중복 PK
}

export async function insertSecondActiveSnapshot(ctx: Ctx) {
  const u = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, u);
  const m = await mkMember(ctx.sql, trip, { userId: u, role: "admin", status: "joined" });
  await mkSettlement(ctx.sql, trip, m, { version: 1, status: "active" });
  await mkSettlement(ctx.sql, trip, m, { version: 2, status: "active" }); // 2번째 active → uq_settlement_active
}

async function transferBase(ctx: Ctx) {
  const u = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, u);
  const m1 = await mkMember(ctx.sql, trip, { userId: u, role: "admin", status: "joined" });
  const m2 = await mkMember(ctx.sql, trip, { email: "m2@e.com" });
  const settlement = await mkSettlement(ctx.sql, trip, m1);
  return { trip, m1, m2, settlement };
}

export async function insertTransferNonPositive(ctx: Ctx) {
  const { trip, m1, m2, settlement } = await transferBase(ctx);
  await ctx.sql`insert into settlement_transfers (id, settlement_id, trip_id, basis, currency, from_member_id, to_member_id, amount)
    values (${randomUUID()}, ${settlement}, ${trip}, 'settlement', 'KRW', ${m2}, ${m1}, 0)`; // amount<=0 → transfer_amount_pos
}

export async function insertTransferSelf(ctx: Ctx) {
  const { trip, m1, settlement } = await transferBase(ctx);
  await ctx.sql`insert into settlement_transfers (id, settlement_id, trip_id, basis, currency, from_member_id, to_member_id, amount)
    values (${randomUUID()}, ${settlement}, ${trip}, 'settlement', 'KRW', ${m1}, ${m1}, 100)`; // from==to → transfer_distinct
}

export async function insertTransferPaidHalfState(ctx: Ctx) {
  const { trip, m1, m2, settlement } = await transferBase(ctx);
  await ctx.sql`insert into settlement_transfers (id, settlement_id, trip_id, basis, currency, from_member_id, to_member_id, amount, payment_status)
    values (${randomUUID()}, ${settlement}, ${trip}, 'settlement', 'KRW', ${m2}, ${m1}, 100, 'paid')`; // paid인데 paid_at null → paid_consistency
}

export async function insertPaidLocalTransfer(ctx: Ctx) {
  const { trip, m1, m2, settlement } = await transferBase(ctx);
  await ctx.sql`insert into settlement_transfers (id, settlement_id, trip_id, basis, currency, from_member_id, to_member_id, amount, payment_status, paid_at, marked_by_member_id)
    values (${randomUUID()}, ${settlement}, ${trip}, 'local', 'KRW', ${m2}, ${m1}, 100, 'paid', now(), ${m1})`; // basis=local인데 paid → local_not_tracked
}
