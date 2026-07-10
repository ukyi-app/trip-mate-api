import { describe, it, expect } from "vitest";
import { SUPPORTED } from "./oxr.ts";
import { CURRENCY_SEED } from "../../../db/seed/currencies.ts";

// CI 게이트: seed⊆SUPPORTED 불변식을 정적으로 강제한다(testcontainers/네트워크 없음).
// buildValidatedTable은 SUPPORTED만으로 UsdTable을 만들므로, seed에만 있고 SUPPORTED에 없는
// 통화는 FX가 조용히 last_known/trip_default로 저하된다 → 반드시 SUPPORTED가 seed의 상위집합.
describe("FX 통화 커버리지 게이트", () => {
  it("모든 CURRENCY_SEED 코드가 SUPPORTED에 포함", () => {
    const supported = new Set<string>(SUPPORTED);
    const seedCodes = CURRENCY_SEED.map((c) => c.code);
    const missing = [...seedCodes].filter((c) => !supported.has(c));
    expect(missing, `SUPPORTED에 없는 seed 통화: ${missing.join(", ")}`).toEqual([]);
  });

  it("USD ∈ SUPPORTED (USD base 테이블 필수)", () => {
    expect(new Set<string>(SUPPORTED).has("USD")).toBe(true);
  });

  it("SUPPORTED에 중복 없음", () => {
    expect(SUPPORTED.length).toBe(new Set(SUPPORTED).size);
  });
});
