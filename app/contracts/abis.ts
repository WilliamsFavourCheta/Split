export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "balance", type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "remaining", type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "decimals", type: "uint8" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "success", type: "bool" }] },
] as const;

export const splitFactoryAbi = [
  {
    type: "function",
    name: "tokenForPool",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "token", type: "address" }],
  },
  {
    type: "function",
    name: "launch",
    stateMutability: "payable",
    inputs: [{
      name: "p",
      type: "tuple",
      components: [
        { name: "name", type: "string" },
        { name: "symbol", type: "string" },
        { name: "tokenSeedAmount", type: "uint256" },
        { name: "creatorBps", type: "uint256" },
        { name: "liquidityBps", type: "uint256" },
        { name: "treasuryBps", type: "uint256" },
        { name: "communityBps", type: "uint256" },
        { name: "community", type: "address" },
        { name: "salt", type: "bytes32" },
      ],
    }],
    outputs: [
      { name: "token", type: "address" },
      { name: "poolId", type: "bytes32" },
    ],
  },
  {
    type: "event",
    name: "TokenLaunched",
    anonymous: false,
    inputs: [
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "name", type: "string", indexed: false },
      { name: "symbol", type: "string", indexed: false },
      { name: "quoteAsset", type: "address", indexed: false },
      { name: "totalSupply", type: "uint256", indexed: false },
      { name: "seedTokenAmount", type: "uint256", indexed: false },
      { name: "seedQuoteAmount", type: "uint256", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "lpFee", type: "uint24", indexed: false },
    ],
  },
] as const;

export const splitFeeRouterAbi = [
  {
    type: "function",
    name: "claimable",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "recipient", type: "address" },
      { name: "currency", type: "address" },
    ],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "currency", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "splits",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "creator", type: "address" },
      { name: "treasury", type: "address" },
      { name: "community", type: "address" },
      { name: "creatorBps", type: "uint16" },
      { name: "liquidityBps", type: "uint16" },
      { name: "treasuryBps", type: "uint16" },
      { name: "communityBps", type: "uint16" },
      { name: "configured", type: "bool" },
    ],
  },
  {
    type: "event",
    name: "SplitConfigured",
    anonymous: false,
    inputs: [
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "treasury", type: "address", indexed: false },
      { name: "community", type: "address", indexed: false },
      { name: "creatorBps", type: "uint16", indexed: false },
      { name: "liquidityBps", type: "uint16", indexed: false },
      { name: "treasuryBps", type: "uint16", indexed: false },
      { name: "communityBps", type: "uint16", indexed: false },
    ],
  },
  {
    type: "event",
    name: "FeesAllocated",
    anonymous: false,
    inputs: [
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "currency", type: "address", indexed: true },
      { name: "grossAmount", type: "uint256", indexed: false },
      { name: "creatorAllocation", type: "uint256", indexed: false },
      { name: "treasuryAllocation", type: "uint256", indexed: false },
      { name: "communityAllocation", type: "uint256", indexed: false },
      { name: "liquidityAllocation", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "FeesClaimed",
    anonymous: false,
    inputs: [
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "currency", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

export const splitHookAbi = [
  {
    type: "function",
    name: "accrued",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "currency", type: "address" },
    ],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "event",
    name: "FeesAccrued",
    anonymous: false,
    inputs: [
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "currency", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "swapper", type: "address", indexed: true },
    ],
  },
] as const;

export const splitLiquidityVaultAbi = [
  {
    type: "function",
    name: "pendingLiquidity",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "currency", type: "address" },
    ],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "event",
    name: "LiquidityCredited",
    anonymous: false,
    inputs: [
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "currency", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;
