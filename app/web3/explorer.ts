import { isHex, type Hex } from "viem";
import { supportedChains } from "./chains";

export function getTransactionExplorerUrl(hash: string, chainId: number): string | undefined {
  if (!isHex(hash, { strict: true })) return undefined;
  const explorer = supportedChains.find((chain) => chain.id === chainId)?.blockExplorers?.default.url;
  return explorer ? `${explorer}/tx/${hash as Hex}` : undefined;
}
