import "server-only";
import { createHash } from "node:crypto";
import { getPdaLaunchpadPoolId, LaunchpadPool, PlatformConfig } from "@raydium-io/raydium-sdk-v2";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { solanaRpcUrl } from "./client";
import { getRouterlessPlatformConfig, routerBackedSolanaMode } from "./raydium-accounts";
import { verifySolanaLaunch as verifyRouterLaunch } from "./router-verify-launch";

const discriminator = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const POOL = discriminator("PoolState");
const PLATFORM = discriminator("PlatformConfig");
const METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

function metadataFields(data: Buffer, mint: PublicKey) {
  if (data.length < 77 || data[0] !== 4 || !new PublicKey(data.subarray(33, 65)).equals(mint)) throw new Error("Invalid token metadata.");
  let offset = 65;
  const read = (limit: number) => {
    if (offset + 4 > data.length) throw new Error("Truncated token metadata.");
    const len = data.readUInt32LE(offset);
    offset += 4;
    if (len > limit || offset + len > data.length) throw new Error("Invalid metadata field.");
    const value = data.subarray(offset, offset + len).toString("utf8").replace(/\0+$/, "").trim();
    offset += len;
    return value;
  };
  const name = read(32);
  const symbol = read(10);
  const uri = read(200);
  if (!name || !/^[A-Z0-9]{2,10}$/.test(symbol) || !uri.startsWith("https://")) throw new Error("Incomplete token metadata.");
  return { name, symbol, uri };
}

export async function verifySolanaLaunch(mintAddress: string) {
  if (routerBackedSolanaMode) return verifyRouterLaunch(mintAddress);
  const config = getRouterlessPlatformConfig();
  if (!config) throw new Error("SPLIT Raydium platform and ordinary fee wallet are not configured.");
  const mint = new PublicKey(mintAddress);
  if (mint.equals(NATIVE_MINT)) throw new Error("Invalid token mint.");
  const poolAddress = getPdaLaunchpadPoolId(config.raydium, mint, NATIVE_MINT).publicKey;
  const [metadataAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM.toBuffer(), mint.toBuffer()], METADATA_PROGRAM);
  const connection = new Connection(solanaRpcUrl, "finalized");
  const response = await connection.getMultipleAccountsInfoAndContext(
    [poolAddress, config.platform, mint, metadataAddress], { commitment: "finalized" });
  const [poolAccount, platformAccount, mintAccount, metadataAccount] = response.value;
  if (!poolAccount || !platformAccount || !mintAccount || !metadataAccount) throw new Error("Finalized launch accounts are missing.");
  if (!poolAccount.owner.equals(config.raydium) || poolAccount.data.length !== LaunchpadPool.span || !poolAccount.data.subarray(0, 8).equals(POOL)
    || !platformAccount.owner.equals(config.raydium) || platformAccount.data.length !== PlatformConfig.span || !platformAccount.data.subarray(0, 8).equals(PLATFORM)
    || !mintAccount.owner.equals(TOKEN_PROGRAM_ID) || !metadataAccount.owner.equals(METADATA_PROGRAM)) throw new Error("Launch account ownership or layout mismatch.");
  const pool = LaunchpadPool.decode(poolAccount.data);
  const platform = PlatformConfig.decode(platformAccount.data);
  if (!pool.mintA.equals(mint) || !pool.mintB.equals(NATIVE_MINT) || !pool.platformId.equals(config.platform)
    || pool.migrateType !== 1 || ![0, 1, 2].includes(pool.status) || pool.mintDecimalsA !== 6) throw new Error("Raydium launch binding mismatch.");
  if (!platform.platformClaimFeeWallet.equals(config.feeWallet) || !platform.feeRate.eqn(10_000)
    || !platform.creatorFeeRate.isZero()) throw new Error("SPLIT platform fee settings are incompatible.");
  const metadata = metadataFields(metadataAccount.data, mint);
  return { mint: mint.toBase58(), pool: poolAddress.toBase58(), creator: pool.creator.toBase58(),
    platformConfig: config.platform.toBase58(), name: metadata.name, symbol: metadata.symbol,
    metadataUri: metadata.uri, decimals: pool.mintDecimalsA,
    status: (pool.status === 2 ? "graduated" : pool.status === 1 ? "bonded" : "curve") as "curve" | "bonded" | "graduated",
    observedFinalizedSlot: response.context.slot };
}
