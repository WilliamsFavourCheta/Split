import "server-only";
import { createHash } from "node:crypto";
import { LaunchpadPool, PlatformConfig } from "@raydium-io/raydium-sdk-v2";
import { Connection, PublicKey } from "@solana/web3.js";
import { solanaRpcUrl } from "./client";
import { deriveSolanaProjectAccounts, getSolanaDeploymentConfig, SPLIT_PROTOCOL_TREASURY } from "./raydium-accounts";

const PROJECT_DISCRIMINATOR = createHash("sha256").update("account:Project").digest().subarray(0, 8);
const PROTOCOL_DISCRIMINATOR = createHash("sha256").update("account:Protocol").digest().subarray(0, 8);
const PLATFORM_DISCRIMINATOR = createHash("sha256").update("account:PlatformConfig").digest().subarray(0, 8);
const RAYDIUM_POOL_DISCRIMINATOR = Buffer.from([247, 237, 227, 245, 215, 195, 222, 70]);
const METAPLEX_METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const PROJECT_MIN_BYTES = 249;

function readMetadata(data: Buffer, expectedMint: PublicKey) {
  if (data.length < 77 || data[0] !== 4 || !new PublicKey(data.subarray(33, 65)).equals(expectedMint)) {
    throw new Error("Invalid Metaplex metadata account.");
  }
  let offset = 65;
  const readString = (max: number) => {
    if (offset + 4 > data.length) throw new Error("Truncated token metadata.");
    const length = data.readUInt32LE(offset);
    offset += 4;
    if (length > max || offset + length > data.length) throw new Error("Invalid token metadata field length.");
    const value = data.subarray(offset, offset + length).toString("utf8").replace(/\0+$/, "").trim();
    offset += length;
    return value;
  };
  const name = readString(32);
  const symbol = readString(10);
  const uri = readString(200);
  if (!name || !/^[A-Z0-9]{2,10}$/.test(symbol) || !uri.startsWith("https://")) {
    throw new Error("On-chain token metadata is incomplete.");
  }
  return { name, symbol, uri };
}

export type VerifiedSolanaLaunch = {
  mint: string;
  pool: string;
  creator: string;
  projectTreasury: string;
  community: string;
  platformConfig: string;
  name: string;
  symbol: string;
  metadataUri: string;
  decimals: number;
  status: "curve" | "bonded" | "graduated";
  shares: { creator: number; liquidity: number; projectTreasury: number; community: number };
  observedFinalizedSlot: number;
};

