import { ofetch } from "ofetch";
import Decimal from "decimal.js";
import type { FxProvider, UsdTable } from "../fx.types.ts";

export const SUPPORTED = ["USD", "KRW", "JPY", "VND", "TWD", "EUR", "THB", "GBP", "CHF"] as const;

/** rates(번호) → UsdTable(Decimal). 9통화 검증 통과만 반환, 아니면 null. */
export function buildValidatedTable(rates: Record<string, unknown>): UsdTable | null {
  const out: UsdTable = {};
  for (const code of SUPPORTED) {
    const v = rates[code];
    if (typeof v !== "number" && typeof v !== "string") return null;
    let d: Decimal;
    try {
      d = new Decimal(v);
    } catch {
      return null;
    }
    if (!d.isFinite() || d.lte(0)) return null;
    out[code] = d;
  }
  return out;
}

export class OxrProvider implements FxProvider {
  readonly name = "oxr";
  constructor(private readonly appId: string) {}
  async getUsdTable(date: string): Promise<UsdTable | null> {
    try {
      const res = await ofetch<{ rates?: Record<string, unknown> }>(
        `https://openexchangerates.org/api/historical/${date}.json`,
        { query: { app_id: this.appId, base: "USD" }, retry: 2, timeout: 8000 },
      );
      if (!res?.rates) return null;
      return buildValidatedTable(res.rates);
    } catch {
      return null;
    }
  }
}
