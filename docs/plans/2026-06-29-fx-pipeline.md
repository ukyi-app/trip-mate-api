# trip-mate-api FX 파이프라인 슬라이스 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 지출 저장 시점에 환율을 해결·동결하는 FX 모듈(`resolveFx`)을 4단계 우선순위 체인·고정밀 cross-rate·Valkey 캐시·trip_default와 함께 TDD로 구축한다. expense 저장경로 통합은 제외(후속 API 슬라이스).

**Architecture:** functional core(순수 decimal.js 환산) / imperative shell(provider·cache·repo 포트+어댑터). `resolveFx`는 포트를 주입받아 ⓪identity→①manual→②cache→③provider→④last_known→⑤trip_default→⑥needsManual 순으로 해결하고 `exchange_rate`(numeric 20,10)·`settlement_amount`(minor 정수)를 동결한다. 외부 API·Valkey는 포트 뒤에 격리해 테스트는 mock/fake/testcontainers로 수행.

**Tech Stack:** Bun · decimal.js(고정밀) · ofetch(외부 HTTP) · ioredis(Valkey) · Drizzle · vitest · testcontainers(PG16·redis). 기반: `src/core/money.ts`(Money/Minor/brand)·`src/db/schema`(currencies·exchange_rate* 컬럼)·`tests/db/helpers.ts`(testcontainers 패턴).

**SSOT(충돌 시 우선):** `docs/plans/2026-06-29-fx-pipeline-slice-design.md`(범위·결정) · `docs/plans/2026-06-25-fx-pipeline-design.md`(FX 기술설계) · `docs/architecture.md`.

---

## 진행 원칙 (executing-plans)
- **연속 실행** — 진짜 블로커에서만 정지. TDD(테스트 먼저→실패→구현→통과→커밋).
- **워크트리** — 이미 `feat/fx-pipeline`로 격리됨. 새 워크트리 만들지 말 것. 경로는 워크트리 기준.
- **커밋** — 각 Task Commit 스텝에서 직접. 한국어·**AI 마커 금지**·`<type>(<scope>): 설명`, type은 `feat/fix/refactor/docs/style/test/chore`만. `Skill(commit)` 호출 금지.
- **포맷** — 새 .ts 작성 후 커밋 전 `bun run fmt` → `bun run check`. (oxfmt가 .md·migrations 제외하도록 `.oxfmtrc` 설정됨.)
- **import 확장자** `.ts` 필수(우리 파일). 외부 API/Valkey는 통합테스트에서 mock/fake/testcontainers — 실 키·실 redis 불필요.

