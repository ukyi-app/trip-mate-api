import { describe, it, expect, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("ofetch", () => ({ ofetch: (...a: unknown[]) => fetchMock(...a) }));

import { OxrProvider } from "./oxr.ts";
import { CurrencyApiProvider } from "./currencyapi.ts";

// NOTE: mockReset를 beforeEach 훅이 아니라 각 테스트 본문에서 호출한다.
// vitest 4.1.9(Bun)에서 beforeEach 훅 + mock throw 조합이 swallow된 예외를
// 스푸리어스 실패로 surface하는 하네스 아티팩트가 있어, 훅 대신 인라인 reset로 회피.
const FULL = {
  USD: 1,
  KRW: 1320.5,
  JPY: 157.2,
  VND: 26000,
  TWD: 32.1,
  EUR: 0.92,
  THB: 36.2,
  GBP: 0.79,
  CHF: 0.89,
};

describe("OxrProvider", () => {
  it("9통화 완전 → UsdTable(Decimal)", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ base: "USD", rates: FULL });
    const t = await new OxrProvider("key").getUsdTable("2026-08-04");
    expect(t).not.toBeNull();
    expect(t!.KRW?.toString()).toBe("1320.5");
    expect(t!.USD?.toString()).toBe("1");
  });
  it("통화 누락(부분 테이블) → null", async () => {
    fetchMock.mockReset();
    const partial = { ...FULL };
    delete (partial as Record<string, number>).VND;
    fetchMock.mockResolvedValue({ base: "USD", rates: partial });
    expect(await new OxrProvider("key").getUsdTable("2026-08-04")).toBeNull();
  });
  it("0/음수 값 → null", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ base: "USD", rates: { ...FULL, THB: 0 } });
    expect(await new OxrProvider("key").getUsdTable("2026-08-04")).toBeNull();
  });
  it("네트워크 장애 → null (예외 삼킴)", async () => {
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error("timeout"));
    expect(await new OxrProvider("key").getUsdTable("2026-08-04")).toBeNull();
  });
});

const CA_FULL: Record<string, { value: number }> = Object.fromEntries(
  Object.entries(FULL).map(([k, v]) => [k, { value: v }]),
);

describe("CurrencyApiProvider", () => {
  it("9통화 완전 → UsdTable(Decimal)", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ data: CA_FULL });
    const t = await new CurrencyApiProvider("key").getUsdTable("2026-08-04");
    expect(t).not.toBeNull();
    expect(t!.KRW?.toString()).toBe("1320.5");
  });
  it("통화 누락(부분 테이블) → null", async () => {
    fetchMock.mockReset();
    const partial = { ...CA_FULL };
    delete (partial as Record<string, unknown>).VND;
    fetchMock.mockResolvedValue({ data: partial });
    expect(await new CurrencyApiProvider("key").getUsdTable("2026-08-04")).toBeNull();
  });
  it("네트워크 장애 → null (예외 삼킴)", async () => {
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error("timeout"));
    expect(await new CurrencyApiProvider("key").getUsdTable("2026-08-04")).toBeNull();
  });
});
