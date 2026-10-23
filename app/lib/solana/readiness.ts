import "server-only";
import { createHash } from "node:crypto";
import { CREATE_CPMM_POOL_PROGRAM, DEVNET_PROGRAM_ID, getPdaLaunchpadConfigId, LaunchpadConfig, PlatformConfig } from "@raydium-io/raydium-sdk-v2";
import { NATIVE_MINT } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { solanaCluster, solanaRpcUrl } from "./client";
import { getRouterlessPlatformConfig, routerBackedSolanaMode } from "./raydium-accounts";
import { getSolanaLaunchReadiness as getRouterReadiness } from "./router-readiness";

const discriminator = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const CPMM_PROGRAM = solanaCluster === "mainnet-beta" ? CREATE_CPMM_POOL_PROGRAM : DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM;
export type SolanaLaunchReadiness = {
  ready: boolean; cluster: "devnet" | "mainnet-beta"; observedFinalizedSlot: number | null;
  reasons: string[]; configId: string | null; platformId: string | null;
  programId: string | null; minimumFundraisingSol: string | null;
};

export async function getSolanaLaunchReadiness(): Promise<SolanaLaunchReadiness> {
  if (routerBackedSolanaMode) return getRouterReadiness();
  const state: SolanaLaunchReadiness = { ready: false, cluster: solanaCluster, observedFinalizedSlot: null,
    reasons: [], configId: null, platformId: null, programId: null, minimumFundraisingSol: null };
  const config = getRouterlessPlatformConfig();
  if (!config) { state.reasons.push("SPLIT PlatformConfig and ordinary fee wallet must be configured."); return state; }
  state.platformId = config.platform.toBase58();
  state.programId = config.raydium.toBase58();
  const globalId = getPdaLaunchpadConfigId(config.raydium, NATIVE_MINT, 0, 0).publicKey;
  state.configId = globalId.toBase58();
  const connection = new Connection(solanaRpcUrl, "finalized");
  const response = await connection.getMultipleAccountsInfoAndContext(
    [config.raydium, config.platform, globalId, NATIVE_MINT], { commitment: "finalized" });
  state.observedFinalizedSlot = response.context.slot;
  const [program, platformAccount, globalAccount, quoteMint] = response.value;
  if (!program?.executable) state.reasons.push("Raydium LaunchLab program is unavailable.");
  if (!platformAccount || !platformAccount.owner.equals(config.raydium)
    || platformAccount.data.length !== PlatformConfig.span
    || !platformAccount.data.subarray(0, 8).equals(discriminator("PlatformConfig"))) {
    state.reasons.push("SPLIT Raydium PlatformConfig has not been created.");
  } else {
    const platform = PlatformConfig.decode(platformAccount.data);
    if (!platform.platformClaimFeeWallet.equals(config.feeWallet) || !platform.feeRate.eqn(10_000)
      || !platform.creatorFeeRate.isZero()) state.reasons.push("Platform fee wallet or rates do not match the approved routerless model.");
    if (platform.cpConfigId.equals(PublicKey.default)) state.reasons.push("CPMM graduation config is unset.");
    else {
      const cpAccount = await connection.getAccountInfo(platform.cpConfigId, "finalized");
      if (!cpAccount || !cpAccount.owner.equals(CPMM_PROGRAM)) state.reasons.push("CPMM graduation config is unavailable.");
    }
  }
  if (!globalAccount || !globalAccount.owner.equals(config.raydium)
    || globalAccount.data.length !== LaunchpadConfig.span
    || !globalAccount.data.subarray(0, 8).equals(discriminator("GlobalConfig"))) {
    state.reasons.push("Raydium WSOL curve config is unavailable.");
  } else {
    const global = LaunchpadConfig.decode(globalAccount.data);
    if (!global.mintB.equals(NATIVE_MINT) || global.curveType !== 0 || global.index !== 0) state.reasons.push("Raydium WSOL curve config changed.");
    state.minimumFundraisingSol = (Number(global.minFundRaisingB.toString()) / 1_000_000_000).toString();
  }
  if (!quoteMint) state.reasons.push("WSOL mint unavailable.");
  state.ready = state.reasons.length === 0;
  return state;
}