## Out of scope (후속 슬라이스 — 이 slice 미구현)
expense 저장경로/서비스/라우트 통합 · `resolveFx`의 **card_billed 분기**(저장경로가 카드 청구액으로 분기, FX 호출 안 함) · OpenAPI 생성 · 편집 재계산 트리거 · 여행방 생성→trip_default 시드 훅 연결 · 실 OXR/currencyapi 키 호출 · 레이트리밋/비용 상한 운영 · **trip_default 승격(promotion)**(finding #1 pass3): resolveFx는 trip_default를 **읽기만**(side-effect-free), 승격은 **저장경로 post-save·in-tx**에서 수행한다 — 충돌정책 **`onConflictDoNothing`=첫 auto 우선**(결정적·last-writer 경쟁 없음), 저장 롤백 시 미오염. repo의 `upsertRate`(overwrite)는 명시적 set용 primitive이며 승격은 저장 슬라이스가 first-wins 경로로 호출. · **provider 동시-miss single-flight/stampede 방지**(finding #1 pass5): cold-date 동시 호출 시 per-date Redis `SET NX` 락으로 1회만 fetch — 비용 상한 운영과 함께 **레이트리밋 슬라이스로 defer**(last_known monotonic 덮어쓰기 방지는 본 슬라이스에 반영됨).

## 빌드 순서 (의존성)
`Task 0 의존성 → 1 타입 → 2 convert(순수) → 3 provider → 4 cache → 5 trip_fx_defaults 스키마·마이그레이션 → 6 trip-defaults repo → 7 resolveFx → 8 DB 제약 테스트`.

---

## Task 0: 의존성 추가

**Step 1: 설치**

Run: `cd /Users/ukyi/workspace/trip-mate-api/.worktrees/fx-pipeline && bun add decimal.js ofetch ioredis`
Expected: `package.json` dependencies에 3개 추가, 0 errors. (해석 버전 확인 — decimal.js ^10·ofetch ^1·ioredis ^5 대.)

**Step 2: 검증·Commit**

Run: `bun run check` · Expected: exit 0.

```bash
git add package.json bun.lock
git commit -m "chore(fx): decimal.js·ofetch·ioredis 의존성 추가"
```

---

## Task 1: FX 타입·포트 (`fx.types.ts`)

**Files:** Create `src/modules/fx/fx.types.ts`

타입·포트만(런타임 로직 없음) → TDD 비대상. 컴파일로 검증.

**Step 1: 작성**

```ts
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
```

**Step 2: 검증·Commit** — `bun run check` exit 0.

```bash
git add src/modules/fx/fx.types.ts
git commit -m "feat(fx): FX 타입·포트 정의(FxProvider·CachePort·TripDefaultsPort·FxResult)"
```

---

## Task 2: converted 정수 산식 (`domain/convert.ts`, TDD·순수·decimal.js)

**Files:** Create `src/modules/fx/domain/convert.ts` · Test `src/modules/fx/domain/convert.test.ts`

SSOT: FX 설계 §2.1·§4.3, 정산엔진 §2.1. **rate는 numeric(20,10) authoritative(10dp)로 동결하고 그 값에서 settlement_amount 산출**(편집 재계산 일관).

**Step 1: 실패 테스트**

```ts
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { roundHalfAwayFromZero, convert, crossRate, parsePositiveRate } from "./convert.ts";
import { minor } from "../../../core/money.ts";
import { ValidationError } from "../../../core/errors.ts";

describe("roundHalfAwayFromZero", () => {
  it("0.5는 0에서 멀어지게 (양수)", () => {
    expect(roundHalfAwayFromZero(new Decimal("2.5"))).toBe(3n);
    expect(roundHalfAwayFromZero(new Decimal("2.4"))).toBe(2n);
  });
  it("음수 대칭 (환불)", () => {
    expect(roundHalfAwayFromZero(new Decimal("-2.5"))).toBe(-3n);
    expect(roundHalfAwayFromZero(new Decimal("-2.4"))).toBe(-2n);
  });
});

describe("convert (PRD §13.3)", () => {
  it("1,000 THB · rate 37.9 · THB exp2 · KRW exp0 → 37,900 KRW", () => {
    // local_minor = 1000 THB in minor(0.01) = 100000
    const r = convert({ localMinor: minor(100000n), rate: new Decimal("37.9"), localExp: 2, settleExp: 0 });
    expect(r).toBe(37900n);
  });
  it("음수(환불) 대칭", () => {
    const r = convert({ localMinor: minor(-100000n), rate: new Decimal("37.9"), localExp: 2, settleExp: 0 });
    expect(r).toBe(-37900n);
  });
});

describe("crossRate", () => {
  it("usd[quote]/usd[base] 고정밀 (저→고가 VND→GBP)", () => {
    const usd = { USD: new Decimal(1), VND: new Decimal("26000"), GBP: new Decimal("0.79") };
    const rate = crossRate(usd, "VND", "GBP"); // 1 VND = 0.79/26000 GBP
    expect(rate.toDecimalPlaces(10).toFixed(10)).toBe("0.0000303846");
  });
});

describe("parsePositiveRate (finding #2)", () => {
  it("유효 → Decimal", () => {
    expect(parsePositiveRate("37.9").toString()).toBe("37.9");
  });
  it("0·음수·garbage → ValidationError", () => {
    expect(() => parsePositiveRate("0")).toThrow(ValidationError);
    expect(() => parsePositiveRate("-1")).toThrow(ValidationError);
    expect(() => parsePositiveRate("abc")).toThrow(ValidationError);
  });
  it("10dp 반올림 후 0(tiny) → ValidationError (finding #1 pass2)", () => {
    expect(() => parsePositiveRate("0.00000000001")).toThrow(ValidationError); // 1e-11 → 0.0000000000
  });
  it("numeric(20,10) 범위 초과(huge) → ValidationError", () => {
    expect(() => parsePositiveRate("10000000000")).toThrow(ValidationError); // 10^10
  });
});
```

**Step 2: 실패 확인** — Run: `bun run test src/modules/fx/domain/convert.test.ts` · Expected: FAIL(convert.ts 없음).

**Step 3: 구현**

```ts
import Decimal from "decimal.js";
import { type Minor } from "../../../core/money.ts";
import { ValidationError } from "../../../core/errors.ts";
import type { UsdTable } from "../fx.types.ts";

Decimal.set({ precision: 40 }); // cross-rate 나눗셈 고정밀

/** 절댓값 0.5 → 0에서 멀어지게(음수 대칭). decimal.js ROUND_HALF_UP = away-from-zero. */
export function roundHalfAwayFromZero(d: Decimal): bigint {
  return BigInt(d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
}

/** settlement_minor = round_half_away(local_minor × rate × 10^(settleExp − localExp)). rate는 동결된 10dp 값. */
export function convert(args: {
  localMinor: Minor;
  rate: Decimal;
  localExp: number;
  settleExp: number;
}): Minor {
  const scaled = new Decimal(args.localMinor.toString())
    .times(args.rate)
    .times(new Decimal(10).pow(args.settleExp - args.localExp));
  return roundHalfAwayFromZero(scaled) as Minor;
}

/** 1 base = ? quote (major→major). usd 테이블에서 교차. */
export function crossRate(usd: UsdTable, base: string, quote: string): Decimal {
  const b = usd[base];
  const q = usd[quote];
  if (!b || !q || b.lte(0) || q.lte(0)) throw new Error(`crossRate: missing/invalid rate ${base}/${quote}`);
  return q.div(b);
}

const RATE_MAX = new Decimal(10).pow(10); // numeric(20,10): 정수부 ≤ 10자리

/** 10dp 반올림 **후** 검증: >0(반올림 후 0 아님) & < 10^10(numeric(20,10) 적합). 반올림된 값 반환 (finding #1). */
export function normalizeRate(d: Decimal): Decimal {
  if (!d.isFinite()) throw new ValidationError(`rate not finite: ${d.toString()}`);
  const r = d.toDecimalPlaces(10, Decimal.ROUND_HALF_UP);
  if (r.lte(0)) throw new ValidationError(`rate must be > 0 after 10dp rounding: ${d.toString()}`);
  if (r.abs().gte(RATE_MAX)) throw new ValidationError(`rate out of numeric(20,10) range: ${d.toString()}`);
  return r;
}

/** rate 문자열 파싱 + normalizeRate(10dp·검증). manual(사용자)·trip_default(영속) 공용. */
export function parsePositiveRate(s: string): Decimal {
  let d: Decimal;
  try {
    d = new Decimal(s);
  } catch {
    throw new ValidationError(`invalid rate: ${s}`);
  }
  return normalizeRate(d);
}
```

**Step 4: 통과 확인** — Run: same · Expected: PASS.

**Step 5: Commit**

```bash
bun run fmt
git add src/modules/fx/domain/convert.ts src/modules/fx/domain/convert.test.ts
git commit -m "feat(fx): converted 정수 산식·round-half-away·cross-rate (decimal.js)"
```

---

## Task 3: provider 어댑터 (`provider/`, TDD·fetch mock)

**Files:** Create `src/modules/fx/provider/oxr.ts` · `src/modules/fx/provider/currencyapi.ts` · Test `src/modules/fx/provider/provider.test.ts`

SSOT: FX 설계 §4·§4.2. **9통화 전부 present·양수·non-null·파싱가능만 성공**, 아니면 null(failover). USD base 강제(usd['USD']=1).

**지원 통화 상수** (FX 설계 §4.2 — 9통화): `['USD','KRW','JPY','VND','TWD','EUR','THB','GBP','CHF']`.

**Step 1: 실패 테스트** (ofetch를 vi.mock으로 가로채기)

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("ofetch", () => ({ ofetch: (...a: unknown[]) => fetchMock(...a) }));

import { OxrProvider } from "./oxr.ts";

const FULL = { USD: 1, KRW: 1320.5, JPY: 157.2, VND: 26000, TWD: 32.1, EUR: 0.92, THB: 36.2, GBP: 0.79, CHF: 0.89 };

describe("OxrProvider", () => {
  beforeEach(() => fetchMock.mockReset());
  it("9통화 완전 → UsdTable(Decimal)", async () => {
    fetchMock.mockResolvedValue({ base: "USD", rates: FULL });
    const t = await new OxrProvider("key").getUsdTable("2026-08-04");
    expect(t).not.toBeNull();
    expect(t!.KRW.toString()).toBe("1320.5");
    expect(t!.USD.toString()).toBe("1");
  });
  it("통화 누락(부분 테이블) → null", async () => {
    const partial = { ...FULL };
    delete (partial as Record<string, number>).VND;
    fetchMock.mockResolvedValue({ base: "USD", rates: partial });
    expect(await new OxrProvider("key").getUsdTable("2026-08-04")).toBeNull();
  });
  it("0/음수 값 → null", async () => {
    fetchMock.mockResolvedValue({ base: "USD", rates: { ...FULL, THB: 0 } });
    expect(await new OxrProvider("key").getUsdTable("2026-08-04")).toBeNull();
  });
  it("네트워크 장애 → null (예외 삼킴)", async () => {
    fetchMock.mockRejectedValue(new Error("timeout"));
    expect(await new OxrProvider("key").getUsdTable("2026-08-04")).toBeNull();
  });
});
```

**Step 2: 실패 확인** — Run: `bun run test src/modules/fx/provider/provider.test.ts` · Expected: FAIL.

**Step 3: 구현** — `provider/oxr.ts`

```ts
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
```

`provider/currencyapi.ts` (secondary — 응답 shape `{ data: { KRW: { value } } }`):

```ts
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
```

> currencyapi 테스트도 provider.test.ts에 추가(동일 검증 — full→table·partial→null). buildValidatedTable는 공유.

**Step 4: 통과 확인** — Run: same · Expected: PASS.

**Step 4b: opt-in 실계약 smoke 테스트** `src/modules/fx/provider/contract.smoke.test.ts` (finding #1 pass4 — mock만으론 auth/quota/historical/shape 미검증). **키 없으면 skip**(슬라이스 DoD·CI 무영향). 착수/배포 전 키로 1회 실행해 FX 설계 §4.1 caveat(9통화·TWD/VND historical) 검증.

```ts
import { describe, it, expect } from "vitest";
import { OxrProvider, SUPPORTED } from "./oxr.ts";
import { CurrencyApiProvider } from "./currencyapi.ts";

const oxrKey = process.env.OXR_APP_ID;
const caKey = process.env.CURRENCYAPI_KEY;
const DATE = "2026-06-02"; // 대표 과거일

describe.skipIf(!oxrKey)("OXR 실계약 smoke", () => {
  it("9통화 양수 반환", async () => {
    const t = await new OxrProvider(oxrKey!).getUsdTable(DATE);
    expect(t).not.toBeNull();
    for (const c of SUPPORTED) expect(t![c]?.gt(0)).toBe(true);
  });
});
describe.skipIf(!caKey)("currencyapi 실계약 smoke", () => {
  it("9통화 양수 반환", async () => {
    const t = await new CurrencyApiProvider(caKey!).getUsdTable(DATE);
    expect(t).not.toBeNull();
    for (const c of SUPPORTED) expect(t![c]?.gt(0)).toBe(true);
  });
});
```
> 선택: `.env.example`에 `OXR_APP_ID=`·`CURRENCYAPI_KEY=`(빈 값) 추가. 키 미설정 → `describe.skipIf`로 전체 skip(통과로 집계 안 됨).

**Step 5: Commit**

```bash
bun run fmt
git add src/modules/fx/provider
git commit -m "feat(fx): OXR·currencyapi provider 어댑터(9통화 검증·ofetch·failover·opt-in 실계약 smoke)"
```

---

## Task 4: 캐시 포트·어댑터 (`cache/`, TDD·fake 단위 + testcontainers redis)

**Files:** Create `cache/cache.port.ts`(재export) · `cache/cache.memory.ts` · `cache/cache.redis.ts` · Test `cache/cache.test.ts`

SSOT: FX 설계 §3. 키 `fx:usdtable:{date}`·`fx:lastknown:usdtable`. Decimal은 JSON 직렬화 위해 문자열로 저장.

**Step 1: 실패 테스트** (fake 단위 + redis 어댑터 parity, testcontainers redis)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Decimal from "decimal.js";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import Redis from "ioredis";
import { MemoryCache } from "./cache.memory.ts";
import { RedisCache } from "./cache.redis.ts";
import type { CacheEntry, CachePort } from "../fx.types.ts";

const entry = (): CacheEntry => ({
  table: { USD: new Decimal(1), KRW: new Decimal("1320.5") },
  provider: "oxr",
  tableDate: "2026-08-04",
  fetchedAt: "2026-08-04T00:00:00.000Z",
});

function suite(name: string, make: () => Promise<{ cache: CachePort; cleanup: () => Promise<void> }>) {
  describe(name, () => {
    it("usdtable set→get round-trip (Decimal 복원)", async () => {
      const { cache, cleanup } = await make();
      await cache.setUsdTable("2026-08-04", entry(), 60);
      const got = await cache.getUsdTable("2026-08-04");
      expect(got?.table.KRW.toString()).toBe("1320.5");
      expect(got?.provider).toBe("oxr");
      await cleanup();
    });
    it("miss → null", async () => {
      const { cache, cleanup } = await make();
      expect(await cache.getUsdTable("2099-01-01")).toBeNull();
      await cleanup();
    });
    it("lastknown set→get", async () => {
      const { cache, cleanup } = await make();
      await cache.setLastKnown(entry());
      expect((await cache.getLastKnown())?.tableDate).toBe("2026-08-04");
      await cleanup();
    });
    it("lastknown monotonic: older tableDate는 덮지 않음 (finding #1 pass5)", async () => {
      const { cache, cleanup } = await make();
      await cache.setLastKnown({ ...entry(), tableDate: "2026-08-04" });
      await cache.setLastKnown({ ...entry(), tableDate: "2026-07-01" }); // older → 무시
      expect((await cache.getLastKnown())?.tableDate).toBe("2026-08-04");
      await cleanup();
    });
  });
}

suite("MemoryCache(fake)", async () => ({ cache: new MemoryCache(), cleanup: async () => {} }));

let container: StartedRedisContainer;
let redis: Redis;
beforeAll(async () => {
  container = await new RedisContainer("redis:7").start();
  redis = new Redis(container.getConnectionUrl());
});
afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
});
suite("RedisCache(ioredis)", async () => ({ cache: new RedisCache(redis), cleanup: async () => {} }));
```

> `@testcontainers/redis` 추가 필요: `bun add -d @testcontainers/redis`. redis 이미지(redis:7)는 Valkey 호환 RESP — ioredis 동작 동일.

**Step 2: 실패 확인** — Run: `bun add -d @testcontainers/redis` 후 `bun run test src/modules/fx/cache/cache.test.ts` · Expected: FAIL.

**Step 3: 구현**

`cache/cache.port.ts`:
```ts
export type { CachePort, CacheEntry } from "../fx.types.ts";
```

직렬화 헬퍼 + MemoryCache (`cache/cache.memory.ts`):
```ts
import Decimal from "decimal.js";
import type { CacheEntry, CachePort } from "../fx.types.ts";

interface Wire {
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
```

RedisCache (`cache/cache.redis.ts`):
```ts
import type Redis from "ioredis";
import type { CacheEntry, CachePort } from "../fx.types.ts";
import { fromWire, toWire, type Wire } from "./cache.memory.ts"; // Wire export 추가 필요

export class RedisCache implements CachePort {
  constructor(private readonly redis: Redis) {}
  async getUsdTable(date: string) {
    const v = await this.redis.get(`fx:usdtable:${date}`);
    return v ? fromWire(JSON.parse(v) as Wire) : null;
  }
  async setUsdTable(date: string, entry: CacheEntry, ttlSeconds: number) {
    await this.redis.set(`fx:usdtable:${date}`, JSON.stringify(toWire(entry)), "EX", ttlSeconds);
  }
  async getLastKnown() {
    const v = await this.redis.get("fx:lastknown:usdtable");
    return v ? fromWire(JSON.parse(v) as Wire) : null;
  }
  async setLastKnown(entry: CacheEntry) {
    const existing = await this.getLastKnown();
    if (existing && existing.tableDate > entry.tableDate) return; // monotonic (best-effort; 원자성은 single-flight 슬라이스, finding #1 pass5)
    await this.redis.set("fx:lastknown:usdtable", JSON.stringify(toWire(entry)));
  }
}
```
> `cache.memory.ts`에서 `Wire` 타입도 export. MemoryCache의 `setUsdTable`는 ttl 인자를 받되 무시(시그니처 일치).

**Step 4: 통과 확인** — Run: same · Expected: PASS (MemoryCache 3 + RedisCache 3).

**Step 5: Commit**

```bash
bun run fmt
git add src/modules/fx/cache package.json bun.lock
git commit -m "test(fx): 캐시 포트·MemoryCache·RedisCache(ioredis) + testcontainers redis parity"
```

---

## Task 5: trip_fx_defaults 스키마 + 마이그레이션

**Files:** Create `src/db/schema/fx.ts` · Modify `src/db/schema/index.ts` · (생성) `src/db/migrations/0001_*`

SSOT: FX 설계 §5, DB 설계 §2(composite FK·cascade 규약). rate는 numeric(20,10).

**Step 1: `src/db/schema/fx.ts`**

```ts
import { check, numeric, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamps } from "./_shared.ts";
import { trips } from "./trips.ts";
import { currencies } from "./currencies.ts";

export const tripFxDefaults = pgTable(
  "trip_fx_defaults",
  {
    trip_id: uuid()
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    base_currency: text()
      .notNull()
      .references(() => currencies.code),
    settlement_currency: text()
      .notNull()
      .references(() => currencies.code),
    rate: numeric({ precision: 20, scale: 10 }).notNull(),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.trip_id, t.base_currency, t.settlement_currency] }),
    check("fx_default_rate_pos", sql`${t.rate} > 0`), // 손상/음수 rate 영속 차단 (finding #2)
  ],
);
```

**Step 2: `index.ts`에 재export 추가**

`src/db/schema/index.ts`에 한 줄 추가: `export * from "./fx.ts";`

**Step 3: 마이그레이션 생성·idempotency·적용 검증**

Run: `bun run db:generate` · Expected: `0001_*.sql` 생성(trip_fx_defaults 1 table). 
Run: `bun run db:generate` (재실행) · Expected: "No schema changes" (idempotent).
Run: 재시도-안전 docker smoke(기반 plan과 동일 패턴):
```bash
docker rm -f tmpgfx 2>/dev/null || true
trap 'docker rm -f tmpgfx 2>/dev/null || true' EXIT
docker run --rm -d -p 5434:5432 -e POSTGRES_PASSWORD=trip -e POSTGRES_USER=trip -e POSTGRES_DB=trip_mate --name tmpgfx postgres:16 >/dev/null
until docker exec tmpgfx pg_isready -U trip >/dev/null 2>&1; do sleep 1; done
DATABASE_URL=postgres://trip:trip@localhost:5434/trip_mate bun run db:migrate
```
Expected: 0000 + 0001 클린 적용(0 errors).

**롤백/백아웃 (finding #3 pass5):** `trip_fx_defaults`는 **additive**(새 테이블, 기존 무변경). 구코드는 미참조 → 잔존해도 호환. **릴리스 롤백 시 테이블 그대로 둔다**(데이터 보존·no-op). drizzle은 down 마이그레이션을 만들지 않으므로, 제거가 꼭 필요하면 **trip_default 사용 전·pre-prod에서만** 수동 `DROP TABLE trip_fx_defaults`. 배포 순서: 마이그레이션(0001) → 코드(additive라 순서 무관).

**Step 4: Commit**

```bash
bun run fmt && bun run check
git add src/db/schema/fx.ts src/db/schema/index.ts src/db/migrations
git commit -m "feat(db): trip_fx_defaults 테이블·마이그레이션(복합 PK·trip cascade·currency FK)"
```

---

## Task 6: trip-defaults repo (`trip-defaults.repo.ts`)

**Files:** Create `src/modules/fx/trip-defaults.repo.ts` · Test `src/modules/fx/trip-defaults.repo.test.ts`(testcontainers PG)

**Step 1: 실패 테스트** (testcontainers PG — `tests/db/helpers.ts`의 startDb 재사용, mkTrip 필요)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDb, mkUser, mkTrip, type Ctx } from "../../../tests/db/helpers.ts";
import { DrizzleTripDefaults } from "./trip-defaults.repo.ts";

let ctx: Ctx;
beforeAll(async () => { ctx = await startDb(); });
afterAll(async () => { await ctx.sql.end(); await ctx.container.stop(); });

describe("DrizzleTripDefaults", () => {
  it("upsert→get round-trip + 덮어쓰기", async () => {
    const u = await mkUser(ctx.sql);
    const trip = await mkTrip(ctx.sql, u);
    const repo = new DrizzleTripDefaults(ctx.db);
    expect(await repo.getRate(trip, "THB", "KRW")).toBeNull();
    await repo.upsertRate(trip, "THB", "KRW", "37.9000000000");
    expect(await repo.getRate(trip, "THB", "KRW")).toBe("37.9000000000");
    await repo.upsertRate(trip, "THB", "KRW", "38.0000000000"); // 덮어쓰기
    expect(await repo.getRate(trip, "THB", "KRW")).toBe("38.0000000000");
  });
});
```

> `tests/db/helpers.ts`는 기존 export(startDb·mkUser·mkTrip) 사용. import 경로는 워크트리 루트 기준 상대경로.

**Step 2: 실패 확인** — Run: `bun run test src/modules/fx/trip-defaults.repo.test.ts` · Expected: FAIL.

**Step 3: 구현**

```ts
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { tripFxDefaults } from "../../db/schema/fx.ts";
import type { TripDefaultsPort } from "./fx.types.ts";

export class DrizzleTripDefaults<T extends Record<string, unknown>> implements TripDefaultsPort {
  constructor(private readonly db: PostgresJsDatabase<T>) {}
  async getRate(tripId: string, base: string, settlement: string): Promise<string | null> {
    const rows = await this.db
      .select({ rate: tripFxDefaults.rate })
      .from(tripFxDefaults)
      .where(
        and(
          eq(tripFxDefaults.trip_id, tripId),
          eq(tripFxDefaults.base_currency, base),
          eq(tripFxDefaults.settlement_currency, settlement),
        ),
      );
    return rows[0]?.rate ?? null;
  }
  async upsertRate(tripId: string, base: string, settlement: string, rate: string): Promise<void> {
    await this.db
      .insert(tripFxDefaults)
      .values({ trip_id: tripId, base_currency: base, settlement_currency: settlement, rate })
      .onConflictDoUpdate({
        target: [tripFxDefaults.trip_id, tripFxDefaults.base_currency, tripFxDefaults.settlement_currency],
        set: { rate },
      });
  }
}
```
> 제네릭 `<T extends Record<string, unknown>>`로 어떤 스키마(`typeof schema` 포함)든 수용 — `new DrizzleTripDefaults(ctx.db)`가 T 추론(strict TS 통과). seedCurrencies 패턴(finding #2 pass3).

**Step 4: 통과 확인** — Run: same · Expected: PASS.

**Step 5: Commit**

```bash
bun run fmt && bun run check
git add src/modules/fx/trip-defaults.repo.ts src/modules/fx/trip-defaults.repo.test.ts
git commit -m "feat(fx): trip_fx_defaults repo(get/upsert, 포트+drizzle)"
```

---

## Task 7: resolveFx 서비스 (`fx.service.ts`, TDD·4단계 체인)

**Files:** Create `src/modules/fx/fx.service.ts` · Test `src/modules/fx/fx.service.test.ts`

SSOT: FX 설계 §2(체인)·§3(max-age)·§10(provenance). 포트 주입(provider[]·cache·tripDefaults). 외부 의존 mock/fake.

**체인:** ⓪identity(base==quote) → ①manual → ②cache HIT → ③provider(primary→secondary, 검증 통과 시 cache+last_known 갱신) → ④last_known(`|tableDate−date|≤maxAgeDays`) → ⑤trip_default → ⑥needsManual. crossRate 기반(②③④)은 `exchange_rate=crossRate.toDecimalPlaces(10)`에서 settlement_amount 산출. fallbackWarning = source ∈ {last_known, trip_default}.

**Step 1: 실패 테스트** (fake cache·stub provider·stub repo)

```ts
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { resolveFx } from "./fx.service.ts";
import { MemoryCache } from "./cache/cache.memory.ts";
import { minor, type CurrencyCode } from "../../core/money.ts";
import type { FxInput, FxProvider, TripDefaultsPort, UsdTable, CacheEntry, CachePort, FxResult } from "./fx.types.ts";
import { isResolved } from "./fx.types.ts";
import { ValidationError } from "../../core/errors.ts";

const FULL: UsdTable = {
  USD: new Decimal(1), KRW: new Decimal("1320.5"), JPY: new Decimal("157.2"), VND: new Decimal("26000"),
  TWD: new Decimal("32.1"), EUR: new Decimal("0.92"), THB: new Decimal("36.2"), GBP: new Decimal("0.79"), CHF: new Decimal("0.89"),
};
const stubProvider = (table: UsdTable | null, name = "oxr"): FxProvider => ({ name, getUsdTable: async () => table });
const noDefaults: TripDefaultsPort = { getRate: async () => null, upsertRate: async () => {} };
const baseInput = (over: Partial<FxInput> = {}): FxInput => ({
  localMinor: minor(100000n), localCurrency: "THB" as CurrencyCode, settlementCurrency: "KRW" as CurrencyCode,
  date: "2026-08-04", localExp: 2, settleExp: 0, tripId: "t1", ...over,
});

describe("resolveFx 4단계 체인", () => {
  it("⓪ identity: base==quote → rate=1, settlement=local, source=identity", async () => {
    const r = await resolveFx(baseInput({ localCurrency: "KRW" as CurrencyCode, localExp: 0 }), {
      providers: [stubProvider(null)], cache: new MemoryCache(), tripDefaults: noDefaults,
    });
    expect(isResolved(r) && r.exchange_rate_source).toBe("identity");
    expect(isResolved(r) && r.settlement_amount).toBe(100000n);
    expect(isResolved(r) && r.fallbackWarning).toBe(false);
  });
  it("① manual: 입력 rate 우선, source=manual", async () => {
    const r = await resolveFx(baseInput({ manualRate: "37.9" }), {
      providers: [stubProvider(null)], cache: new MemoryCache(), tripDefaults: noDefaults,
    });
    expect(isResolved(r) && r.exchange_rate_source).toBe("manual");
    expect(isResolved(r) && r.settlement_amount).toBe(37900n);
  });
  it("③ provider: 성공 → source=auto·provenance·캐시 저장", async () => {
    const cache = new MemoryCache();
    const r = await resolveFx(baseInput(), { providers: [stubProvider(FULL)], cache, tripDefaults: noDefaults });
    expect(isResolved(r) && r.exchange_rate_source).toBe("auto");
    expect(isResolved(r) && r.exchange_rate_provider).toBe("oxr");
    expect(isResolved(r) && r.settlement_amount).toBe(36478n); // 100000 × (1320.5/36.2=36.4779005525) × 10^-2 = 36477.9 → 36478
    expect(isResolved(r) && r.exchange_rate).toBe("36.4779005525");
    expect(await cache.getUsdTable("2026-08-04")).not.toBeNull(); // 캐시·last_known 갱신
  });
  it("② cache HIT: provider 호출 없이 auto", async () => {
    const cache = new MemoryCache();
    await cache.setUsdTable("2026-08-04", { table: FULL, provider: "oxr", tableDate: "2026-08-04", fetchedAt: "2026-08-04T00:00:00Z" }, 60);
    let called = false;
    const p: FxProvider = { name: "oxr", getUsdTable: async () => { called = true; return null; } };
    const r = await resolveFx(baseInput(), { providers: [p], cache, tripDefaults: noDefaults });
    expect(called).toBe(false);
    expect(isResolved(r) && r.exchange_rate_source).toBe("auto");
  });
  it("③ failover: primary null → secondary", async () => {
    const r = await resolveFx(baseInput(), {
      providers: [stubProvider(null, "oxr"), stubProvider(FULL, "currencyapi")], cache: new MemoryCache(), tripDefaults: noDefaults,
    });
    expect(isResolved(r) && r.exchange_rate_provider).toBe("currencyapi");
  });
  it("④ last_known: provider 전부 실패, max-age 이내 → last_known(warning)", async () => {
    const cache = new MemoryCache();
    await cache.setLastKnown({ table: FULL, provider: "oxr", tableDate: "2026-08-01", fetchedAt: "2026-08-01T00:00:00Z" });
    const r = await resolveFx(baseInput({ date: "2026-08-04" }), { providers: [stubProvider(null)], cache, tripDefaults: noDefaults });
    expect(isResolved(r) && r.exchange_rate_source).toBe("last_known");
    expect(isResolved(r) && r.fallbackWarning).toBe(true);
  });
  it("④ last_known max-age 초과 → 강등", async () => {
    const cache = new MemoryCache();
    await cache.setLastKnown({ table: FULL, provider: "oxr", tableDate: "2026-07-01", fetchedAt: "x" });
    const r = await resolveFx(baseInput({ date: "2026-08-04" }), { providers: [stubProvider(null)], cache, tripDefaults: { getRate: async () => "37.9", upsertRate: async () => {} } });
    expect(isResolved(r) && r.exchange_rate_source).toBe("trip_default"); // last_known 건너뜀
  });
  it("⑤ trip_default: 전부 실패 + default 존재 → trip_default(warning)", async () => {
    const r = await resolveFx(baseInput(), {
      providers: [stubProvider(null)], cache: new MemoryCache(),
      tripDefaults: { getRate: async () => "37.9", upsertRate: async () => {} },
    });
    expect(isResolved(r) && r.exchange_rate_source).toBe("trip_default");
    expect(isResolved(r) && r.settlement_amount).toBe(37900n);
  });
  it("⑥ 전부 실패 → needsManual", async () => {
    const r = await resolveFx(baseInput(), { providers: [stubProvider(null)], cache: new MemoryCache(), tripDefaults: noDefaults });
    expect("needsManual" in r && r.needsManual).toBe(true);
  });
  it("결정성: 동일 입력+고정 now → 동일 결과 (BigInt-safe 비교, finding #3)", async () => {
    const now = () => new Date("2026-08-04T12:00:00.000Z");
    const mk = () => resolveFx(baseInput(), { providers: [stubProvider(FULL)], cache: new MemoryCache(), tripDefaults: noDefaults, now });
    const norm = (r: FxResult) => (isResolved(r) ? { ...r, settlement_amount: r.settlement_amount.toString() } : r);
    expect(norm(await mk())).toEqual(norm(await mk()));
  });

  it("캐시 장애(throwing CachePort) → provider 경로 완주 (fail-open, finding #1)", async () => {
    const boom: CachePort = {
      getUsdTable: async () => { throw new Error("redis down"); },
      setUsdTable: async () => { throw new Error("redis down"); },
      getLastKnown: async () => { throw new Error("redis down"); },
      setLastKnown: async () => { throw new Error("redis down"); },
    };
    const r = await resolveFx(baseInput(), { providers: [stubProvider(FULL)], cache: boom, tripDefaults: noDefaults });
    expect(isResolved(r) && r.exchange_rate_source).toBe("auto");
  });
  it("manual 무효(0·garbage) → ValidationError (finding #2)", async () => {
    const deps = { providers: [stubProvider(null)], cache: new MemoryCache(), tripDefaults: noDefaults };
    await expect(resolveFx(baseInput({ manualRate: "0" }), deps)).rejects.toThrow(ValidationError);
    await expect(resolveFx(baseInput({ manualRate: "abc" }), deps)).rejects.toThrow(ValidationError);
  });
  it("trip_default 손상(0) → 건너뜀 → needsManual (finding #2)", async () => {
    const r = await resolveFx(baseInput(), {
      providers: [stubProvider(null)], cache: new MemoryCache(),
      tripDefaults: { getRate: async () => "0", upsertRate: async () => {} },
    });
    expect("needsManual" in r && r.needsManual).toBe(true);
  });
  it("오염 캐시(통화 누락) → miss로 fall-through → provider (finding #2 pass2)", async () => {
    const cache = new MemoryCache();
    await cache.setUsdTable("2026-08-04", { table: { USD: new Decimal(1), THB: new Decimal("36.2") }, provider: "x", tableDate: "2026-08-04", fetchedAt: "x" }, 60); // KRW 없음
    const r = await resolveFx(baseInput(), { providers: [stubProvider(FULL)], cache, tripDefaults: noDefaults });
    expect(isResolved(r) && r.exchange_rate_source).toBe("auto");
    expect(isResolved(r) && r.exchange_rate_provider).toBe("oxr"); // provider로 fall-through
  });
  it("오염 last_known(통화 누락) → 건너뜀 → needsManual (finding #2 pass2)", async () => {
    const cache = new MemoryCache();
    await cache.setLastKnown({ table: { USD: new Decimal(1), THB: new Decimal("36.2") }, provider: "x", tableDate: "2026-08-04", fetchedAt: "x" });
    const r = await resolveFx(baseInput({ date: "2026-08-04" }), { providers: [stubProvider(null)], cache, tripDefaults: noDefaults });
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
    await resolveFx(baseInput(), { providers: [stubProvider(FULL)], cache: new MemoryCache(), tripDefaults: td });
    expect(upserted).toBe(false); // 승격은 저장경로 in-tx 책임
  });

  it("mis-keyed 캐시(tableDate != date) → fall-through → provider (finding #2 pass4)", async () => {
    const cache = new MemoryCache();
    await cache.setUsdTable("2026-08-04", { table: FULL, provider: "x", tableDate: "2026-07-01", fetchedAt: "x" }, 60);
    const r = await resolveFx(baseInput(), { providers: [stubProvider(FULL)], cache, tripDefaults: noDefaults });
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
    const r = await resolveFx(baseInput(), { providers: [stubProvider(FULL)], cache: boom, tripDefaults: noDefaults, onWarn: (e) => events.push(e) });
    expect(isResolved(r) && r.exchange_rate_source).toBe("auto"); // fail-open
    expect(events).toContain("fx.cache.read_error");
  });
  it("모든 소스 실패 → onWarn('fx.needs_manual') (finding #3 pass4)", async () => {
    const events: string[] = [];
    const r = await resolveFx(baseInput(), { providers: [stubProvider(null)], cache: new MemoryCache(), tripDefaults: noDefaults, onWarn: (e) => events.push(e) });
    expect("needsManual" in r).toBe(true);
    expect(events).toContain("fx.needs_manual");
  });
});
```

**Step 2: 실패 확인** — Run: `bun run test src/modules/fx/fx.service.test.ts` · Expected: FAIL.

**Step 3: 구현**

```ts
import Decimal from "decimal.js";
import { convert, crossRate, normalizeRate, parsePositiveRate } from "./domain/convert.ts";
import type { CacheEntry, CachePort, FxInput, FxProvider, FxResult, RateSource, TripDefaultsPort, UsdTable } from "./fx.types.ts";
import { type Minor } from "../../core/money.ts";

const DEFAULT_MAX_AGE_DAYS = 7;

interface Deps {
  providers: FxProvider[];
  cache: CachePort;
  tripDefaults: TripDefaultsPort;
  maxAgeDays?: number;
  now?: () => Date; // 테스트 주입(기본 new Date)
  onWarn?: (event: string, detail?: unknown) => void; // 진단 훅(관측성, finding #3 pass4). 미주입=no-op. 운영은 pino 백엔드 주입
}

function dayDiff(a: string, b: string): number {
  return Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000));
}

