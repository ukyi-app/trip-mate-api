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
});
