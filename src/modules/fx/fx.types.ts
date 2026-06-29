import type Decimal from "decimal.js";
import type { CurrencyCode, Minor } from "../../core/money.ts";

/** USD 기준 전 통화 환율(1 USD = N currency). usd['USD']=1. */
export type UsdTable = Record<string, Decimal>;

export interface CacheEntry {
  table: UsdTable;
  provider: string; // 'oxr' | 'currencyapi'
  tableDate: string; // 'YYYY-MM-DD' — 이 테이블이 나온 일자
  fetchedAt: string; // ISO timestamp
}

export interface FxProvider {
  readonly name: string;
  getUsdTable(date: string): Promise<UsdTable | null>; // 검증 실패/장애 시 null
}

export interface CachePort {
  getUsdTable(date: string): Promise<CacheEntry | null>;
  setUsdTable(date: string, entry: CacheEntry, ttlSeconds: number): Promise<void>;
  getLastKnown(): Promise<CacheEntry | null>;
  setLastKnown(entry: CacheEntry): Promise<void>;
}

export interface TripDefaultsPort {
  getRate(tripId: string, base: string, settlement: string): Promise<string | null>;
  upsertRate(tripId: string, base: string, settlement: string, rate: string): Promise<void>;
}

export type RateSource = "identity" | "manual" | "auto" | "last_known" | "trip_default";

export interface FxInput {
  localMinor: Minor;
  localCurrency: CurrencyCode;
  settlementCurrency: CurrencyCode;
  date: string; // 현지 일자 'YYYY-MM-DD'
  localExp: number; // currencies.minor_unit
  settleExp: number;
  tripId: string;
  manualRate?: string; // 사용자 입력 major→major rate
}

export interface FxResolved {
  settlement_amount: Minor;
  exchange_rate: string; // numeric(20,10) 문자열 (10dp)
  exchange_rate_date: string;
  exchange_rate_source: RateSource;
  exchange_rate_provider: string | null;
  exchange_rate_table_date: string | null;
  exchange_rate_fetched_at: string | null;
  fallbackWarning: boolean; // source ∈ {last_known, trip_default} (auto/manual/identity=false)
}
export type FxResult = FxResolved | { needsManual: true };
export const isResolved = (r: FxResult): r is FxResolved => !("needsManual" in r);
