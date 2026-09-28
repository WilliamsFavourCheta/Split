import "server-only";
import { createPublicClient, decodeEventLog, http, isAddress, type Address, type Hash, type Log } from "viem";
import { robinhoodMainnet } from "../../web3/chains";
import { splitFactoryAbi, splitFeeRouterAbi, splitHookAbi, splitLiquidityVaultAbi } from "../../contracts/abis";
import type { ChainEvent, SplitIndexerEvent } from "./types";
import { createIndexerSupabaseClient } from "../supabase/server";

export const RH_MAINNET_CHAIN_ID = 4663;

function configuredAddress(value: string | undefined, name: string): Address {
  if (!value || !isAddress(value)) throw new Error(`${name} is not configured with a valid address.`);
  return value;
}

export function getIndexerContracts() {
  return {
    factory: configuredAddress(process.env.NEXT_PUBLIC_SPLIT_FACTORY_MAINNET_ADDRESS, "SPLIT factory"),
    hook: configuredAddress(process.env.NEXT_PUBLIC_SPLIT_HOOK_MAINNET_ADDRESS, "SPLIT hook"),
    router: configuredAddress(process.env.NEXT_PUBLIC_SPLIT_ROUTER_MAINNET_ADDRESS, "SPLIT fee router"),
    vault: configuredAddress(process.env.NEXT_PUBLIC_SPLIT_VAULT_MAINNET_ADDRESS, "SPLIT liquidity vault"),
  };
}

const rpcUrl = process.env.SPLIT_INDEXER_RPC_URL || process.env.NEXT_PUBLIC_ROBINHOOD_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
export const indexerClient = createPublicClient({ chain: robinhoodMainnet, transport: http(rpcUrl) });

const robinhoodPoolManager = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Address;
const poolSwapAbi = [{
  type: "event",
  name: "Swap",
  anonymous: false,
  inputs: [
    { name: "id", type: "bytes32", indexed: true },
    { name: "sender", type: "address", indexed: true },
    { name: "amount0", type: "int128", indexed: false },
    { name: "amount1", type: "int128", indexed: false },
    { name: "sqrtPriceX96", type: "uint160", indexed: false },
    { name: "liquidity", type: "uint128", indexed: false },
    { name: "tick", type: "int24", indexed: false },
    { name: "fee", type: "uint24", indexed: false },
  ],
}] as const;

async function getCanonicalPoolIds() {
  const client = createIndexerSupabaseClient();
  const poolIds: Hash[] = [];
  for (let offset = 0; ; offset += 1_000) {
    const { data, error } = await client.from("projects").select("pool_id")
      .eq("chain_id", RH_MAINNET_CHAIN_ID).eq("canonical", true).not("pool_id", "is", null)
      .range(offset, offset + 999);
    if (error) throw new Error(`Could not load indexed pools for price history: ${error.message}`);
    for (const row of data ?? []) {
      if (row.pool_id && /^0x[\da-f]{64}$/i.test(row.pool_id)) poolIds.push(row.pool_id.toLowerCase() as Hash);
    }
    if (!data || data.length < 1_000) break;
  }
  return [...new Set(poolIds)];
}

type Decoded = { eventName: string; args: Record<string, unknown> };

function decode(abi: readonly unknown[], log: Log): Decoded | null {
  try {
    return decodeEventLog({
      abi: abi as never,
      data: log.data,
      topics: log.topics,
      strict: false,
    }) as unknown as Decoded;
  } catch {
    return null;
  }
}

function required<T>(args: Record<string, unknown>, key: string): T {
  const value = args[key];
  if (value === undefined || value === null) throw new Error(`Decoded event is missing ${key}.`);
  return value as T;
}

function common(log: Log, contractAddress: Address, blockTimestamp?: string): ChainEvent {
  if (log.blockNumber === null || !log.blockHash || !log.transactionHash || log.logIndex === null) {
    throw new Error("RPC returned a log without canonical block/transaction metadata.");
  }
  return {
    chainId: RH_MAINNET_CHAIN_ID,
    contractAddress,
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    blockNumber: Number(log.blockNumber),
    blockHash: log.blockHash,
    blockTimestamp,
  };
}

