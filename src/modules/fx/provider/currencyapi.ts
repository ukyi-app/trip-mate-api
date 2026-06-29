import { ofetch } from "ofetch";
import type { FxProvider, UsdTable } from "../fx.types.ts";
import { buildValidatedTable } from "./oxr.ts";

export class CurrencyApiProvider implements FxProvider {
  readonly name = "currencyapi";
  constructor(private readonly apiKey: string) {}
  async getUsdTable(date: string): Promise<UsdTable | null> {
    try {
      const res = await ofetch<{ data?: Record<string, { value: number }> }>(
        "https://api.currencyapi.com/v3/historical",
        { query: { apikey: this.apiKey, base_currency: "USD", date }, retry: 2, timeout: 8000 },
      );
      if (!res?.data) return null;
      const rates: Record<string, number> = {};
      for (const [k, v] of Object.entries(res.data)) rates[k] = v.value;
      return buildValidatedTable(rates);
    } catch {
      return null;
    }
  }
}
