import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { seedCurrencies } from "./currencies.ts";
import { env } from "../../core/config.ts";

// CLI 엔트리(bun src/db/seed/run.ts). 클라이언트 소유 + finally 종료 → 프로세스 행 방지(plan finding #3).
const sql = postgres(env.TRIP_MATE_DATABASE_URL);
try {
  await seedCurrencies(drizzle(sql, { casing: "snake_case" }));
} finally {
  await sql.end();
}