export async function getFinalizedEvents(fromBlock: bigint, toBlock: bigint): Promise<SplitIndexerEvent[]> {
  if (toBlock < fromBlock) return [];
  const contracts = getIndexerContracts();
  const abiByAddress = new Map<string, { address: Address; abi: readonly unknown[] }>([
    [contracts.factory.toLowerCase(), { address: contracts.factory, abi: splitFactoryAbi }],
    [contracts.router.toLowerCase(), { address: contracts.router, abi: splitFeeRouterAbi }],
    [contracts.hook.toLowerCase(), { address: contracts.hook, abi: splitHookAbi }],
    [contracts.vault.toLowerCase(), { address: contracts.vault, abi: splitLiquidityVaultAbi }],
  ]);
  // Query all protocol addresses together so one RPC log response represents
  // one branch snapshot rather than four independently-timed requests.
  const response = await indexerClient.getLogs({
    address: [contracts.factory, contracts.router, contracts.hook, contracts.vault],
    fromBlock,
    toBlock,
  });
  const logs = response.map((log) => {
    const configured = abiByAddress.get(log.address.toLowerCase());
    if (!configured) throw new Error("RPC returned a log outside the requested SPLIT contracts.");
    return { log, ...configured };
  });

  const poolIds = new Set(await getCanonicalPoolIds());
  // Include launches in this same range so a same-block first swap is not missed.
  for (const item of logs) {
    const event = decode(item.abi, item.log);
    if (event?.eventName === "TokenLaunched" && typeof event.args.poolId === "string") {
      poolIds.add(event.args.poolId.toLowerCase() as Hash);
    }
  }
  const poolIdList = [...poolIds];
  const poolPriceLogs: Log[] = [];
  for (let index = 0; index < poolIdList.length; index += 50) {
    const response = await indexerClient.getLogs({
      address: robinhoodPoolManager,
      fromBlock,
      toBlock,
      event: poolSwapAbi[0],
      args: { id: poolIdList.slice(index, index + 50) },
    });
    poolPriceLogs.push(...response);
  }
  const orderedLogs = [...logs, ...poolPriceLogs.map((log) => ({ log, address: robinhoodPoolManager, abi: poolSwapAbi }))]
    .sort((a, b) => Number(a.log.blockNumber! - b.log.blockNumber!) || a.log.logIndex! - b.log.logIndex!);

  const timestamps = new Map<bigint, string>();
  const result: SplitIndexerEvent[] = [];
  for (const item of orderedLogs) {
    const blockNumber = item.log.blockNumber!;
    let timestamp = timestamps.get(blockNumber);
    if (!timestamp) {
      const block = await indexerClient.getBlock({ blockNumber });
      timestamp = new Date(Number(block.timestamp) * 1_000).toISOString();
      timestamps.set(blockNumber, timestamp);
    }
    const event = decode(item.abi, item.log);
    if (!event) continue;
    const base = common(item.log, item.address, timestamp);
    const args = event.args;

    if (event.eventName === "TokenLaunched") {
      result.push({
        ...base,
        type: "TokenLaunched",
        poolId: required<string>(args, "poolId"),
        tokenAddress: required<string>(args, "token"),
        creatorAddress: required<string>(args, "creator"),
        name: required<string>(args, "name"),
        symbol: required<string>(args, "symbol"),
        quoteAsset: required<string>(args, "quoteAsset"),
        totalSupply: required<bigint>(args, "totalSupply").toString(),
        seedTokenAmount: required<bigint>(args, "seedTokenAmount").toString(),
        seedQuoteAmount: required<bigint>(args, "seedQuoteAmount").toString(),
        sqrtPriceX96: required<bigint>(args, "sqrtPriceX96").toString(),
        lpFee: Number(required<bigint>(args, "lpFee")),
      });
    } else if (event.eventName === "LaunchProtocolFeeCharged") {
      result.push({
        ...base,
        type: "LaunchProtocolFeeCharged",
        poolId: required<string>(args, "poolId"),
        tokenAddress: required<string>(args, "token"),
        creatorAddress: required<string>(args, "creator"),
        rawAmount: required<bigint>(args, "amount").toString(),
      });
    } else if (event.eventName === "SplitConfigured") {
      result.push({
        ...base,
        type: "SplitConfigured",
        poolId: required<string>(args, "poolId"),
        creatorAddress: required<string>(args, "creator"),
        projectTreasuryAddress: required<string>(args, "projectTreasury"),
        communityAddress: required<string>(args, "community"),
        creatorBps: Number(required<bigint>(args, "creatorBps")),
        liquidityBps: Number(required<bigint>(args, "liquidityBps")),
        projectTreasuryBps: Number(required<bigint>(args, "projectTreasuryBps")),
        communityBps: Number(required<bigint>(args, "communityBps")),
      });
    } else if (event.eventName === "FeesAccrued") {
      result.push({
        ...base,
        type: "FeesAccrued",
        poolId: required<string>(args, "poolId"),
        currency: required<string>(args, "currency"),
        rawAmount: required<bigint>(args, "amount").toString(),
        swapperAddress: required<string>(args, "swapper"),
      });
    } else if (event.eventName === "FeesAllocated") {
      result.push({
        ...base,
        type: "FeesAllocated",
        poolId: required<string>(args, "poolId"),
        currency: required<string>(args, "currency"),
        grossAmount: required<bigint>(args, "grossAmount").toString(),
        protocolAllocation: required<bigint>(args, "protocolAllocation").toString(),
        creatorAllocation: required<bigint>(args, "creatorAllocation").toString(),
        projectTreasuryAllocation: required<bigint>(args, "projectTreasuryAllocation").toString(),
        communityAllocation: required<bigint>(args, "communityAllocation").toString(),
        liquidityAllocation: required<bigint>(args, "liquidityAllocation").toString(),
      });
    } else if (event.eventName === "FeesClaimed") {
      result.push({
        ...base,
        type: "FeesClaimed",
        poolId: required<string>(args, "poolId"),
        recipientAddress: required<string>(args, "recipient"),
        currency: required<string>(args, "currency"),
        rawAmount: required<bigint>(args, "amount").toString(),
      });
    } else if (event.eventName === "ProtocolFeesClaimed") {
      result.push({
        ...base,
        type: "ProtocolFeesClaimed",
        poolId: required<string>(args, "poolId"),
        currency: required<string>(args, "currency"),
        recipientAddress: required<string>(args, "recipient"),
        rawAmount: required<bigint>(args, "amount").toString(),
      });
    } else if (event.eventName === "ProtocolLaunchFeesClaimed") {
      result.push({
        ...base,
        type: "ProtocolLaunchFeesClaimed",
        recipientAddress: required<string>(args, "recipient"),
        rawAmount: required<bigint>(args, "amount").toString(),
      });
    } else if (event.eventName === "LiquidityCredited") {
      result.push({
        ...base,
        type: "LiquidityCredited",
        poolId: required<string>(args, "poolId"),
        currency: required<string>(args, "currency"),
        rawAmount: required<bigint>(args, "amount").toString(),
      });
    } else if (event.eventName === "Swap" && item.address.toLowerCase() === robinhoodPoolManager.toLowerCase()) {
      result.push({
        ...base,
        type: "PoolPriceUpdated",
        poolId: required<string>(args, "id"),
        sqrtPriceX96: required<bigint>(args, "sqrtPriceX96").toString(),
        source: "swap",
      });
    }
  }
  return result;
}

export async function getBlockHash(blockNumber: bigint): Promise<string> {
  const block = await indexerClient.getBlock({ blockNumber });
  if (!block.hash) throw new Error(`RPC did not return a hash for block ${blockNumber}.`);
  return block.hash;
}
