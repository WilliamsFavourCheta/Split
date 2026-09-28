import type { PoolPriceUpdatedEvent, ProtocolLaunchFeesClaimedEvent, SplitIndexerEvent, TokenLaunchedEvent } from "./types";

/** Canonical launch state is deliberately part of every replayed project upsert. */
export function launchProjectUpsert(event: TokenLaunchedEvent) {
  return {
    chain_id: event.chainId,
    token_address: event.tokenAddress.toLowerCase(),
    creator_address: event.creatorAddress.toLowerCase(),
    name: event.name,
    symbol: event.symbol,
    status: "live" as const,
    canonical: true,
    launch_tx_hash: event.txHash.toLowerCase(),
    launch_block_number: event.blockNumber,
    launch_block_hash: event.blockHash.toLowerCase(),
    launched_at: event.blockTimestamp ?? null,
    pool_id: event.poolId.toLowerCase(),
    quote_asset: event.quoteAsset.toLowerCase(),
    total_supply_raw: event.totalSupply,
    seed_token_amount_raw: event.seedTokenAmount,
    seed_quote_amount_raw: event.seedQuoteAmount,
    sqrt_price_x96: event.sqrtPriceX96,
    lp_fee: event.lpFee,
  };
}

/** A global launch-fee claim has no project/pool; retain only encoded fields and exact strings. */
export function protocolLaunchFeeClaimRecord(event: ProtocolLaunchFeesClaimedEvent) {
  return {
    chain_id: event.chainId,
    recipient_address: event.recipientAddress.toLowerCase(),
    tx_hash: event.txHash.toLowerCase(),
    log_index: event.logIndex,
    block_number: event.blockNumber,
    block_hash: event.blockHash.toLowerCase(),
    block_timestamp: event.blockTimestamp ?? null,
    raw_amount: event.rawAmount,
    canonical: true,
  };
}

export function projectPriceEventRecord(event: PoolPriceUpdatedEvent, projectId: string) {
  return {
    project_id: projectId,
    chain_id: event.chainId,
    pool_id: event.poolId.toLowerCase(),
    tx_hash: event.txHash.toLowerCase(),
    log_index: event.logIndex,
    block_number: event.blockNumber,
    block_hash: event.blockHash.toLowerCase(),
    block_timestamp: event.blockTimestamp ?? null,
    sqrt_price_x96: event.sqrtPriceX96,
    source: event.source,
    canonical: true as const,
  };
}

export function sqrtPriceX96ToEthPerToken(value: string) {
  if (!/^\d{1,78}$/.test(value)) return null;
  const sqrtPriceX96 = BigInt(value);
  if (sqrtPriceX96 === BigInt(0)) return null;
  const fixedPoint = ((BigInt(1) << BigInt(192)) * (BigInt(10) ** BigInt(36))) / (sqrtPriceX96 * sqrtPriceX96);
  const priceEth = Number(fixedPoint) / 1e36;
  return Number.isFinite(priceEth) && priceEth > 0 ? priceEth : null;
}

/** Make launches visible before dependent events within each replayed batch. */
export async function replayEventsInCanonicalOrder(
  events: SplitIndexerEvent[],
  apply: (event: SplitIndexerEvent) => Promise<unknown>,
) {
  let launchCount = 0;
  for (const event of events) {
    if (event.type !== "TokenLaunched") continue;
    await apply(event);
    launchCount += 1;
  }
  for (const event of events) {
    if (event.type === "TokenLaunched") continue;
    await apply(event);
  }
  return launchCount;
}

/** Find a common ancestor using hashes saved from the previously indexed branch. */
export async function findVerifiedCommonAncestor(input: {
  startBlock: bigint;
  checkpointBlock: bigint;
  checkpoints: Array<{ block_number: number; block_hash: string }>;
  getCanonicalHash: (blockNumber: bigint) => Promise<string>;
}) {
  const minimumAncestor = input.startBlock > BigInt(0) ? input.startBlock - BigInt(1) : BigInt(0);
  const candidates = input.checkpoints
    .filter((row) => {
      const block = BigInt(row.block_number);
      return block >= minimumAncestor && block < input.checkpointBlock && /^0x[\da-f]{64}$/i.test(row.block_hash);
    })
    .sort((a, b) => b.block_number - a.block_number);

  for (const candidate of candidates) {
    const blockNumber = BigInt(candidate.block_number);
    const actualHash = await input.getCanonicalHash(blockNumber);
    if (actualHash.toLowerCase() === candidate.block_hash.toLowerCase()) {
      return { ancestorBlock: blockNumber, replayFrom: blockNumber + BigInt(1) };
    }
  }
  throw new Error("No previously indexed checkpoint matches the current chain; indexing remains halted before rollback.");
}

/** Roll back immediately after a verified ancestor, even if replay must wait for finality. */
export async function prepareDeepReorgRecovery(input: {
  ancestorBlock: bigint;
  finalizedHead: bigint;
  batchSize: bigint;
  rollbackFrom: (blockNumber: number) => Promise<void>;
}) {
  const from = input.ancestorBlock + BigInt(1);
  const to = boundedBatchEnd(from, input.finalizedHead, input.batchSize);
  await input.rollbackFrom(Number(from));
  return {
    ancestorBlock: input.ancestorBlock,
    from,
    to,
    status: from > to ? "waiting-for-finality" as const : "replay" as const,
  };
}

/** Reject a log batch if any returned event was emitted on a different branch. */
export function assertEventBlockHashesCanonical(
  events: Array<{ blockNumber: number; blockHash: string }>,
  canonicalHashes: ReadonlyMap<number, string>,
) {
  for (const event of events) {
    const canonicalHash = canonicalHashes.get(event.blockNumber);
    if (!canonicalHash) throw new Error(`Missing canonical block hash for event block ${event.blockNumber}.`);
    if (canonicalHash.toLowerCase() !== event.blockHash.toLowerCase()) {
      throw new Error(`RPC log block hash mismatch at block ${event.blockNumber}; refusing to index this batch.`);
    }
  }
}

/** A stable range-end hash ties the fetched log set to its checkpoint branch. */
export function assertRangeEndHashStable(blockNumber: bigint, before: string, after: string) {
  if (before.toLowerCase() !== after.toLowerCase()) {
    throw new Error(`RPC chain changed while reading finalized block range ending at ${blockNumber}; refusing to index this batch.`);
  }
}

export function boundedBatchEnd(from: bigint, finalizedHead: bigint, batchSize: bigint) {
  const sizeLimitedEnd = from + batchSize - BigInt(1);
  return finalizedHead < sizeLimitedEnd ? finalizedHead : sizeLimitedEnd;
}
