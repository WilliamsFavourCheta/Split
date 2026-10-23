import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { getPdaPlatformId } from "@raydium-io/raydium-sdk-v2";
import { solanaCluster } from "./client";

// Raydium documents separate LaunchLab deployments for each cluster.
export const RAYDIUM_LAUNCHPAD_PROGRAM = new PublicKey(
  solanaCluster === "mainnet-beta"
    ? "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj"
    : "DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6",
);

const seed = (value: string) => new TextEncoder().encode(value);
export const SPLIT_PLATFORM_ADMIN = new PublicKey(solanaCluster === "devnet"
  ? "5vFpsk41F3VH94mFji6e1XZp4bPwPQSGJdHRiVQuPp8i"
  : "9FAqrQLSbX8Sz6wu1u3QovunR3jFgWa2RfvQpJXFAUBu");
export const SPLIT_PROTOCOL_TREASURY = new PublicKey(solanaCluster === "devnet"
  ? "9RPVW6dv1Lb6SUzBsYMRKwvmbKRpfneiaDPgtZaFcvWV"
  : "HSrCeMpFh5VnApPRPHJvDPTxUEdM7hQi5DhAMqWDcasn");

/** The deployed router remains available for controlled devnet work only. */
export const routerBackedSolanaMode = solanaCluster === "devnet"
  && process.env.NEXT_PUBLIC_SOLANA_ROUTER_BACKED === "true";

export function getRouterlessPlatformConfig() {
  const platformAddress = process.env.NEXT_PUBLIC_SPLIT_SOLANA_PLATFORM_CONFIG;
  const walletAddress = process.env.NEXT_PUBLIC_SPLIT_SOLANA_FEE_WALLET;
  if (!platformAddress || !walletAddress) return null;
  try {
    const platform = new PublicKey(platformAddress);
    const feeWallet = new PublicKey(walletAddress);
    const expected = getPdaPlatformId(RAYDIUM_LAUNCHPAD_PROGRAM, SPLIT_PLATFORM_ADMIN).publicKey;
    if (!platform.equals(expected) || feeWallet.equals(PublicKey.default)) return null;
    return { platform, feeWallet, admin: SPLIT_PLATFORM_ADMIN, raydium: RAYDIUM_LAUNCHPAD_PROGRAM };
  } catch { return null; }
}

export function getSolanaDeploymentConfig() {
  const programId = process.env.NEXT_PUBLIC_SPLIT_SOLANA_PROGRAM_ID;
  const platformConfig = process.env.NEXT_PUBLIC_SPLIT_SOLANA_PLATFORM_CONFIG;
  if (!programId || !platformConfig) return null;
  try {
    const router = new PublicKey(programId);
    const platform = new PublicKey(platformConfig);
    if (router.equals(PublicKey.default) || platform.equals(PublicKey.default)
      || !platform.equals(getPdaPlatformId(RAYDIUM_LAUNCHPAD_PROGRAM, SPLIT_PLATFORM_ADMIN).publicKey)) return null;
    return { router, platform, raydium: RAYDIUM_LAUNCHPAD_PROGRAM };
  } catch {
    return null;
  }
}

export function deriveSolanaProjectAccounts(mintAddress: string, router: PublicKey) {
  const mint = new PublicKey(mintAddress);
  if (mint.equals(NATIVE_MINT)) throw new Error("The token mint cannot be WSOL.");
  const [protocol] = PublicKey.findProgramAddressSync([seed("protocol")], router);
  const [project] = PublicKey.findProgramAddressSync([seed("project"), mint.toBytes()], router);
  const [projectVault] = PublicKey.findProgramAddressSync([seed("vault"), project.toBytes()], router);
  const [feeWallet] = PublicKey.findProgramAddressSync([seed("fee_wallet")], router);
  const feeWalletTokens = getAssociatedTokenAddressSync(NATIVE_MINT, feeWallet, true, TOKEN_PROGRAM_ID);
  const [pool] = PublicKey.findProgramAddressSync([seed("pool"), mint.toBytes(), NATIVE_MINT.toBytes()], RAYDIUM_LAUNCHPAD_PROGRAM);
  const [poolQuoteVault] = PublicKey.findProgramAddressSync([seed("pool_vault"), pool.toBytes(), NATIVE_MINT.toBytes()], RAYDIUM_LAUNCHPAD_PROGRAM);
  const [raydiumAuthority] = PublicKey.findProgramAddressSync([seed("vault_auth_seed")], RAYDIUM_LAUNCHPAD_PROGRAM);
  return { mint, protocol, project, projectVault, feeWallet, feeWalletTokens, pool, poolQuoteVault, raydiumAuthority, quoteMint: NATIVE_MINT };
}
