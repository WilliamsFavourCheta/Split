const poolKey = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

export const splitSwapExecutorAbi = [
  { type: "function", name: "officialPool", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ name: "key", type: "tuple", components: poolKey }, { name: "poolId", type: "bytes32" }] },
  { type: "function", name: "buy", stateMutability: "payable", inputs: [{ name: "token", type: "address" }, { name: "minAmountOut", type: "uint256" }, { name: "deadline", type: "uint256" }], outputs: [{ name: "amountOut", type: "uint256" }] },
  { type: "function", name: "sell", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "minAmountOut", type: "uint256" }, { name: "deadline", type: "uint256" }], outputs: [{ name: "amountOut", type: "uint256" }] },
] as const;

export const v4QuoterAbi = [{
  type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
  inputs: [{ name: "params", type: "tuple", components: [
    { name: "poolKey", type: "tuple", components: poolKey },
    { name: "zeroForOne", type: "bool" },
    { name: "exactAmount", type: "uint128" },
    { name: "hookData", type: "bytes" },
  ] }],
  outputs: [{ name: "amountOut", type: "uint256" }, { name: "gasEstimate", type: "uint256" }],
}] as const;

// Official Uniswap v4 Quoter on Robinhood Chain 4663.
export const RH_V4_QUOTER = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94" as const;
