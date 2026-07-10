import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { currencies } from "../../db/schema/currencies.ts";

/** 공개 통화 참조 행(노출 필드만). iso_exponent는 SELECT하지 않는다 — minor_unit이 SSOT. */
export interface CurrencyRow {
  code: string;
  minor_unit: number;
  symbol: string;
}

export interface CurrencyRepo {
  listAll(): Promise<CurrencyRow[]>;
}

export class DrizzleCurrencyRepo<T extends Record<string, unknown>> implements CurrencyRepo {
  constructor(private readonly db: PostgresJsDatabase<T>) {}

  /** 전 통화 조회 — code 오름차순(결정적·캐시 가능 출력). iso_exponent는 SELECT에서 제외(노출 금지). */
  async listAll(): Promise<CurrencyRow[]> {
    return this.db
      .select({
        code: currencies.code,
        minor_unit: currencies.minor_unit,
        symbol: currencies.symbol,
      })
      .from(currencies)
      .orderBy(currencies.code);
  }
}
