export type SolanaTokenMetadataDraft = {
  name: string;
  symbol: string;
  description: string;
  website: string;
  x: string;
  projectTreasuryAddress: string;
  communityAddress: string;
  split: { creator: number; liquidity: number; projectTreasury: number; community: number };
};

/** Stable signed content; the logo hash binds the uploaded bytes to this message. */
export function solanaMetadataMessage(input: {
  cluster: string;
  mint: string;
  creator: string;
  expiresAt: number;
  metadata: SolanaTokenMetadataDraft;
  logoSha256: string;
}) {
  return ["SPLIT_SOLANA_METADATA_V1", input.cluster, input.mint, input.creator,
    String(input.expiresAt), JSON.stringify(input.metadata), input.logoSha256].join("\n");
}
