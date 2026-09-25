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
} from "./repository";
import type { SplitIndexerEvent } from "./types";
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
  const token = await tokenForPool(event.poolId, tokens);
  if (event.type === "SplitConfigured") await upsertFeeConfiguration(event, token);
  else if (event.type === "FeesAccrued") await upsertAccrual(event, token);
  else if (event.type === "FeesAllocated") await upsertAllocationEvent(event, token);
  else if (event.type === "FeesClaimed") await upsertClaimEvent(event, token);
  else await upsertLiquidityCredit(event, token);
  return undefined;
}

/**
 * Poll one bounded, finalized range. Replays the recent overlap with upserts and
 * canonical flags so a short reorg cannot create duplicate financial events.
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
  const to = finalizedHead < from + batchSize - BigInt(1) ? finalizedHead : from + batchSize - BigInt(1);

  if (checkpoint?.last_processed_block_hash) {
    const savedBlock = BigInt(checkpoint.last_processed_block);
    const canonicalHash = await getBlockHash(savedBlock);
    if (canonicalHash.toLowerCase() !== checkpoint.last_processed_block_hash.toLowerCase()) {
      from = BigInt(Math.max(Number(startBlock), checkpoint.last_processed_block - Number(reorgWindow) + 1));
    }
  }
  if (from > to) return { chainId: RH_MAINNET_CHAIN_ID, indexedThrough: Number(to), events: 0, status: "current" as const };

  await markReorgedEventsNoncanonical(RH_MAINNET_CHAIN_ID, Number(from));
  const events = await getFinalizedEvents(from, to);
  const tokens = new Map<string, string>();
  let indexedLaunches = 0;
  // TokenLaunched is emitted last in launch(), after its SplitConfigured log.
  // Index launches first so same-batch configuration logs have a project FK.
  for (const event of events) {
    if (event.type === "TokenLaunched") {
      await applyEvent(event, tokens);
      indexedLaunches += 1;
    }
  }
  for (const event of events) {
    if (event.type !== "TokenLaunched") await applyEvent(event, tokens);
  }
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
