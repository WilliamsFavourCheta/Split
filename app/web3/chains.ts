import { defineChain } from "viem";

const mainnetRpc = process.env.NEXT_PUBLIC_ROBINHOOD_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const testnetRpc = process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC_URL || process.env.NEXT_PUBLIC_RH_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com";

export const robinhoodMainnet = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [mainnetRpc] } },
  blockExplorers: { default: { name: "Robinhood Explorer", url: "https://robinhoodchain.blockscout.com" } },
});

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [testnetRpc] } },
  blockExplorers: { default: { name: "Robinhood Testnet Explorer", url: "https://explorer.testnet.chain.robinhood.com" } },
  contracts: {
    multicall3: {
      address: "0xca11bde05977b3631167028862a173976ca11",
    },
  },
});

export const supportedChains = [robinhoodMainnet, robinhoodTestnet] as const;
const requestedChainId = Number(process.env.NEXT_PUBLIC_TARGET_CHAIN_ID || 4663);

export const targetChain = supportedChains.find((chain) => chain.id === requestedChainId) ?? robinhoodMainnet;
export const targetChainId = targetChain.id;

export function isSupportedChainId(chainId: number): boolean {
  return supportedChains.some((chain) => chain.id === chainId);
}

export function getChainName(chainId: number | undefined): string {
  if (chainId === undefined) return targetChain.name;
  return supportedChains.find((chain) => chain.id === chainId)?.name ?? `Unknown network (${chainId})`;
}
