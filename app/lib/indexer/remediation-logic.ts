import type { ProtocolLaunchFeesClaimedEvent, SplitIndexerEvent, TokenLaunchedEvent } from "./types";

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

/** Require an operator-verified common ancestor before rolling back beyond overlap. */
export function verifiedRecoveryStart(input: {
  startBlock: bigint;
  checkpointBlock: bigint;
  replayFrom: bigint;
  expectedAncestorHash: string;
  actualAncestorHash: string;
}) {
  const { startBlock, checkpointBlock, replayFrom, expectedAncestorHash, actualAncestorHash } = input;
  if (replayFrom < startBlock || replayFrom > checkpointBlock) {
    throw new Error("Recovery block must be at or after configured start and no later than the stale checkpoint.");
  }
  if (!/^0x[\da-f]{64}$/i.test(expectedAncestorHash) || actualAncestorHash.toLowerCase() !== expectedAncestorHash.toLowerCase()) {
    throw new Error(`Recovery ancestor hash mismatch at block ${replayFrom - BigInt(1)}; indexing remains halted.`);
  }
  return replayFrom;
}

export function boundedBatchEnd(from: bigint, finalizedHead: bigint, batchSize: bigint) {
  const sizeLimitedEnd = from + batchSize - BigInt(1);
  return finalizedHead < sizeLimitedEnd ? finalizedHead : sizeLimitedEnd;
}