function build(rate10: Decimal, input: FxInput, source: RateSource, prov: { provider: string | null; tableDate: string | null; fetchedAt: string | null }): FxResult {
  const settlement_amount = convert({ localMinor: input.localMinor, rate: rate10, localExp: input.localExp, settleExp: input.settleExp });
  return {
    settlement_amount,
    exchange_rate: rate10.toFixed(10),
    exchange_rate_date: input.date,
    exchange_rate_source: source,
    exchange_rate_provider: prov.provider,
    exchange_rate_table_date: prov.tableDate,
    exchange_rate_fetched_at: prov.fetchedAt,
    fallbackWarning: source === "last_known" || source === "trip_default",
  };
}
// 테이블 기반 rate 도출 — 오염/통화누락/범위초과는 miss로 강등 (finding #2 pass2)
const safeRate = (table: UsdTable, input: FxInput): Decimal | null => {
  try {
    return normalizeRate(crossRate(table, input.localCurrency, input.settlementCurrency));
  } catch {
    return null;
  }
};

// 캐시는 최적화지 진실원이 아님 → best-effort (finding #1 pass1). 실패는 onWarn 신호 + fail-open (finding #3 pass4)
const safeRead = async <T>(fn: () => Promise<T>, onWarn: Deps["onWarn"], event: string): Promise<T | null> => {
  try {
    return await fn();
  } catch (e) {
    onWarn?.(event, { error: String(e) });
    return null; // 장애/오염 → miss
  }
};
const safeWrite = async (fn: () => Promise<void>, onWarn: Deps["onWarn"], event: string): Promise<void> => {
  try {
    await fn();
  } catch (e) {
    onWarn?.(event, { error: String(e) }); // 신호 후 무시
  }
};

