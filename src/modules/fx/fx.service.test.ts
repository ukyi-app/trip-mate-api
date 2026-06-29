import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { resolveFx } from "./fx.service.ts";
import { MemoryCache } from "./cache/cache.memory.ts";
import { minor, type CurrencyCode } from "../../core/money.ts";
import type {
  FxInput,
  FxProvider,
  TripDefaultsPort,
  UsdTable,
  CachePort,
  FxResult,
} from "./fx.types.ts";
import { isResolved } from "./fx.types.ts";
import { ValidationError } from "../../core/errors.ts";

const FULL: UsdTable = {
  USD: new Decimal(1),
  KRW: new Decimal("1320.5"),
  JPY: new Decimal("157.2"),
  VND: new Decimal("26000"),
  TWD: new Decimal("32.1"),
  EUR: new Decimal("0.92"),
  THB: new Decimal("36.2"),
  GBP: new Decimal("0.79"),
  CHF: new Decimal("0.89"),
};
const stubProvider = (table: UsdTable | null, name = "oxr"): FxProvider => ({
  name,
  getUsdTable: async () => table,
});
const noDefaults: TripDefaultsPort = { getRate: async () => null, upsertRate: async () => {} };
const baseInput = (over: Partial<FxInput> = {}): FxInput => ({
  localMinor: minor(100000n),
  localCurrency: "THB" as CurrencyCode,
  settlementCurrency: "KRW" as CurrencyCode,
  date: "2026-08-04",
  localExp: 2,
  settleExp: 0,
  tripId: "t1",
  ...over,
});

