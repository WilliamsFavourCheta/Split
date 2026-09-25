import "server-only";
import { createIndexerSupabaseClient } from "../supabase/server";
import type {
  FeesAccruedEvent,
  FeesAllocatedEvent,
  FeesClaimedEvent,
  LiquidityCreditedEvent,
  SplitConfiguredEvent,
  TokenLaunchedEvent,
} from "./types";

function normalizeAddress(value: string) { return value.toLowerCase(); }

async function requireProject(chainId: number, tokenAddress: string) {
  const client = createIndexerSupabaseClient();
  const { data, error } = await client.from("projects").select("id").eq("chain_id", chainId).eq("token_address", normalizeAddress(tokenAddress)).maybeSingle();
  if (error) throw new Error(`Indexer project lookup failed: ${error.message}`);
  if (!data) throw new Error(`Missing indexed project for ${chainId}:${normalizeAddress(tokenAddress)}; replay the launch block first.`);
  return data.id;
}

export async function upsertLaunch(event: TokenLaunchedEvent) {
  const client = createIndexerSupabaseClient();
  const { data, error } = await client.from("projects").upsert({
    chain_id: event.chainId,
    token_address: normalizeAddress(event.tokenAddress),
    creator_address: normalizeAddress(event.creatorAddress),
    name: event.name,
    symbol: event.symbol,
    status: "live",
    launch_tx_hash: event.txHash.toLowerCase(),
    launch_block_number: event.blockNumber,
    launch_block_hash: event.blockHash.toLowerCase(),
    launched_at: event.blockTimestamp ?? null,
    pool_id: event.poolId.toLowerCase(),
    quote_asset: normalizeAddress(event.quoteAsset),
    total_supply_raw: event.totalSupply,
    seed_token_amount_raw: event.seedTokenAmount,
    seed_quote_amount_raw: event.seedQuoteAmount,
    sqrt_price_x96: event.sqrtPriceX96,
    lp_fee: event.lpFee,
  }, { onConflict: "chain_id,token_address" }).select("id").single();
  if (error) throw new Error(`Indexer launch upsert failed: ${error.message}`);
  const { error: launchError } = await client.from("launches").upsert({
    project_id: data.id,
    creator_address: normalizeAddress(event.creatorAddress),
    factory_address: normalizeAddress(event.contractAddress),
    token_address: normalizeAddress(event.tokenAddress),
    pool_id: event.poolId.toLowerCase(),
    quote_asset: normalizeAddress(event.quoteAsset),
    pair_token_address: null,
    launch_tx_hash: event.txHash.toLowerCase(),
    launch_block_number: event.blockNumber,
    launch_timestamp: event.blockTimestamp ?? null,
    canonical: true,
  }, { onConflict: "project_id" });
  if (launchError) throw new Error(`Indexer launch record upsert failed: ${launchError.message}`);
  return data.id;
}

export async function upsertFeeConfiguration(event: SplitConfiguredEvent, tokenAddress: string) {
  const projectId = await requireProject(event.chainId, tokenAddress);
  const { error } = await createIndexerSupabaseClient().from("fee_configs").upsert({
    project_id: projectId,
    creator_bps: event.creatorBps,
    liquidity_bps: event.liquidityBps,
    treasury_bps: event.treasuryBps,
    community_bps: event.communityBps,
    creator_destination: normalizeAddress(event.creatorAddress),
    treasury_destination: normalizeAddress(event.treasuryAddress),
    community_destination: normalizeAddress(event.communityAddress),
    config_tx_hash: event.txHash.toLowerCase(),
    block_number: event.blockNumber,
    configured_at: event.blockTimestamp ?? null,
    is_immutable: true,
    canonical: true,
  }, { onConflict: "project_id" });
  if (error) throw new Error(`Indexer split configuration upsert failed: ${error.message}`);
}

export async function upsertAccrual(event: FeesAccruedEvent, tokenAddress: string) {
  const projectId = await requireProject(event.chainId, tokenAddress);
  const { error } = await createIndexerSupabaseClient().from("fee_accrual_events").upsert({
    project_id: projectId,
    chain_id: event.chainId,
    pool_id: event.poolId.toLowerCase(),
    currency: normalizeAddress(event.currency),
    tx_hash: event.txHash.toLowerCase(),
    log_index: event.logIndex,
    block_number: event.blockNumber,
    block_hash: event.blockHash.toLowerCase(),
    block_timestamp: event.blockTimestamp ?? null,
    swapper_address: normalizeAddress(event.swapperAddress),
    raw_amount: event.rawAmount,
    canonical: true,
  }, { onConflict: "chain_id,tx_hash,log_index" });
  if (error) throw new Error(`Indexer accrual upsert failed: ${error.message}`);
}

