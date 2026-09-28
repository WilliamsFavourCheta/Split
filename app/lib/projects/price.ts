/** Convert an exact decimal sqrtPriceX96 into a display-only ETH/token number. */
export function sqrtPriceX96ToEthPerToken(value: string) {
  if (!/^\d{1,78}$/.test(value)) return null;
  const sqrtPriceX96 = BigInt(value);
  if (sqrtPriceX96 === BigInt(0)) return null;
  const fixedPoint = ((BigInt(1) << BigInt(192)) * (BigInt(10) ** BigInt(36))) / (sqrtPriceX96 * sqrtPriceX96);
  const priceEth = Number(fixedPoint) / 1e36;
  return Number.isFinite(priceEth) && priceEth > 0 ? priceEth : null;
}