/** Confirm accounts against finalized RPC state before creating any database project row. */
export async function verifySolanaLaunch(mintAddress: string): Promise<VerifiedSolanaLaunch> {
  const config = getSolanaDeploymentConfig();
  if (!config) throw new Error("SPLIT Solana program and platform configuration are not set.");
  const accounts = deriveSolanaProjectAccounts(mintAddress, config.router);
  const [metadataAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METAPLEX_METADATA_PROGRAM.toBuffer(), accounts.mint.toBuffer()],
    METAPLEX_METADATA_PROGRAM,
  );
  const connection = new Connection(solanaRpcUrl, { commitment: "finalized" });
  const response = await connection.getMultipleAccountsInfoAndContext([accounts.project, accounts.pool, accounts.protocol, config.platform, metadataAddress], { commitment: "finalized" });
  const [projectInfo, poolInfo, protocolInfo, platformInfo, metadataInfo] = response.value;
  if (!projectInfo || !poolInfo || !protocolInfo || !platformInfo || !metadataInfo) throw new Error("The registered project, Raydium pool, protocol, platform configuration and token metadata must all exist.");
  if (!projectInfo.owner.equals(config.router) || !poolInfo.owner.equals(config.raydium) || !protocolInfo.owner.equals(config.router) || !platformInfo.owner.equals(config.raydium) || !metadataInfo.owner.equals(METAPLEX_METADATA_PROGRAM)) throw new Error("On-chain account owner mismatch.");
  const metadata = readMetadata(metadataInfo.data, accounts.mint);
  if (projectInfo.data.length < PROJECT_MIN_BYTES || !projectInfo.data.subarray(0, 8).equals(PROJECT_DISCRIMINATOR)) throw new Error("Invalid SPLIT project account.");
  if (poolInfo.data.length < LaunchpadPool.span || !poolInfo.data.subarray(0, 8).equals(RAYDIUM_POOL_DISCRIMINATOR)) throw new Error("Invalid Raydium pool account.");
  if (platformInfo.data.length < PlatformConfig.span || !platformInfo.data.subarray(0, 8).equals(PLATFORM_DISCRIMINATOR)) throw new Error("Invalid Raydium platform configuration.");
  const platform = PlatformConfig.decode(platformInfo.data);
  if (!platform.platformClaimFeeWallet.equals(accounts.feeWallet) || !platform.feeRate.eqn(10_000) || !platform.creatorFeeRate.isZero()) throw new Error("Raydium platform fee configuration does not match SPLIT's 1% WSOL routing.");

  const readKey = (offset: number) => new PublicKey(projectInfo.data.subarray(offset, offset + 32));
  const registeredMint = readKey(8);
  const quoteMint = readKey(40);
  const creator = readKey(72);
  const projectTreasury = readKey(104);
  const community = readKey(136);
  const protocolTreasury = readKey(168);
  const shares = {
    creator: projectInfo.data.readUInt16LE(200),
    liquidity: projectInfo.data.readUInt16LE(202),
    projectTreasury: projectInfo.data.readUInt16LE(204),
    community: projectInfo.data.readUInt16LE(206),
  };
  if (!registeredMint.equals(accounts.mint) || !quoteMint.equals(accounts.quoteMint)) throw new Error("SPLIT project mint or quote mismatch.");
  if (Object.values(shares).reduce((sum, value) => sum + value, 0) !== 10_000) throw new Error("Invalid on-chain fee shares.");
  const pool = LaunchpadPool.decode(poolInfo.data);
  if (!pool.mintA.equals(accounts.mint) || !pool.mintB.equals(accounts.quoteMint)) throw new Error("Raydium pool mint mismatch.");
  if (!pool.platformId.equals(config.platform) || !pool.creator.equals(creator)) throw new Error("Raydium pool platform or creator mismatch.");
  if (pool.migrateType !== 1 || ![0, 1, 2].includes(pool.status)) throw new Error("Unsupported Raydium migration or pool status.");
  if (protocolInfo.data.length < 104 || !protocolInfo.data.subarray(0, 8).equals(PROTOCOL_DISCRIMINATOR)) throw new Error("Invalid SPLIT protocol account.");
  const configuredTreasury = new PublicKey(protocolInfo.data.subarray(8, 40));
  const configuredRaydium = new PublicKey(protocolInfo.data.subarray(40, 72));
  const configuredPlatform = new PublicKey(protocolInfo.data.subarray(72, 104));
  if (!configuredTreasury.equals(SPLIT_PROTOCOL_TREASURY) || !configuredTreasury.equals(protocolTreasury) || !configuredRaydium.equals(config.raydium) || !configuredPlatform.equals(config.platform)) throw new Error("SPLIT protocol configuration mismatch.");

  return {
    mint: accounts.mint.toBase58(), pool: accounts.pool.toBase58(), creator: creator.toBase58(),
    projectTreasury: projectTreasury.toBase58(), community: community.toBase58(),
    platformConfig: config.platform.toBase58(), decimals: pool.mintDecimalsA,
    name: metadata.name, symbol: metadata.symbol, metadataUri: metadata.uri,
    status: pool.status === 2 ? "graduated" : pool.status === 1 ? "bonded" : "curve", shares,
    observedFinalizedSlot: response.context.slot,
  };
}