describe("resolveFx 4단계 체인", () => {
  it("⓪ identity: base==quote → rate=1, settlement=local, source=identity", async () => {
    const r = await resolveFx(baseInput({ localCurrency: "KRW" as CurrencyCode, localExp: 0 }), {
      providers: [stubProvider(null)],
      cache: new MemoryCache(),
      tripDefaults: noDefaults,
    });
    expect(isResolved(r) && r.exchange_rate_source).toBe("identity");
    expect(isResolved(r) && r.settlement_amount).toBe(100000n);
    expect(isResolved(r) && r.fallbackWarning).toBe(false);
  });
  it("① manual: 입력 rate 우선, source=manual", async () => {
    const r = await resolveFx(baseInput({ manualRate: "37.9" }), {
      providers: [stubProvider(null)],
      cache: new MemoryCache(),
      tripDefaults: noDefaults,
    });
    expect(isResolved(r) && r.exchange_rate_source).toBe("manual");
    expect(isResolved(r) && r.settlement_amount).toBe(37900n);
  });
  it("③ provider: 성공 → source=auto·provenance·캐시 저장", async () => {
    const cache = new MemoryCache();
    const r = await resolveFx(baseInput(), {
      providers: [stubProvider(FULL)],
      cache,
      tripDefaults: noDefaults,
    });
    expect(isResolved(r) && r.exchange_rate_source).toBe("auto");
    expect(isResolved(r) && r.exchange_rate_provider).toBe("oxr");
    expect(isResolved(r) && r.settlement_amount).toBe(36478n); // 100000 × (1320.5/36.2=36.4779005525) × 10^-2 = 36477.9 → 36478
    expect(isResolved(r) && r.exchange_rate).toBe("36.4779005525");
    expect(await cache.getUsdTable("2026-08-04")).not.toBeNull(); // 캐시·last_known 갱신
  });
  it("② cache HIT: provider 호출 없이 auto", async () => {
    const cache = new MemoryCache();
    await cache.setUsdTable(
      "2026-08-04",
      { table: FULL, provider: "oxr", tableDate: "2026-08-04", fetchedAt: "2026-08-04T00:00:00Z" },
      60,
    );
    let called = false;
    const p: FxProvider = {
      name: "oxr",
      getUsdTable: async () => {
        called = true;
        return null;
      },
    };
    const r = await resolveFx(baseInput(), { providers: [p], cache, tripDefaults: noDefaults });
    expect(called).toBe(false);
    expect(isResolved(r) && r.exchange_rate_source).toBe("auto");
  });
  it("③ failover: primary null → secondary", async () => {
    const r = await resolveFx(baseInput(), {
      providers: [stubProvider(null, "oxr"), stubProvider(FULL, "currencyapi")],
      cache: new MemoryCache(),
      tripDefaults: noDefaults,
    });
    expect(isResolved(r) && r.exchange_rate_provider).toBe("currencyapi");
  });
  it("④ last_known: provider 전부 실패, max-age 이내 → last_known(warning)", async () => {
    const cache = new MemoryCache();
    await cache.setLastKnown({
      table: FULL,
      provider: "oxr",
      tableDate: "2026-08-01",
      fetchedAt: "2026-08-01T00:00:00Z",
    });
    const r = await resolveFx(baseInput({ date: "2026-08-04" }), {
      providers: [stubProvider(null)],
      cache,
      tripDefaults: noDefaults,
    });
    expect(isResolved(r) && r.exchange_rate_source).toBe("last_known");
    expect(isResolved(r) && r.fallbackWarning).toBe(true);
  });
  it("④ last_known max-age 초과 → 강등", async () => {
    const cache = new MemoryCache();
    await cache.setLastKnown({
      table: FULL,
      provider: "oxr",
      tableDate: "2026-07-01",
      fetchedAt: "x",
    });
    const r = await resolveFx(baseInput({ date: "2026-08-04" }), {
      providers: [stubProvider(null)],
      cache,
      tripDefaults: { getRate: async () => "37.9", upsertRate: async () => {} },
    });
    expect(isResolved(r) && r.exchange_rate_source).toBe("trip_default"); // last_known 건너뜀
  });
  it("⑤ trip_default: 전부 실패 + default 존재 → trip_default(warning)", async () => {
    const r = await resolveFx(baseInput(), {
      providers: [stubProvider(null)],
      cache: new MemoryCache(),
      tripDefaults: { getRate: async () => "37.9", upsertRate: async () => {} },
    });
    expect(isResolved(r) && r.exchange_rate_source).toBe("trip_default");
    expect(isResolved(r) && r.settlement_amount).toBe(37900n);
  });
  it("⑥ 전부 실패 → needsManual", async () => {
    const r = await resolveFx(baseInput(), {
      providers: [stubProvider(null)],
      cache: new MemoryCache(),
      tripDefaults: noDefaults,
    });
    expect("needsManual" in r && r.needsManual).toBe(true);
  });
  it("결정성: 동일 입력+고정 now → 동일 결과 (BigInt-safe 비교, finding #3)", async () => {
    const now = () => new Date("2026-08-04T12:00:00.000Z");
    const mk = () =>
      resolveFx(baseInput(), {
        providers: [stubProvider(FULL)],
        cache: new MemoryCache(),
        tripDefaults: noDefaults,
        now,
      });
    const norm = (r: FxResult) =>
      isResolved(r) ? { ...r, settlement_amount: r.settlement_amount.toString() } : r;
    expect(norm(await mk())).toEqual(norm(await mk()));
  });

  it("캐시 장애(throwing CachePort) → provider 경로 완주 (fail-open, finding #1)", async () => {
    const boom: CachePort = {
      getUsdTable: async () => {
        throw new Error("redis down");
      },
      setUsdTable: async () => {
        throw new Error("redis down");
      },
      getLastKnown: async () => {
        throw new Error("redis down");
      },
      setLastKnown: async () => {
        throw new Error("redis down");
      },
    };
    const r = await resolveFx(baseInput(), {
      providers: [stubProvider(FULL)],
      cache: boom,
      tripDefaults: noDefaults,
    });
    expect(isResolved(r) && r.exchange_rate_source).toBe("auto");
  });
  it("manual 무효(0·garbage) → ValidationError (finding #2)", async () => {
    const deps = {
      providers: [stubProvider(null)],
      cache: new MemoryCache(),
      tripDefaults: noDefaults,
    };
    await expect(resolveFx(baseInput({ manualRate: "0" }), deps)).rejects.toThrow(ValidationError);
    await expect(resolveFx(baseInput({ manualRate: "abc" }), deps)).rejects.toThrow(
      ValidationError,
    );
  });
  it("trip_default 손상(0) → 건너뜀 → needsManual (finding #2)", async () => {
    const r = await resolveFx(baseInput(), {
      providers: [stubProvider(null)],
      cache: new MemoryCache(),
      tripDefaults: { getRate: async () => "0", upsertRate: async () => {} },
    });
    expect("needsManual" in r && r.needsManual).toBe(true);
  });
  it("오염 캐시(통화 누락) → miss로 fall-through → provider (finding #2 pass2)", async () => {
    const cache = new MemoryCache();
    await cache.setUsdTable(
      "2026-08-04",
      {
        table: { USD: new Decimal(1), THB: new Decimal("36.2") },
        provider: "x",
        tableDate: "2026-08-04",
        fetchedAt: "x",
      },
      60,
    ); // KRW 없음
    const r = await resolveFx(baseInput(), {
      providers: [stubProvider(FULL)],
      cache,
      tripDefaults: noDefaults,
    });
    expect(isResolved(r) && r.exchange_rate_source).toBe("auto");
    expect(isResolved(r) && r.exchange_rate_provider).toBe("oxr"); // provider로 fall-through
  });
  it("오염 last_known(통화 누락) → 건너뜀 → needsManual (finding #2 pass2)", async () => {
    const cache = new MemoryCache();
    await cache.setLastKnown({
      table: { USD: new Decimal(1), THB: new Decimal("36.2") },
      provider: "x",
      tableDate: "2026-08-04",
      fetchedAt: "x",
    });
    const r = await resolveFx(baseInput({ date: "2026-08-04" }), {
      providers: [stubProvider(null)],
      cache,
      tripDefaults: noDefaults,
    });
    expect("needsManual" in r && r.needsManual).toBe(true);
  });
  it("provider auto 성공 시 resolveFx는 trip_default를 쓰지 않음 (side-effect-free, finding #1 pass3)", async () => {
    let upserted = false;
    const td: TripDefaultsPort = {
      getRate: async () => null,
      upsertRate: async () => {
        upserted = true;
      },
    };
    await resolveFx(baseInput(), {
      providers: [stubProvider(FULL)],
      cache: new MemoryCache(),
      tripDefaults: td,
    });
    expect(upserted).toBe(false); // 승격은 저장경로 in-tx 책임
  });

  it("mis-keyed 캐시(tableDate != date) → fall-through → provider (finding #2 pass4)", async () => {
    const cache = new MemoryCache();
    await cache.setUsdTable(
      "2026-08-04",
      { table: FULL, provider: "x", tableDate: "2026-07-01", fetchedAt: "x" },
      60,
    );
    const r = await resolveFx(baseInput(), {
      providers: [stubProvider(FULL)],
      cache,
      tripDefaults: noDefaults,
    });
    expect(isResolved(r) && r.exchange_rate_provider).toBe("oxr"); // 캐시 무시(tableDate 불일치) → provider
  });
  it("캐시 장애 시 onWarn 신호 + fail-open (finding #3 pass4)", async () => {
    const events: string[] = [];
    const boom: CachePort = {
      getUsdTable: async () => {
        throw new Error("redis down");
      },
      setUsdTable: async () => {},
      getLastKnown: async () => null,
      setLastKnown: async () => {},
    };
    const r = await resolveFx(baseInput(), {
      providers: [stubProvider(FULL)],
      cache: boom,
      tripDefaults: noDefaults,
      onWarn: (e) => events.push(e),
    });
    expect(isResolved(r) && r.exchange_rate_source).toBe("auto"); // fail-open
    expect(events).toContain("fx.cache.read_error");
  });
  it("모든 소스 실패 → onWarn('fx.needs_manual') (finding #3 pass4)", async () => {
    const events: string[] = [];
    const r = await resolveFx(baseInput(), {
      providers: [stubProvider(null)],
      cache: new MemoryCache(),
      tripDefaults: noDefaults,
      onWarn: (e) => events.push(e),
    });
    expect("needsManual" in r).toBe(true);
    expect(events).toContain("fx.needs_manual");
  });
});
