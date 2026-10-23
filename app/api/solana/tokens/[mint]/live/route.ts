import { createHash } from "node:crypto";
import { CREATE_CPMM_POOL_PROGRAM, CpmmPoolInfoLayout, Curve, DEVNET_PROGRAM_ID, getCpmmPdaPoolId,
  getPdaLaunchpadPoolId, LaunchpadConfig, LaunchpadPool, PlatformConfig } from "@raydium-io/raydium-sdk-v2";
import { NATIVE_MINT } from "@solana/spl-token";
import { Connection } from "@solana/web3.js";
import { solanaCluster, solanaRpcUrl } from "../../../../../lib/solana/client";
import { isSolanaAddress } from "../../../../../lib/solana/launch-config";
import { deriveSolanaProjectAccounts, getSolanaDeploymentConfig, getRouterlessPlatformConfig, routerBackedSolanaMode } from "../../../../../lib/solana/raydium-accounts";
import { getSolanaProject } from "../../../../../lib/solana/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const POOL_DISCRIMINATOR = createHash("sha256").update("account:PoolState").digest().subarray(0, 8);
const CONFIG_DISCRIMINATOR = createHash("sha256").update("account:GlobalConfig").digest().subarray(0, 8);

export async function GET(_request: Request, { params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  if (!isSolanaAddress(mint)) return Response.json({ error: "Invalid mint." }, { status: 400 });
  try {
    const project = await getSolanaProject(mint);
    const deployment = routerBackedSolanaMode ? getSolanaDeploymentConfig() : getRouterlessPlatformConfig();
    if (!project || !deployment) return Response.json({ error: "Finalized SPLIT Solana project is unavailable." }, { status: 404 });
    const accounts = routerBackedSolanaMode && "router" in deployment
      ? deriveSolanaProjectAccounts(mint, deployment.router) : null;
    const mintKey = new (await import("@solana/web3.js")).PublicKey(mint);
    const poolAddress = accounts?.pool ?? getPdaLaunchpadPoolId(deployment.raydium, mintKey, NATIVE_MINT).publicKey;
    if (project.pool_address !== poolAddress.toBase58()) throw new Error("Indexed Raydium pool mismatch.");
    const connection = new Connection(solanaRpcUrl, { commitment: "finalized" });
    const poolInfo = await connection.getAccountInfoAndContext(poolAddress, "finalized");
    const poolAccount = poolInfo.value;
    if (!poolAccount || !poolAccount.owner.equals(deployment.raydium) || poolAccount.data.length < LaunchpadPool.span
      || !poolAccount.data.subarray(0, 8).equals(POOL_DISCRIMINATOR)) throw new Error("Invalid Raydium pool.");
    const pool = LaunchpadPool.decode(poolAccount.data);
    if (!pool.mintA.equals(mintKey) || !pool.mintB.equals(NATIVE_MINT)
      || !pool.platformId.equals(deployment.platform)) throw new Error("Raydium pool binding changed.");
    let cpmmPrice: number | null = null;
    if (pool.status === 2) {
      const platformAccount = await connection.getAccountInfo(deployment.platform, "finalized");
      if (!platformAccount || !platformAccount.owner.equals(deployment.raydium)
        || platformAccount.data.length !== PlatformConfig.span) throw new Error("Invalid platform config.");
      const platform = PlatformConfig.decode(platformAccount.data);
      const cpProgram = solanaCluster === "mainnet-beta" ? CREATE_CPMM_POOL_PROGRAM : DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM;
      const candidates = [getCpmmPdaPoolId(cpProgram, platform.cpConfigId, mintKey, NATIVE_MINT).publicKey,
        getCpmmPdaPoolId(cpProgram, platform.cpConfigId, NATIVE_MINT, mintKey).publicKey];
      for (const candidate of candidates) {
        const cpAccount = await connection.getAccountInfo(candidate, "finalized");
        if (!cpAccount || !cpAccount.owner.equals(cpProgram) || cpAccount.data.length !== CpmmPoolInfoLayout.span) continue;
        const cp = CpmmPoolInfoLayout.decode(cpAccount.data);
        if (!cp.configId.equals(platform.cpConfigId)
          || !((cp.mintA.equals(mintKey) && cp.mintB.equals(NATIVE_MINT))
            || (cp.mintB.equals(mintKey) && cp.mintA.equals(NATIVE_MINT)))) continue;
        const [a, b] = await Promise.all([connection.getTokenAccountBalance(cp.vaultA, "finalized"),
          connection.getTokenAccountBalance(cp.vaultB, "finalized")]);
        const amountA = Number(a.value.amount) / 10 ** cp.mintDecimalA;
        const amountB = Number(b.value.amount) / 10 ** cp.mintDecimalB;
        const base = cp.mintA.equals(mintKey) ? amountA : amountB;
        const quote = cp.mintA.equals(NATIVE_MINT) ? amountA : amountB;
        if (base > 0 && quote > 0) cpmmPrice = quote / base;
        break;
      }
      if (cpmmPrice === null) return Response.json({ status: "graduated", error: "CPMM pool price unavailable." }, { status: 409 });
    }
    const configInfo = await connection.getAccountInfo(pool.configId, { commitment: "finalized", minContextSlot: poolInfo.context.slot });
    if (!configInfo || !configInfo.owner.equals(deployment.raydium) || configInfo.data.length < LaunchpadConfig.span
      || !configInfo.data.subarray(0, 8).equals(CONFIG_DISCRIMINATOR)) throw new Error("Invalid Raydium curve configuration.");
    const config = LaunchpadConfig.decode(configInfo.data);
    const priceSol = pool.status === 2 ? cpmmPrice! : Curve.getPrice({ poolInfo: pool, curveType: config.curveType,
      decimalA: pool.mintDecimalsA, decimalB: pool.mintDecimalsB }).toNumber();
    const solResponse = await fetch("https://coins.llama.fi/prices/current/coingecko:solana",
      { next: { revalidate: 30 }, signal: AbortSignal.timeout(8_000) });
    if (!solResponse.ok) throw new Error("SOL/USD quote provider unavailable.");
    const quote = await solResponse.json() as { coins?: Record<string, { price?: unknown; timestamp?: unknown }> };
    const solUsd = quote.coins?.["coingecko:solana"]?.price;
    const timestamp = quote.coins?.["coingecko:solana"]?.timestamp;
    if (typeof solUsd !== "number" || !Number.isFinite(solUsd) || solUsd <= 0
      || typeof timestamp !== "number" || Math.abs(Date.now() / 1_000 - timestamp) > 600) {
      throw new Error("SOL/USD quote is stale or invalid.");
    }
    const priceUsd = priceSol * solUsd;
    const supply = Number(pool.supply.toString()) / 10 ** pool.mintDecimalsA;
    return Response.json({ status: pool.status === 2 ? "graduated" : pool.status === 1 ? "bonded" : "curve",
      sample: { slot: poolInfo.context.slot, sampled_at: new Date().toISOString(),
        price_usd: priceUsd, market_cap_usd: priceUsd * supply },
      price_sol: priceSol.toString(), sol_usd: solUsd, sol_usd_timestamp: timestamp,
      market_cap_basis: "fixed_total_supply" },
    { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Solana live market sample unavailable", error);
    return Response.json({ error: "Live finalized Solana market sample is unavailable." }, { status: 503 });
  }
}
