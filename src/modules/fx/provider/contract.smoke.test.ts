import { describe, it, expect } from "vitest";
import { OxrProvider, SUPPORTED } from "./oxr.ts";
import { CurrencyApiProvider } from "./currencyapi.ts";

const oxrKey = process.env.OXR_APP_ID;
const caKey = process.env.CURRENCYAPI_KEY;
const DATE = "2026-06-02"; // 대표 과거일

describe.skipIf(!oxrKey)("OXR 실계약 smoke", () => {
  it("28통화 양수 반환", async () => {
    const t = await new OxrProvider(oxrKey!).getUsdTable(DATE);
    expect(t).not.toBeNull();
    for (const c of SUPPORTED) expect(t![c]?.gt(0)).toBe(true);
  });
});
describe.skipIf(!caKey)("currencyapi 실계약 smoke", () => {
  it("28통화 양수 반환", async () => {
    const t = await new CurrencyApiProvider(caKey!).getUsdTable(DATE);
    expect(t).not.toBeNull();
    for (const c of SUPPORTED) expect(t![c]?.gt(0)).toBe(true);
  });
});
