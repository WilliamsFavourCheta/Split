/** Shared UI shapes; no launch or financial fixture data is shipped to product routes. */
export const EXPLORER_URL = "https://robinhoodchain.blockscout.com";

export type TokenStatus = "live" | "graduated" | "upcoming" | "failed";

export type Token = {
  address: string;
  poolId?: string;
  name: string;
  ticker: string;
  status: TokenStatus;
  marketCap: string;
  volume: string;
  liquidity: string;
  holders: string;
  price: string;
  totalSupply?: string;
  initialSeedEth?: string;
  initialSeedTokens?: string;
  launched: string;
  color: string;
  description: string;
  logoUrl?: string;
  website: string;
  twitter: string;
  telegram: string;
  discord: string;
  owner: string;
  split: Allocation[];
};

export type Allocation = {
  key: "creator" | "liquidity" | "projectTreasury" | "community";
  label: string;
  value: number;
  color: string;
  address?: string;
  type?: string;
};

/** Illustrative default for launch form/hero only; never presented as a live launch. */
export const DEFAULT_SPLIT: Allocation[] = [
  { key: "creator", label: "Creator", value: 40, color: "#9c6cff", type: "Project owner" },
  { key: "liquidity", label: "Liquidity", value: 30, color: "#8150ed", type: "SPLIT Liquidity Vault" },
  { key: "projectTreasury", label: "Project Treasury", value: 20, color: "#6135bd", type: "Project destination" },
  { key: "community", label: "Community", value: 10, color: "#c6a3ff", type: "Community destination" },
];

export function shortAddress(address: string, head = 6, tail = 4) {
  return `${address.slice(0, head)}...${address.slice(-tail)}`;
}

export function explorerAddress(address: string) {
  return `${EXPLORER_URL}/address/${address}`;
}

export function explorerTx(hash: string) {
  return `${EXPLORER_URL}/tx/${hash}`;
}