export async function upsertAllocationEvent(event: FeesAllocatedEvent, tokenAddress: string) {
  const projectId = await requireProject(event.chainId, tokenAddress);
  const { error } = await createIndexerSupabaseClient().from("fee_allocation_events").upsert({
    project_id: projectId,
    chain_id: event.chainId,
    pool_id: event.poolId.toLowerCase(),
    currency: normalizeAddress(event.currency),
    tx_hash: event.txHash.toLowerCase(),
    log_index: event.logIndex,
    block_number: event.blockNumber,
    block_hash: event.blockHash.toLowerCase(),
    block_timestamp: event.blockTimestamp ?? null,
    gross_amount_raw: event.grossAmount,
    creator_allocation_raw: event.creatorAllocation,
    treasury_allocation_raw: event.treasuryAllocation,
    community_allocation_raw: event.communityAllocation,
    liquidity_allocation_raw: event.liquidityAllocation,
    canonical: true,
  }, { onConflict: "chain_id,tx_hash,log_index" });
  if (error) throw new Error(`Indexer allocation event upsert failed: ${error.message}`);
}

export async function upsertClaimEvent(event: FeesClaimedEvent, tokenAddress: string) {
  const projectId = await requireProject(event.chainId, tokenAddress);
  const { error } = await createIndexerSupabaseClient().from("fee_claim_events").upsert({
    project_id: projectId,
    chain_id: event.chainId,
    pool_id: event.poolId.toLowerCase(),
    currency: normalizeAddress(event.currency),
    recipient_address: normalizeAddress(event.recipientAddress),
    tx_hash: event.txHash.toLowerCase(),
    log_index: event.logIndex,
    block_number: event.blockNumber,
    block_hash: event.blockHash.toLowerCase(),
    block_timestamp: event.blockTimestamp ?? null,
    raw_amount: event.rawAmount,
    canonical: true,
  }, { onConflict: "chain_id,tx_hash,log_index" });
  if (error) throw new Error(`Indexer claim event upsert failed: ${error.message}`);
}

export async function upsertLiquidityCredit(event: LiquidityCreditedEvent, tokenAddress: string) {
  const projectId = await requireProject(event.chainId, tokenAddress);
  const { error } = await createIndexerSupabaseClient().from("liquidity_credit_events").upsert({
    project_id: projectId,
    chain_id: event.chainId,
    pool_id: event.poolId.toLowerCase(),
    currency: normalizeAddress(event.currency),
    tx_hash: event.txHash.toLowerCase(),
    log_index: event.logIndex,
    block_number: event.blockNumber,
    block_hash: event.blockHash.toLowerCase(),
    block_timestamp: event.blockTimestamp ?? null,
    raw_amount: event.rawAmount,
    canonical: true,
  }, { onConflict: "chain_id,tx_hash,log_index" });
  if (error) throw new Error(`Indexer liquidity credit upsert failed: ${error.message}`);
}

export async function saveIndexerCheckpoint(chainId: number, contractAddress: string, lastProcessedBlock: number, lastProcessedBlockHash: string) {
  const { error } = await createIndexerSupabaseClient().from("indexer_state").upsert({
    chain_id: chainId,
    contract_address: normalizeAddress(contractAddress),
    last_processed_block: lastProcessedBlock,
    last_processed_block_hash: lastProcessedBlockHash.toLowerCase(),
  }, { onConflict: "chain_id,contract_address" });
  if (error) throw new Error(`Indexer checkpoint update failed: ${error.message}`);
}

export async function getIndexerCheckpoint(chainId: number, contractAddress: string) {
  const { data, error } = await createIndexerSupabaseClient()
    .from("indexer_state")
    .select("last_processed_block,last_processed_block_hash")
    .eq("chain_id", chainId)
    .eq("contract_address", normalizeAddress(contractAddress))
    .maybeSingle();
  if (error) throw new Error(`Indexer checkpoint lookup failed: ${error.message}`);
  return data;
}

export async function markReorgedEventsNoncanonical(chainId: number, fromBlock: number) {
  const { error } = await createIndexerSupabaseClient().rpc("mark_chain_events_noncanonical", {
    p_chain_id: chainId,
    p_from_block: fromBlock,
  });
  if (error) throw new Error(`Indexer reorg rollback failed: ${error.message}`);
}
