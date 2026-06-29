import Decimal from "decimal.js";
import type { CacheEntry, CachePort } from "../fx.types.ts";

export interface Wire {
  table: Record<string, string>;
  provider: string;
  tableDate: string;
  fetchedAt: string;
}
export function toWire(e: CacheEntry): Wire {
  const table: Record<string, string> = {};
  for (const [k, v] of Object.entries(e.table)) table[k] = v.toString();
  return { table, provider: e.provider, tableDate: e.tableDate, fetchedAt: e.fetchedAt };
}
export function fromWire(w: Wire): CacheEntry {
  const table: Record<string, Decimal> = {};
  for (const [k, v] of Object.entries(w.table)) table[k] = new Decimal(v);
  return { table, provider: w.provider, tableDate: w.tableDate, fetchedAt: w.fetchedAt };
}

export class MemoryCache implements CachePort {
  private store = new Map<string, string>();
  async getUsdTable(date: string) {
    const v = this.store.get(`fx:usdtable:${date}`);
    return v ? fromWire(JSON.parse(v) as Wire) : null;
  }
  async setUsdTable(date: string, entry: CacheEntry) {
    this.store.set(`fx:usdtable:${date}`, JSON.stringify(toWire(entry)));
  }
  async getLastKnown() {
    const v = this.store.get("fx:lastknown:usdtable");
    return v ? fromWire(JSON.parse(v) as Wire) : null;
  }
  async setLastKnown(entry: CacheEntry) {
    const existing = await this.getLastKnown();
    if (existing && existing.tableDate > entry.tableDate) return; // monotonic: older 테이블로 덮지 않음 (finding #1 pass5)
    this.store.set("fx:lastknown:usdtable", JSON.stringify(toWire(entry)));
  }
}
