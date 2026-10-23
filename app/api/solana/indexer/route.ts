import { timingSafeEqual, createHash } from "node:crypto";
import { getPdaLaunchpadPoolId, LaunchpadPool } from "@raydium-io/raydium-sdk-v2";
import { NATIVE_MINT } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { solanaCluster, solanaRpcUrl } from "../../../lib/solana/client";
import { getRouterlessPlatformConfig } from "../../../lib/solana/raydium-accounts";
import { createIndexerSupabaseClient } from "../../../lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const POOL = createHash("sha256").update("account:PoolState").digest().subarray(0, 8);

function authorized(request: Request) {
  const secret = process.env.SPLIT_INDEXER_CRON_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!secret) return false;
  const a = Buffer.from(secret), b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized indexer request." }, { status: 401 });
  try {
    const config = getRouterlessPlatformConfig();
    if (!config) throw new Error("Routerless platform is not configured.");
    const db = createIndexerSupabaseClient();
    const { data: projects, error } = await db.from("solana_projects")
      .select("id,mint_address,pool_address,status").eq("cluster", solanaCluster)
      .eq("fee_model", "operator_managed").eq("finalized", true).limit(100);
    if (error) throw error;
    const mints = (projects ?? []).map((project) => new PublicKey(project.mint_address));
    const pools = mints.map((mint) => getPdaLaunchpadPoolId(config.raydium, mint, NATIVE_MINT).publicKey);
    const connection = new Connection(solanaRpcUrl, "finalized");
    const response = pools.length ? await connection.getMultipleAccountsInfoAndContext(pools, { commitment: "finalized" }) : null;
    let updated = 0;
    for (let i = 0; i < (projects ?? []).length; i++) {
      const project = projects![i];
      const account = response?.value[i];
      if (!account || !account.owner.equals(config.raydium) || account.data.length !== LaunchpadPool.span
        || !account.data.subarray(0, 8).equals(POOL) || project.pool_address !== pools[i].toBase58()) continue;
      const pool = LaunchpadPool.decode(account.data);
      if (!pool.mintA.equals(mints[i]) || !pool.mintB.equals(NATIVE_MINT)
        || !pool.platformId.equals(config.platform) || ![0, 1, 2].includes(pool.status)) continue;
      const status = pool.status === 2 ? "graduated" : pool.status === 1 ? "bonded" : "curve";
      if (status === project.status) continue;
      const { error: updateError } = await db.from("solana_projects").update({ status }).eq("id", project.id)
        .eq("status", project.status);
      if (updateError) throw updateError;
      updated += 1;
    }
    return Response.json({ checked: projects?.length ?? 0, updated, finalizedSlot: response?.context.slot ?? null });
  } catch {
    return Response.json({ error: "Solana status indexer failed." }, { status: 503 });
  }
}
