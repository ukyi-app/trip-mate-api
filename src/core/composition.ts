import pino from "pino";
import { createDb, type DB } from "../db/client.ts";
import { env } from "./config.ts";

export interface Core {
  db: DB;
  logger: pino.Logger;
  config: typeof env;
  migrateUrl: string; // boot self-migrate 직결 URL
  redisUrl: string; // 세션·FX 캐시 URL
}

export function createCore(): Core {
  // homelab conn 핸들(TRIP_MATE_*). migrate 미설정 시 런타임 URL 폴백.
  const migrateUrl = env.TRIP_MATE_MIGRATE_DATABASE_URL ?? env.TRIP_MATE_DATABASE_URL;
  return {
    db: createDb(env.TRIP_MATE_DATABASE_URL),
    logger: pino(),
    config: env,
    migrateUrl,
    redisUrl: env.TRIP_MATE_REDIS_URL,
  };
}
