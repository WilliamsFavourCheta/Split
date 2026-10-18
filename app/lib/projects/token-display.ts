/** Display helpers for canonical token data. These never synthesize market values. */
export function formatTokenQuantity(raw: string | undefined, symbol: string) {
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) return "—";
  const value = Number(raw);
  if (!Number.isFinite(value)) return "—";
  const compact = value >= 1_000_000_000 ? `${(value / 1_000_000_000).toFixed(2)}B`
    : value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M`
      : value >= 1_000 ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)
        : new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(value);
  return `${compact} ${symbol}`;
}

export function formatEthPrice(value: number | null) {
  if (value === null || !Number.isFinite(value) || value <= 0) return "—";
  if (value < 1e-12) return `${value.toExponential(4)} ETH`;
  const decimals = value < 1 ? Math.min(12, Math.max(4, Math.ceil(-Math.log10(value)) + 2)) : 6;
  return `${value.toFixed(decimals).replace(/\.?0+$/, "")} ETH`;
}

export function formatEthAmount(value: string | undefined) {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return "—";
  return `${Number(value).toLocaleString("en-US", { maximumFractionDigits: 8 })} ETH`;
}

export function matchingProjectRoles(address: string | undefined, destinations: Array<{ label: string; address?: string }>) {
  if (!address) return [];
  return destinations.filter((destination) => destination.address?.toLowerCase() === address.toLowerCase()).map((destination) => destination.label);
}

export function projectCompletionPath(creator: string, wallet: string | undefined, metadataSaved: boolean, launchTx: string | undefined) {
  return !metadataSaved && wallet?.toLowerCase() === creator.toLowerCase() && /^0x[0-9a-fA-F]{64}$/.test(launchTx ?? "")
    ? `/launch/success?tx=${launchTx}` : null;
}

export function isProtocolTreasury(wallet: string | undefined, onchainTreasury: string | undefined) {
  return Boolean(wallet && onchainTreasury && wallet.toLowerCase() === onchainTreasury.toLowerCase());
}

export type CanonicalFeeAmount = { currency: string; rawAmount: string };
export type CanonicalAllocation = CanonicalFeeAmount & {
  protocol: string; creator: string; liquidity: string; treasury: string; community: string;
};

/** Group by currency before formatting: ETH and token fees must never be summed together. */
export function summarizeFeeActivity(accruals: CanonicalFeeAmount[], allocations: CanonicalAllocation[]) {
  const totals = new Map<string, { currency: string; accrued: bigint; routed: bigint; protocol: bigint; creator: bigint; liquidity: bigint; treasury: bigint; community: bigint }>();
  const entry = (currency: string) => {
    const key = currency.toLowerCase();
    if (!totals.has(key)) totals.set(key, { currency: key, accrued: BigInt(0), routed: BigInt(0), protocol: BigInt(0), creator: BigInt(0), liquidity: BigInt(0), treasury: BigInt(0), community: BigInt(0) });
    return totals.get(key)!;
  };
  for (const row of accruals) entry(row.currency).accrued += BigInt(row.rawAmount);
  for (const row of allocations) {
    const total = entry(row.currency);
    total.routed += BigInt(row.rawAmount);
    total.protocol += BigInt(row.protocol);
    total.creator += BigInt(row.creator);
    total.liquidity += BigInt(row.liquidity);
    total.treasury += BigInt(row.treasury);
    total.community += BigInt(row.community);
  }
  return Array.from(totals.values()).map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]),
  )) as Array<{ currency: string; accrued: string; routed: string; protocol: string; creator: string; liquidity: string; treasury: string; community: string }>;
}