export async function resolveFx(input: FxInput, deps: Deps): Promise<FxResult> {
  const maxAge = deps.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  const { onWarn } = deps;

  // ⓪ identity
  if (input.localCurrency === input.settlementCurrency) {
    return build(new Decimal(1), input, "identity", { provider: null, tableDate: null, fetchedAt: null });
  }
  // ① manual (사용자 입력 — 무효 시 ValidationError 전파). parsePositiveRate=normalizeRate(10dp+검증)
  if (input.manualRate !== undefined) {
    return build(parsePositiveRate(input.manualRate), input, "manual", { provider: null, tableDate: null, fetchedAt: null });
  }
  // ② cache HIT (best-effort; tableDate==date 검증 — mis-keyed/오염 → fall-through, finding #2 pass2·pass4)
  const cached = await safeRead(() => deps.cache.getUsdTable(input.date), onWarn, "fx.cache.read_error");
  if (cached && cached.tableDate === input.date) {
    const rate = safeRate(cached.table, input);
    if (rate) return build(rate, input, "auto", { provider: cached.provider, tableDate: cached.tableDate, fetchedAt: cached.fetchedAt });
    onWarn?.("fx.cache.unusable_table", { date: input.date });
  } else if (cached) {
    onWarn?.("fx.cache.mis_keyed", { requested: input.date, tableDate: cached.tableDate });
  }
  // ③ provider (primary→secondary); 캐시 쓰기 best-effort. trip_default 승격은 저장경로(side-effect-free, #1 pass3)
  for (const p of deps.providers) {
    const table = await p.getUsdTable(input.date);
    if (!table) {
      onWarn?.("fx.provider.miss", { provider: p.name, date: input.date });
      continue;
    }
    const rate = safeRate(table, input);
    if (!rate) continue;
    const entry: CacheEntry = { table, provider: p.name, tableDate: input.date, fetchedAt: nowIso };
    const isPast = Date.parse(input.date) < Date.parse(nowIso.slice(0, 10));
    await safeWrite(() => deps.cache.setUsdTable(input.date, entry, isPast ? 60 * 60 * 24 * 30 : 60 * 60), onWarn, "fx.cache.write_error");
    await safeWrite(() => deps.cache.setLastKnown(entry), onWarn, "fx.cache.write_error");
    return build(rate, input, "auto", { provider: p.name, tableDate: input.date, fetchedAt: nowIso });
  }
  // ④ last_known (best-effort, max-age; 오염 → 건너뜀)
  const lk = await safeRead(() => deps.cache.getLastKnown(), onWarn, "fx.cache.read_error");
  if (lk && dayDiff(lk.tableDate, input.date) <= maxAge) {
    const rate = safeRate(lk.table, input);
    if (rate) return build(rate, input, "last_known", { provider: lk.provider, tableDate: lk.tableDate, fetchedAt: lk.fetchedAt });
  }
  // ⑤ trip_default (손상된 영속 rate는 건너뜀 → needsManual)
  const td = await deps.tripDefaults.getRate(input.tripId, input.localCurrency, input.settlementCurrency);
  if (td) {
    try {
      return build(parsePositiveRate(td), input, "trip_default", { provider: null, tableDate: null, fetchedAt: null });
    } catch {
      onWarn?.("fx.trip_default.corrupt", { tripId: input.tripId });
    }
  }
  // ⑥ needsManual — 모든 소스 실패(운영 신호, finding #3 pass4)
  onWarn?.("fx.needs_manual", { date: input.date, base: input.localCurrency, quote: input.settlementCurrency });
  return { needsManual: true };
}
```

> `Minor` import는 build 반환 타입용(convert가 Minor 반환). 사용 안 하면 제거.

**Step 4: 통과 확인** — Run: same · Expected: PASS (전 분기).

**Step 5: Commit**

```bash
bun run fmt && bun run check
git add src/modules/fx/fx.service.ts src/modules/fx/fx.service.test.ts
git commit -m "feat(fx): resolveFx 4단계 체인(identity/manual/cache/provider/last_known/trip_default/needsManual)"
```

---

## Task 8: trip_fx_defaults DB 제약 통합테스트

**Files:** Modify `tests/db/helpers.ts`(빌더·위반 추가) · `tests/db/schema-introspection.test.ts`(객체 추가) · `tests/db/constraints.test.ts`(negative 추가)

**Step 1: helpers.ts에 위반 inserter 추가** (기존 mkUser·mkTrip 재사용)

```ts
export async function insertDuplicateFxDefault(ctx: Ctx) {
  const u = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, u);
  const row = `insert into trip_fx_defaults (trip_id, base_currency, settlement_currency, rate) values ($1,'THB','KRW','37.9')`;
  await ctx.sql.unsafe(row, [trip]);
  await ctx.sql.unsafe(row, [trip]); // 복합 PK 중복 → 23505
}
export async function insertFxDefaultBadCurrency(ctx: Ctx) {
  const u = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, u);
  await ctx.sql.unsafe(`insert into trip_fx_defaults (trip_id, base_currency, settlement_currency, rate) values ($1,'XXX','KRW','1')`, [trip]); // currency FK → 23503
}
export async function insertFxDefaultNonPositiveRate(ctx: Ctx) {
  const u = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, u);
  await ctx.sql.unsafe(`insert into trip_fx_defaults (trip_id, base_currency, settlement_currency, rate) values ($1,'THB','KRW','0')`, [trip]); // fx_default_rate_pos → 23514
}
```
> `ctx.sql.unsafe(query, params)` (postgres.js parameterized). 또는 태그드 템플릿 사용.

**Step 2: introspection 테스트 보강** — `schema-introspection.test.ts`에 추가:
- INDEXES/PK: trip_fx_defaults 복합 PK 존재(`PRIMARY KEY (trip_id, base_currency, settlement_currency)`).
- cascade required에 `trip_fx_defaults->trips` 추가(trip_id→trips cascade).

```ts
it("trip_fx_defaults 복합 PK 존재", async () => {
  const rows = await ctx.sql`select conrelid::regclass::text as tbl, pg_get_constraintdef(oid) as def from pg_constraint where contype='p'`;
  const def = (rows.find((r) => (r.tbl as string).replace(/^public\./, "") === "trip_fx_defaults")?.def as string ?? "").replace(/"/g, "");
  expect(def).toContain("PRIMARY KEY (trip_id, base_currency, settlement_currency)");
});
```
그리고 cascade 테스트 `required` 배열에 `"trip_fx_defaults->trips"` 추가. **CHECKS 배열에 `"fx_default_rate_pos"` 추가**(finding #2).

**Step 3: constraints 테스트 보강** — `constraints.test.ts` import에 `insertDuplicateFxDefault·insertFxDefaultBadCurrency·insertFxDefaultNonPositiveRate` 추가 + it:
```ts
it("trip_fx_defaults 복합 PK 중복 거부", () => expectViolation(() => insertDuplicateFxDefault(ctx), "23505"));
it("trip_fx_defaults 잘못된 통화 FK 거부", () => expectViolation(() => insertFxDefaultBadCurrency(ctx), "23503"));
it("trip_fx_defaults rate<=0 거부", () => expectViolation(() => insertFxDefaultNonPositiveRate(ctx), "23514", "fx_default_rate_pos"));
```

**Step 4: 통과 확인** — Run: `bun run test tests/db/` · Expected: 기존 26 + 신규 4(introspection 복합PK 1·constraints 3) = 30 pass.

**Step 5: Commit**

```bash
bun run fmt
git add tests/db
git commit -m "test(db): trip_fx_defaults 제약 통합테스트(복합 PK·currency FK·trip cascade)"
```

---

## 완료 기준 (DoD)
- [ ] `bun add` 3종(decimal.js·ofetch·ioredis)+@testcontainers/redis 설치, `bun install` 성공
- [ ] `bun run check` PASS (oxlint+oxfmt+tsc)
- [ ] `bun run test` PASS (기반 47 + FX: convert·provider·cache(testcontainers redis)·trip-defaults·resolveFx·DB 제약)
- [ ] `db:generate`→`db:migrate`가 깨끗한 PG16에 0000+0001 클린 적용, `db:generate` 재실행 idempotent
- [ ] `git status` clean, 커밋 한국어·AI 마커 없음·허용 type만
- [ ] **pre-deploy 인수(저장경로 통합/배포 前, finding #2 pass5):** opt-in 실계약 smoke를 실 OXR·currencyapi 키로 1회 실행·증거 기록(9통화·TWD/VND historical 확인). 슬라이스 CI엔 키 불요(skip 유지)

## 후속 슬라이스 예고
인증·초대 런타임(Better Auth 배선·초대 CAS·CSRF) → API 라우트+DTO+OpenAPI 생성(+resolveFx를 expense 저장경로에 통합·card_billed 분기·편집 재계산·trip_default 승격 in-tx) → 레이트리밋/관측 슬라이스(provider single-flight·비용 상한·onWarn→pino/메트릭) → (trip-mate 레포) 프론트엔드.

---

## Adversarial review dispositions

Codex 적대적 리뷰(working-tree 모드) **5 passes**. **총 14건 finding 전부 Accept·반영**(2건은 분할: pass3 #1 승격 side-effect 제거+저장경로 이관, pass5 #1 monotonic 반영+stampede defer). high 추세 3→2→1→2→1로, 4·5 pass는 코어 정합성이 아니라 **운영/배포 차원**(provider 계약·관측성·rollback)으로 이동. 최종 verdict는 `needs-attention`(pass5 3건)이었고 그 3건 반영 후 **사용자 결정으로 확정**(확정 시점 미반영 정합성 HIGH 0; stampede single-flight은 비용-scope로 후속 criteria와 함께 defer). 이 섹션은 확정 후 감사 추적이며 재리뷰 대상이 아니다.

| pass | # | finding | sev | 결정 | 반영 |
|---|---|---|---|---|---|
| 1 | 1 | 캐시 장애가 크리티컬 패스 | high | Accept | resolveFx 캐시 best-effort fail-open + throwing CachePort 테스트 |
| 1 | 2 | manual/trip_default rate 미검증 | high | Accept | parsePositiveRate(finite·>0) + `trip_fx_defaults.rate>0` CHECK |
| 1 | 3 | Task7 테스트 내부모순(기대값·BigInt JSON) | high | Accept | provider 기대 36478n·exchange_rate 명시·BigInt-safe 비교 |
| 2 | 1 | 검증이 10dp 반올림 前 | high | Accept | normalizeRate(10dp 후 >0·<10^10) |
| 2 | 2 | 오염 캐시가 fallback 대신 중단 | high | Accept | safeRate(crossRate 오염→miss fall-through) |
| 2 | 3 | provider 성공이 trip_default 미적재 | med | Accept | 승격 추가(→pass3 #1에서 저장경로 in-tx로 재이관) |
| 3 | 1 | 승격이 비트랜잭션·last-writer-wins | high | Accept | resolveFx **side-effect-free**, 승격은 저장경로 post-save·in-tx(onConflictDoNothing 첫-auto) |
| 3 | 2 | Drizzle repo 제네릭 타입 불일치 | med | Accept | `DrizzleTripDefaults<T extends Record<string,unknown>>` |
| 4 | 1 | 실 provider 계약 미검증(mock-only) | high | Accept | opt-in 실계약 smoke(`skipIf` 키 없음) → pass5 #2서 pre-deploy 인수로 승격 |
| 4 | 2 | 캐시 hit가 stale/mis-keyed 신뢰 | high | Accept | cache hit `tableDate===date` 가드 |
| 4 | 3 | 의존성 실패 silent(진단 불가) | med | Accept | `onWarn` 진단 훅 + 실패 신호(fail-open 유지) |
| 5 | 1 | 동시 miss 비조정(stampede·out-of-order) | high | **Accept(분할)** | last_known **monotonic** 반영 / stampede single-flight은 레이트리밋 슬라이스 defer+criteria |
| 5 | 2 | 실계약이 opt-in뿐 | med | Accept | opt-in smoke를 **pre-deploy 인수 기준**으로 승격(DoD) |
| 5 | 3 | 마이그레이션 rollback 부재 | med | Accept | additive 테이블 rollback/backout 절(Task 5) |

**최종 pass5 `summary`:** "still leaves expensive cache/provider failure modes and migration recovery underspecified" → monotonic last_known·pre-deploy 인수기준·additive rollback 절로 해소(stampede는 비용-scope defer).

---

## Execution directives
- **Skill:** `executing-plans`로 **별도 세션, 이 워크트리**(`~/workspace/trip-mate-api/.worktrees/fx-pipeline`, 브랜치 `feat/fx-pipeline`)에서 task-by-task 구현.
- **연속 실행:** 일상 리뷰로 멈추지 말 것. 진짜 블로커(의존성 부재·반복 실패 검증·모순 지시·치명적 plan 공백)에서만 정지. Docker 데몬 필요(testcontainers PG16·redis).
- **커밋 — 직접 적용, `Skill(commit)` 호출 금지:**
  - 한국어 메시지, **AI 마커 금지**(`🤖`·`Co-Authored-By: Claude` 등).
  - 형식 `<type>(<scope>): 한국어 설명`. **type은 `feat`/`fix`/`refactor`/`docs`/`style`/`test`/`chore`만**.
  - 그룹화: 같은 모듈 dir·같은 목적 together; config·테스트·문서·독립 변경은 각자 커밋. 각 Task Commit 스텝에서 현재 `feat/fx-pipeline` 워크트리에 직접.
  - 포맷: 새 .ts 후 `bun run fmt`→`bun run check`. oxfmt가 `.md`·`src/db/migrations/**` 제외(설정 기존). 생성물(마이그레이션 meta) oxlint/oxfmt ignore 적용됨.
- **시작점:** Task 0(의존성)→8 순서. SSOT 충돌 시 `docs/plans/`의 FX 기술설계/슬라이스 설계가 본 plan보다 우선.
