import { describe, it, expect } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { runMigrations } from "./migrate.ts";

describe("runMigrations (boot self-migrate)", () => {
  it("빈 DB에 전체 마이그레이션 적용 + 2회차 멱등", async () => {
    const c = await new PostgreSqlContainer("postgres:16").start();
    const url = c.getConnectionUri();
    try {
      await runMigrations(url);
      await runMigrations(url); // 멱등 — 이미 적용분 skip, 에러 없음
      const sql = postgres(url);
      const t = await sql<{ e: string | null; i: string | null; s: string | null }[]>`
        select to_regclass('public.expenses') as e,
               to_regclass('public.idempotency_keys') as i,
               to_regclass('public.settlement_transfer_events') as s`;
      expect(t[0]!.e).toBe("expenses");
      expect(t[0]!.i).toBe("idempotency_keys");
      expect(t[0]!.s).toBe("settlement_transfer_events");
      await sql.end();
    } finally {
      await c.stop();
    }
  }, 120_000);

  // R-1 회귀: 프로덕션 부팅은 runMigrations만 실행하고 seedCurrencies는 호출하지 않는다.
  // 원본 9통화도 마이그레이션이 아니라 수동 db:seed CLI로만 투입됐으므로, 마이그레이션만으로 만들어진
  // 신규/DR/재빌드 DB는 0008 데이터 마이그레이션에서 28종(원본 9 + 신규 19) 전부를 얻어야 한다.
  // (28행 테스트는 harness가 migrate 후 seed까지 돌려 마스킹됐다 — 여기선 seed 없이 검증.)
  it("migrate-only(seedCurrencies 없이) → currencies 28행 완비", async () => {
    const c = await new PostgreSqlContainer("postgres:16").start();
    const url = c.getConnectionUri();
    try {
      await runMigrations(url); // ← migrate()만 실행, seedCurrencies 호출하지 않음
      const sql = postgres(url);
      const rows = await sql<{ code: string }[]>`select code from currencies`;
      await sql.end();
      const codes = new Set(rows.map((r) => r.code));
      expect(rows.length).toBe(28);
      expect(codes.has("KRW")).toBe(true); // 원본 9 중 하나(마이그레이션이 안 심었으면 누락됐을 코드)
      expect(codes.has("SGD")).toBe(true); // 신규 19 중 하나
    } finally {
      await c.stop();
    }
  }, 120_000);
});
