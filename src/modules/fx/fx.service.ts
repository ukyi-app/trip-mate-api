import Decimal from "decimal.js";
import { convert, crossRate, normalizeRate, parsePositiveRate } from "./domain/convert.ts";
import type {
  CacheEntry,
  CachePort,
  FxInput,
  FxProvider,
  FxResult,
  RateSource,
  TripDefaultsPort,
  UsdTable,
} from "./fx.types.ts";

const DEFAULT_MAX_AGE_DAYS = 7;

export interface FxDeps {
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

function build(
  rate10: Decimal,
  input: FxInput,
  source: RateSource,
  prov: { provider: string | null; tableDate: string | null; fetchedAt: string | null },
): FxResult {
  const settlement_amount = convert({
    localMinor: input.localMinor,
    rate: rate10,
    localExp: input.localExp,
    settleExp: input.settleExp,
  });
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
const safeRead = async <T>(
  fn: () => Promise<T>,
  onWarn: FxDeps["onWarn"],
  event: string,
): Promise<T | null> => {
  try {
    return await fn();
  } catch (e) {
    onWarn?.(event, { error: String(e) });
    return null; // 장애/오염 → miss
  }
};
const safeWrite = async (
  fn: () => Promise<void>,
  onWarn: FxDeps["onWarn"],
  event: string,
): Promise<void> => {
  try {
    await fn();
  } catch (e) {
    onWarn?.(event, { error: String(e) }); // 신호 후 무시
  }
};

export async function resolveFx(input: FxInput, deps: FxDeps): Promise<FxResult> {
  const maxAge = deps.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  const { onWarn } = deps;

  // ⓪ identity
  if (input.localCurrency === input.settlementCurrency) {
    return build(new Decimal(1), input, "identity", {
      provider: null,
      tableDate: null,
      fetchedAt: null,
    });
  }
  // ① manual (사용자 입력 — 무효 시 ValidationError 전파). parsePositiveRate=normalizeRate(10dp+검증)
  if (input.manualRate !== undefined) {
    return build(parsePositiveRate(input.manualRate), input, "manual", {
      provider: null,
      tableDate: null,
      fetchedAt: null,
    });
  }
  // ② cache HIT (best-effort; tableDate==date 검증 — mis-keyed/오염 → fall-through, finding #2 pass2·pass4)
  const cached = await safeRead(
    () => deps.cache.getUsdTable(input.date),
    onWarn,
    "fx.cache.read_error",
  );
  if (cached && cached.tableDate === input.date) {
    const rate = safeRate(cached.table, input);
    if (rate)
      return build(rate, input, "auto", {
        provider: cached.provider,
        tableDate: cached.tableDate,
        fetchedAt: cached.fetchedAt,
      });
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
    await safeWrite(
      () => deps.cache.setUsdTable(input.date, entry, isPast ? 60 * 60 * 24 * 30 : 60 * 60),
      onWarn,
      "fx.cache.write_error",
    );
    await safeWrite(() => deps.cache.setLastKnown(entry), onWarn, "fx.cache.write_error");
    return build(rate, input, "auto", {
      provider: p.name,
      tableDate: input.date,
      fetchedAt: nowIso,
    });
  }
  // ④ last_known (best-effort, max-age; 오염 → 건너뜀)
  const lk = await safeRead(() => deps.cache.getLastKnown(), onWarn, "fx.cache.read_error");
  if (lk && dayDiff(lk.tableDate, input.date) <= maxAge) {
    const rate = safeRate(lk.table, input);
    if (rate)
      return build(rate, input, "last_known", {
        provider: lk.provider,
        tableDate: lk.tableDate,
        fetchedAt: lk.fetchedAt,
      });
  }
  // ⑤ trip_default (손상된 영속 rate는 건너뜀 → needsManual)
  const td = await deps.tripDefaults.getRate(
    input.tripId,
    input.localCurrency,
    input.settlementCurrency,
  );
  if (td) {
    try {
      return build(parsePositiveRate(td), input, "trip_default", {
        provider: null,
        tableDate: null,
        fetchedAt: null,
      });
    } catch {
      onWarn?.("fx.trip_default.corrupt", { tripId: input.tripId });
    }
  }
  // ⑥ needsManual — 모든 소스 실패(운영 신호, finding #3 pass4)
  onWarn?.("fx.needs_manual", {
    date: input.date,
    base: input.localCurrency,
    quote: input.settlementCurrency,
  });
  return { needsManual: true };
}
