import "server-only";
import { createPublicClient, decodeEventLog, http, isAddress, type Address, type Log } from "viem";
import { robinhoodMainnet } from "../../web3/chains";
import { splitFactoryAbi, splitFeeRouterAbi, splitHookAbi, splitLiquidityVaultAbi } from "../../contracts/abis";
import type { ChainEvent, SplitIndexerEvent } from "./types";

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

const rpcUrl = process.env.NEXT_PUBLIC_ROBINHOOD_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
export const indexerClient = createPublicClient({ chain: robinhoodMainnet, transport: http(rpcUrl) });

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
  const [factoryLogs, routerLogs, hookLogs, vaultLogs] = await Promise.all([
    indexerClient.getLogs({ address: contracts.factory, fromBlock, toBlock }),
    indexerClient.getLogs({ address: contracts.router, fromBlock, toBlock }),
    indexerClient.getLogs({ address: contracts.hook, fromBlock, toBlock }),
    indexerClient.getLogs({ address: contracts.vault, fromBlock, toBlock }),
  ]);
  const logs = [
    ...factoryLogs.map((log) => ({ log, address: contracts.factory, abi: splitFactoryAbi })),
    ...routerLogs.map((log) => ({ log, address: contracts.router, abi: splitFeeRouterAbi })),
    ...hookLogs.map((log) => ({ log, address: contracts.hook, abi: splitHookAbi })),
    ...vaultLogs.map((log) => ({ log, address: contracts.vault, abi: splitLiquidityVaultAbi })),
  ].sort((a, b) => Number(a.log.blockNumber! - b.log.blockNumber!) || a.log.logIndex! - b.log.logIndex!);

  const timestamps = new Map<bigint, string>();
  const result: SplitIndexerEvent[] = [];
  for (const item of logs) {
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
    } else if (event.eventName === "LiquidityCredited") {
      result.push({
        ...base,
        type: "LiquidityCredited",
        poolId: required<string>(args, "poolId"),
        currency: required<string>(args, "currency"),
        rawAmount: required<bigint>(args, "amount").toString(),
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
