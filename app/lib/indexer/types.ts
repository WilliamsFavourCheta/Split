
export type ChainEvent = {
  chainId: number;
  contractAddress: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  blockTimestamp?: string;
};

export type TokenLaunchedEvent = ChainEvent & {
  type: "TokenLaunched";
  poolId: string;
  tokenAddress: string;
  creatorAddress: string;
  name: string;
  symbol: string;
  quoteAsset: string;
  totalSupply: string;
  seedTokenAmount: string;
  seedQuoteAmount: string;
  sqrtPriceX96: string;
  lpFee: number;
};

export type SplitConfiguredEvent = ChainEvent & {
  type: "SplitConfigured";
  poolId: string;
  creatorAddress: string;
  treasuryAddress: string;
  communityAddress: string;
  creatorBps: number;
  liquidityBps: number;
  treasuryBps: number;
  communityBps: number;
};

export type FeesAccruedEvent = ChainEvent & {
  type: "FeesAccrued";
  poolId: string;
  currency: string;
  rawAmount: string;
  swapperAddress: string;
};

export type FeesAllocatedEvent = ChainEvent & {
  type: "FeesAllocated";
  poolId: string;
  currency: string;
  grossAmount: string;
  creatorAllocation: string;
  treasuryAllocation: string;
  communityAllocation: string;
  liquidityAllocation: string;
};

export type FeesClaimedEvent = ChainEvent & {
  type: "FeesClaimed";
  poolId: string;
  currency: string;
  recipientAddress: string;
  rawAmount: string;
};

export type LiquidityCreditedEvent = ChainEvent & {
  type: "LiquidityCredited";
  poolId: string;
  currency: string;
  rawAmount: string;
};

export type SplitIndexerEvent =
  | TokenLaunchedEvent
  | SplitConfiguredEvent
  | FeesAccruedEvent
  | FeesAllocatedEvent
  | FeesClaimedEvent
  | LiquidityCreditedEvent;

/** A source must only return blocks beneath its configured finality depth. */
export interface ChainEventSource {
  getFinalizedEvents(fromBlock: bigint, toBlock: bigint): Promise<SplitIndexerEvent[]>;
  getBlockHash(blockNumber: bigint): Promise<string>;
}
