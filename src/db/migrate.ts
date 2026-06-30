import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// 부팅 시 self-migrate(homelab app-config 계약 — 차트에 마이그레이션 Job 없음).
// 직결 URL(TRIP_MATE_MIGRATE_DATABASE_URL) 권장 — pgbouncer 풀러는 DDL 세션 시맨틱 비호환.
// drizzle-orm 런타임 마이그레이터(drizzle-kit 불필요 → --production 이미지에서 동작). 멱등.
export async function runMigrations(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 }); // 단일 커넥션
  try {
    await migrate(drizzle(sql), { migrationsFolder: "./src/db/migrations" });
  } finally {
    await sql.end();
  }
}
