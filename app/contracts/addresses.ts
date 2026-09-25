import { isAddress, type Address } from "viem";

/** Intentionally unset until SPLIT's factory is deployed and independently verified. */
export const splitFactoryAddresses: Partial<Record<4663 | 46630, Address>> = {
  4663: isAddress(process.env.NEXT_PUBLIC_SPLIT_FACTORY_MAINNET_ADDRESS || "")
    ? process.env.NEXT_PUBLIC_SPLIT_FACTORY_MAINNET_ADDRESS as Address
    : undefined,
  // RH testnet is deliberately disabled: no official compatible v4 PoolManager is verified.
  46630: undefined,
};

export const splitHookAddresses: Partial<Record<4663 | 46630, Address>> = {
  4663: isAddress(process.env.NEXT_PUBLIC_SPLIT_HOOK_MAINNET_ADDRESS || "")
    ? process.env.NEXT_PUBLIC_SPLIT_HOOK_MAINNET_ADDRESS as Address
    : undefined,
  46630: undefined,
};

export const splitFeeRouterAddresses: Partial<Record<4663 | 46630, Address>> = {
  4663: isAddress(process.env.NEXT_PUBLIC_SPLIT_ROUTER_MAINNET_ADDRESS || "")
    ? process.env.NEXT_PUBLIC_SPLIT_ROUTER_MAINNET_ADDRESS as Address
    : undefined,
  46630: undefined,
};

export const splitLiquidityVaultAddresses: Partial<Record<4663 | 46630, Address>> = {
  4663: isAddress(process.env.NEXT_PUBLIC_SPLIT_VAULT_MAINNET_ADDRESS || "")
    ? process.env.NEXT_PUBLIC_SPLIT_VAULT_MAINNET_ADDRESS as Address
    : undefined,
  46630: undefined,
};

export function getSplitFactoryAddress(chainId: number): Address | undefined {
  return chainId === 4663 || chainId === 46630 ? splitFactoryAddresses[chainId] : undefined;
}
