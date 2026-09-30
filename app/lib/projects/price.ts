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

export type PriceSnapshot = { priceEth: number; snapshotAt: string };
export const SPLIT_FIXED_SUPPLY_TOKENS = 1_000_000_000;

/** Fixed-supply, fully diluted market cap quoted in native ETH. */
export function priceToMarketCapEth(priceEth: number) {
  const value = priceEth * SPLIT_FIXED_SUPPLY_TOKENS;
  return Number.isFinite(value) && value > 0 ? value : null;
}

export type PricePeriod = "1D" | "7D" | "30D" | "ALL";

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
