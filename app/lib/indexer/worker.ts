import "server-only";
import { getIndexerContracts, getBlockHash, getFinalizedEvents, indexerClient, RH_MAINNET_CHAIN_ID } from "./evm-source";
import {
  getIndexerCheckpoint,
  markReorgedEventsNoncanonical,
  saveIndexerCheckpoint,
  upsertAccrual,
  upsertAllocationEvent,
  upsertClaimEvent,
  upsertFeeConfiguration,
  upsertLaunch,
  upsertLiquidityCredit,
  upsertProtocolClaimEvent,
  upsertProtocolLaunchFeeClaim,
  upsertProtocolLaunchFee,
} from "./repository";
import type { SplitIndexerEvent } from "./types";
import { boundedBatchEnd, replayEventsInCanonicalOrder, verifiedRecoveryStart } from "./remediation-logic";
import { createIndexerSupabaseClient } from "../supabase/server";

function positiveInteger(value: string | undefined, fallback: number, name: string) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive safe integer.`);
  return parsed;
}

async function tokenForPool(poolId: string, newlyIndexed: Map<string, string>) {
  const key = poolId.toLowerCase();
  const token = newlyIndexed.get(key);
  if (token) return token;
  const { data, error } = await createIndexerSupabaseClient()
    .from("projects")
    .select("token_address")
    .eq("chain_id", RH_MAINNET_CHAIN_ID)
    .eq("pool_id", key)
    .eq("canonical", true)
    .maybeSingle();
  if (error) throw new Error(`Pool-to-project index lookup failed: ${error.message}`);
  if (!data) throw new Error(`No canonical launch is indexed for pool ${key}.`);
  return data.token_address;
}

async function applyEvent(event: SplitIndexerEvent, tokens: Map<string, string>) {
  if (event.type === "TokenLaunched") {
    const projectId = await upsertLaunch(event);
    tokens.set(event.poolId.toLowerCase(), event.tokenAddress.toLowerCase());
    return projectId;
  }
  if (event.type === "LaunchProtocolFeeCharged") {
    await upsertProtocolLaunchFee(event);
    return undefined;
  }
  if (event.type === "ProtocolLaunchFeesClaimed") {
    await upsertProtocolLaunchFeeClaim(event);
    return undefined;
  }
  const token = await tokenForPool(event.poolId, tokens);
  if (event.type === "SplitConfigured") await upsertFeeConfiguration(event, token);
  else if (event.type === "FeesAccrued") await upsertAccrual(event, token);
  else if (event.type === "FeesAllocated") await upsertAllocationEvent(event, token);
  else if (event.type === "FeesClaimed") await upsertClaimEvent(event, token);
  else if (event.type === "ProtocolFeesClaimed") await upsertProtocolClaimEvent(event, token);
  else await upsertLiquidityCredit(event, token);
  return undefined;
}

/**
 * Poll one bounded, finalized range. Replay is idempotent; deep checkpoint
 * mismatches halt before rollback until an operator verifies a common ancestor.
 */
export async function runIndexerBatch() {
  const contracts = getIndexerContracts();
  const startBlock = BigInt(positiveInteger(process.env.SPLIT_INDEXER_START_BLOCK, 1, "SPLIT_INDEXER_START_BLOCK"));
  const finality = BigInt(positiveInteger(process.env.SPLIT_INDEXER_FINALITY_BLOCKS, 64, "SPLIT_INDEXER_FINALITY_BLOCKS"));
  const reorgWindow = BigInt(positiveInteger(process.env.SPLIT_INDEXER_REORG_WINDOW, 128, "SPLIT_INDEXER_REORG_WINDOW"));
  const batchSize = BigInt(Math.min(positiveInteger(process.env.SPLIT_INDEXER_BATCH_BLOCKS, 500, "SPLIT_INDEXER_BATCH_BLOCKS"), 2_000));
  const head = await indexerClient.getBlockNumber();
  if (head <= finality) return { chainId: RH_MAINNET_CHAIN_ID, indexedThrough: null, events: 0, status: "waiting-for-finality" as const };
  const finalizedHead = head - finality;
  const checkpoint = await getIndexerCheckpoint(RH_MAINNET_CHAIN_ID, contracts.factory);
  let from = checkpoint
    ? BigInt(Math.max(Number(startBlock), checkpoint.last_processed_block - Number(reorgWindow) + 1))
    : startBlock;
  let to = boundedBatchEnd(from, finalizedHead, batchSize);

  if (checkpoint?.last_processed_block_hash) {
    const savedBlock = BigInt(checkpoint.last_processed_block);
    const canonicalHash = await getBlockHash(savedBlock);
    if (canonicalHash.toLowerCase() !== checkpoint.last_processed_block_hash.toLowerCase()) {
      const recoveryFrom = process.env.SPLIT_INDEXER_RECOVERY_FROM_BLOCK;
      const expectedAncestorHash = process.env.SPLIT_INDEXER_RECOVERY_ANCESTOR_HASH;
      if (!recoveryFrom || !expectedAncestorHash) {
        throw new Error(
          `Deep reorg/checkpoint mismatch at block ${savedBlock}. Indexing halted before rollback. ` +
          "Verify a common ancestor and set SPLIT_INDEXER_RECOVERY_FROM_BLOCK to ancestor+1 plus " +
          "SPLIT_INDEXER_RECOVERY_ANCESTOR_HASH, then retry.",
        );
      }
      const candidateFrom = BigInt(positiveInteger(recoveryFrom, 0, "SPLIT_INDEXER_RECOVERY_FROM_BLOCK"));
      const ancestorNumber = candidateFrom - BigInt(1);
      const actualAncestorHash = await getBlockHash(ancestorNumber);
      from = verifiedRecoveryStart({
        startBlock,
        checkpointBlock: savedBlock,
        replayFrom: candidateFrom,
        expectedAncestorHash,
        actualAncestorHash,
      });
      to = boundedBatchEnd(from, finalizedHead, batchSize);
    }
  }
  if (from > to) return { chainId: RH_MAINNET_CHAIN_ID, indexedThrough: Number(to), events: 0, status: "current" as const };

  await markReorgedEventsNoncanonical(RH_MAINNET_CHAIN_ID, Number(from));
  const events = await getFinalizedEvents(from, to);
  const tokens = new Map<string, string>();
  // TokenLaunched is emitted last in launch(), after its SplitConfigured log.
  // Index launches first so same-batch configuration logs have a project FK.
  const indexedLaunches = await replayEventsInCanonicalOrder(events, (event) => applyEvent(event, tokens));
  const blockHash = await getBlockHash(to);
  await saveIndexerCheckpoint(RH_MAINNET_CHAIN_ID, contracts.factory, Number(to), blockHash);
  return {
    chainId: RH_MAINNET_CHAIN_ID,
    fromBlock: Number(from),
    indexedThrough: Number(to),
    events: events.length,
    launches: indexedLaunches,
    status: "indexed" as const,
  };
}
