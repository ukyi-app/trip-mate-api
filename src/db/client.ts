import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";

export function createDb(url: string) {
  const sql = postgres(url);
  return drizzle(sql, { schema, casing: "snake_case" });
}
export type DB = ReturnType<typeof createDb>;
