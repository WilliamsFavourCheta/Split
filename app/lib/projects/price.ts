/** Convert an exact decimal sqrtPriceX96 into a display-only ETH/token number. */
export function sqrtPriceX96ToEthPerToken(value: string) {
  if (!/^\d{1,78}$/.test(value)) return null;
  const sqrtPriceX96 = BigInt(value);
  if (sqrtPriceX96 === BigInt(0)) return null;
  // v4's native ETH is currency0 and SPLIT's 18-decimal token is currency1.
  // sqrtPriceX96 therefore encodes token/ETH; invert it for ETH/token.
  // 80 decimal guard digits keep even TickMath's highest valid sqrt price
  // non-zero before conversion to a display-only JavaScript number.
  const fixedPoint = ((BigInt(1) << BigInt(192)) * (BigInt(10) ** BigInt(80))) / (sqrtPriceX96 * sqrtPriceX96);
  const priceEth = Number(fixedPoint) / 1e80;
  return Number.isFinite(priceEth) && priceEth > 0 ? priceEth : null;
}

export type PriceSnapshot = { priceEth: number; snapshotAt: string; eventId?: string; blockNumber?: number; logIndex?: number };
export type UsdQuote = { priceUsd: number; snapshotAt: string };
export type ChartMode = "priceUsd" | "marketCapUsd" | "priceEth" | "marketCapEth";
export type ChartPoint = { value: number; snapshotAt: string };
export const SPLIT_FIXED_SUPPLY_TOKENS = 1_000_000_000;

/** Fixed-supply, fully diluted market cap quoted in native ETH. */
export function priceToMarketCapEth(priceEth: number) {
  const value = priceEth * SPLIT_FIXED_SUPPLY_TOKENS;
  return Number.isFinite(value) && value > 0 ? value : null;
}

export type PricePeriod = "1D" | "7D" | "30D" | "ALL";

/** Carry the last pool price forward between swaps, and join sampled ETH/USD
 * quotes by timestamp so USD history never uses today's rate for old trades. */
export function buildChartSeries(snapshots: PriceSnapshot[], quotes: UsdQuote[], period: PricePeriod, mode: ChartMode, nowMs: number): ChartPoint[] {
  const events = snapshots.filter((point) => Number.isFinite(point.priceEth) && point.priceEth > 0 && Number.isFinite(Date.parse(point.snapshotAt)))
    .sort((a, b) => Date.parse(a.snapshotAt) - Date.parse(b.snapshotAt) || (a.blockNumber ?? 0) - (b.blockNumber ?? 0) || (a.logIndex ?? 0) - (b.logIndex ?? 0));
  if (!events.length) return [];
  const usd = mode.endsWith("Usd");
  const rates = usd ? quotes.filter((quote) => Number.isFinite(quote.priceUsd) && quote.priceUsd > 0 && Number.isFinite(Date.parse(quote.snapshotAt)))
    .sort((a, b) => Date.parse(a.snapshotAt) - Date.parse(b.snapshotAt)) : [];
  if (usd && !rates.length) return [];

  const duration = { "1D": 86_400_000, "7D": 604_800_000, "30D": 2_592_000_000 } as const;
  const firstEvent = Date.parse(events[0].snapshotAt);
  const start = period === "ALL" ? firstEvent : Math.max(firstEvent, nowMs - duration[period]);
  const times = new Set<number>([start, nowMs]);
  for (const event of events) {
    const at = Date.parse(event.snapshotAt);
    if (at >= start && at <= nowMs) times.add(at);
  }
  if (usd) for (const rate of rates) {
    const at = Date.parse(rate.snapshotAt);
    if (at >= start && at <= nowMs) times.add(at);
  }

  let eventIndex = 0;
  let rateIndex = 0;
  let tokenPrice: number | null = null;
  let ethUsd: number | null = null;
  const points: ChartPoint[] = [];
  for (const at of [...times].sort((a, b) => a - b)) {
    while (eventIndex < events.length && Date.parse(events[eventIndex].snapshotAt) <= at) tokenPrice = events[eventIndex++].priceEth;
    while (rateIndex < rates.length && Date.parse(rates[rateIndex].snapshotAt) <= at) ethUsd = rates[rateIndex++].priceUsd;
    if (tokenPrice === null || (usd && ethUsd === null)) continue;
    const base = mode.startsWith("marketCap") ? tokenPrice * SPLIT_FIXED_SUPPLY_TOKENS : tokenPrice;
    const value = usd ? base * ethUsd! : base;
    if (Number.isFinite(value) && value > 0) points.push({ value, snapshotAt: new Date(at).toISOString() });
  }
  return points;
}

export function selectPriceSnapshots(snapshots: PriceSnapshot[], period: PricePeriod) {
  if (period === "ALL" || snapshots.length === 0) return snapshots;
  const ranges = { "1D": 86_400_000, "7D": 604_800_000, "30D": 2_592_000_000 };
  const latest = new Date(snapshots.at(-1)!.snapshotAt).getTime();
  if (!Number.isFinite(latest)) return [];
  return snapshots.filter((point) => {
    const time = new Date(point.snapshotAt).getTime();
    return Number.isFinite(time) && time >= latest - ranges[period];
  });
}
