import { getAddress, isAddress, type Address } from "viem";

export function shortenAddress(address: string | null | undefined, leading = 6, trailing = 4): string {
  if (!address || !isAddress(address)) return "";
  const normalized = getAddress(address);
  return `${normalized.slice(0, leading)}…${normalized.slice(-trailing)}`;
}

export function parseAddress(value: string): Address | undefined {
  const trimmed = value.trim();
  return isAddress(trimmed) ? getAddress(trimmed) : undefined;
}
