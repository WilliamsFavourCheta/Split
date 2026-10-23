import "server-only";
import { createHash } from "node:crypto";
import { LaunchpadConfig, PlatformConfig, getPdaLaunchpadConfigId } from "@raydium-io/raydium-sdk-v2";
import { NATIVE_MINT } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { solanaCluster, solanaRpcUrl } from "./client";
import { getSolanaDeploymentConfig, SPLIT_PROTOCOL_TREASURY } from "./raydium-accounts";

const discriminator = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const PROTOCOL_DISCRIMINATOR = discriminator("Protocol");
const PLATFORM_DISCRIMINATOR = discriminator("PlatformConfig");
const GLOBAL_DISCRIMINATOR = discriminator("GlobalConfig");
const SUPPLY_RAW = BigInt(1_000_000_000) * BigInt(1_000_000);

export type SolanaLaunchReadiness = {
  ready: boolean;
  cluster: "devnet" | "mainnet-beta";
  observedFinalizedSlot: number | null;
  reasons: string[];
  configId: string | null;
  platformId: string | null;
  programId: string | null;
  minimumFundraisingSol: string | null;
};

/** Public readiness only. Re-run these checks immediately before building a launch transaction. */
export async function getSolanaLaunchReadiness(): Promise<SolanaLaunchReadiness> {
  const state: SolanaLaunchReadiness = {
    ready: false, cluster: solanaCluster, observedFinalizedSlot: null,
    reasons: [], configId: null, platformId: null, programId: null, minimumFundraisingSol: null,
  };
  const deployment = getSolanaDeploymentConfig();
  if (!deployment) {
    state.reasons.push("SPLIT program ID or Raydium PlatformConfig is not configured for this cluster.");
    return state;
  }
  state.programId = deployment.router.toBase58();
  state.platformId = deployment.platform.toBase58();
  const configId = getPdaLaunchpadConfigId(deployment.raydium, NATIVE_MINT, 0, 0).publicKey;
  state.configId = configId.toBase58();
  const [protocol] = PublicKey.findProgramAddressSync([Buffer.from("protocol")], deployment.router);
  const [feeWallet] = PublicKey.findProgramAddressSync([Buffer.from("fee_wallet")], deployment.router);
  const connection = new Connection(solanaRpcUrl, { commitment: "finalized" });
  const response = await connection.getMultipleAccountsInfoAndContext(
    [deployment.router, protocol, deployment.platform, configId, NATIVE_MINT],
    { commitment: "finalized" },
  );
  state.observedFinalizedSlot = response.context.slot;
  const [programInfo, protocolInfo, platformInfo, globalInfo, quoteInfo] = response.value;
  if (!programInfo?.executable) state.reasons.push("SPLIT fee router has not been deployed.");
  if (!protocolInfo || !protocolInfo.owner.equals(deployment.router) || protocolInfo.data.length < 104
    || !protocolInfo.data.subarray(0, 8).equals(PROTOCOL_DISCRIMINATOR)) {
    state.reasons.push("SPLIT protocol has not been initialized.");
  } else {
    const treasury = new PublicKey(protocolInfo.data.subarray(8, 40));
    const raydium = new PublicKey(protocolInfo.data.subarray(40, 72));
    const platform = new PublicKey(protocolInfo.data.subarray(72, 104));
    if (!treasury.equals(SPLIT_PROTOCOL_TREASURY) || !raydium.equals(deployment.raydium)
      || !platform.equals(deployment.platform)) state.reasons.push("SPLIT protocol addresses do not match the approved deployment.");
  }
  if (!platformInfo || !platformInfo.owner.equals(deployment.raydium) || platformInfo.data.length < PlatformConfig.span
    || !platformInfo.data.subarray(0, 8).equals(PLATFORM_DISCRIMINATOR)) {
    state.reasons.push("Raydium PlatformConfig has not been created.");
  } else {
    const platform = PlatformConfig.decode(platformInfo.data);
    if (!platform.platformClaimFeeWallet.equals(feeWallet) || !platform.feeRate.eqn(10_000)
      || !platform.creatorFeeRate.isZero()) state.reasons.push("Raydium platform fees do not match SPLIT's 1% WSOL routing.");
    if (!platform.cpConfigId || platform.cpConfigId.equals(PublicKey.default)) state.reasons.push("Raydium CPMM graduation config is not set.");
  }
  if (!globalInfo || !globalInfo.owner.equals(deployment.raydium) || globalInfo.data.length < LaunchpadConfig.span
    || !globalInfo.data.subarray(0, 8).equals(GLOBAL_DISCRIMINATOR)) {
    state.reasons.push("A compatible Raydium WSOL GlobalConfig is unavailable.");
  } else {
    const global = LaunchpadConfig.decode(globalInfo.data);
    if (!global.mintB.equals(NATIVE_MINT) || global.curveType !== 0 || global.index !== 0) state.reasons.push("Raydium curve config does not match SPLIT's launch parameters.");
    if (BigInt(global.minSupplyA.toString()) > SUPPLY_RAW) state.reasons.push("The planned supply is below Raydium's minimum.");
    state.minimumFundraisingSol = (Number(global.minFundRaisingB.toString()) / 1_000_000_000).toString();
  }
  if (!quoteInfo) state.reasons.push("WSOL mint is unavailable from the selected RPC.");
  state.ready = state.reasons.length === 0;
  return state;
}
