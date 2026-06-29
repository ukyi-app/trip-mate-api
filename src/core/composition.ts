import pino from "pino";
import { createDb, type DB } from "../db/client.ts";
import { env } from "./config.ts";

export interface Core {
  db: DB;
  logger: pino.Logger;
  config: typeof env;
}

export function createCore(): Core {
  return { db: createDb(env.DATABASE_URL), logger: pino(), config: env };
}
