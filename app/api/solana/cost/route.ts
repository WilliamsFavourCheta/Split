import BN from "bn.js";
import { CREATE_CPMM_POOL_PROGRAM, createPlatformConfig, DEVNET_PROGRAM_ID, PlatformConfig } from "@raydium-io/raydium-sdk-v2";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { solanaCluster, solanaRpcUrl } from "../../../lib/solana/client";
import { getRouterlessPlatformConfig } from "../../../lib/solana/raydium-accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAINNET_CPMM_CONFIG = "D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2";
const CPMM_PROGRAM = solanaCluster === "mainnet-beta" ? CREATE_CPMM_POOL_PROGRAM : DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM;

export async function GET() {
  try {
    const config = getRouterlessPlatformConfig();
    if (!config) throw new Error("SPLIT platform and fee wallet must be configured before quoting.");
    const connection = new Connection(solanaRpcUrl, "finalized");
    const cpAddress = process.env.NEXT_PUBLIC_SPLIT_SOLANA_CPMM_CONFIG
      || (solanaCluster === "mainnet-beta" ? MAINNET_CPMM_CONFIG : "");
    if (!cpAddress) throw new Error("Devnet CPMM config is not configured.");
    const cpConfig = new PublicKey(cpAddress);
    const cpAccount = await connection.getAccountInfo(cpConfig, "finalized");
    if (!cpAccount || !cpAccount.owner.equals(CPMM_PROGRAM))
      throw new Error("Selected Raydium CPMM config is unavailable.");
    const platformAccount = await connection.getAccountInfo(config.platform, "finalized");
    const ix = createPlatformConfig(config.raydium, config.admin, config.feeWallet,
      config.admin, config.admin, config.platform, cpConfig, config.admin,
      { platformScale: new BN(0), creatorScale: new BN(0), burnScale: new BN(1_000_000) },
      new BN(10_000), new BN(0), "SPLIT", "", "", new BN(0));
    const blockhash = await connection.getLatestBlockhash("finalized");
    const unsigned = new Transaction({ feePayer: config.admin, recentBlockhash: blockhash.blockhash }).add(ix);
    const platformNetworkFee = await connection.getFeeForMessage(unsigned.compileMessage(), "finalized");
    const [platformRent, mintRent, poolRent, vaultRent, metadataRent, feeWalletAtaRent] = await Promise.all(
      [PlatformConfig.span, 82, 429, 165, 679, 165].map((size) => connection.getMinimumBalanceForRentExemption(size, "finalized")));
    const quoteResponse = await fetch("https://coins.llama.fi/prices/current/coingecko:solana", { cache: "no-store", signal: AbortSignal.timeout(8_000) });
    const quote = await quoteResponse.json() as { coins?: Record<string, { price?: number; timestamp?: number }> };
    const usd = quote.coins?.["coingecko:solana"]?.price;
    const timestamp = quote.coins?.["coingecko:solana"]?.timestamp;
    if (!quoteResponse.ok || !usd || !timestamp || Math.abs(Date.now() / 1000 - timestamp) > 600) throw new Error("Fresh SOL/USD quote unavailable.");
    const documentedLaunchCharge = 100_000_000;
    const firstTokenEstimate = documentedLaunchCharge + mintRent + poolRent + 2 * vaultRent + metadataRent + 25_000;
    const oneTime = platformAccount ? 0 : platformRent + (platformNetworkFee.value ?? 5_000);
    const total = oneTime + firstTokenEstimate + feeWalletAtaRent;
    const fundingReserve = 150_000_000;
    return Response.json({ cluster: solanaCluster, solUsd: usd, quoteTimestamp: timestamp,
      withinBudget: fundingReserve / 1_000_000_000 * usd <= 20 && total <= fundingReserve,
      oneTimeLamports: oneTime, firstTokenEstimatedLamports: firstTokenEstimate,
      claimAtaRentLamports: feeWalletAtaRent, totalEstimatedLamports: total,
      recommendedFundingLamports: fundingReserve, platformNetworkFeeLamports: platformNetworkFee.value,
      platformConfigExists: Boolean(platformAccount),
      unsignedPlatformTransactionBase64: platformAccount ? null : unsigned.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      firstTokenTransactionConstructed: false,
      limitation: "The SPLIT first-token SDK transaction can be built only after its PlatformConfig exists; 0.1 SOL is the documented LaunchLab launch allowance, not a live instruction quote. No transaction has been submitted." },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Cost quote failed." }, { status: 503 });
  }
}
