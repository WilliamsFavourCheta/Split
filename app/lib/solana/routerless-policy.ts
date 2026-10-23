export type ProjectShares = { creator: number; liquidity: number; projectTreasury: number; community: number };

/** Calculations only. A SPLIT operator holds collected fees until confirmed payouts. */
export function calculateOperatorAllocation(raw: bigint, shares: ProjectShares) {
  if (raw < BigInt(0) || Object.values(shares).some((value) => !Number.isInteger(value) || value < 0 || value > 100)
    || Object.values(shares).reduce((sum, value) => sum + value, 0) !== 100) throw new Error("Invalid fee allocation.");
  const protocol = raw / BigInt(10);
  const project = raw - protocol;
  const creator = project * BigInt(shares.creator) / BigInt(100);
  const liquidity = project * BigInt(shares.liquidity) / BigInt(100);
  const projectTreasury = project * BigInt(shares.projectTreasury) / BigInt(100);
  const community = project - creator - liquidity - projectTreasury;
  return { protocol, creator, liquidity, projectTreasury, community };
}
