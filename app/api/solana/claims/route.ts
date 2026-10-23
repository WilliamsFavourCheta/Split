import { createHash } from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { solanaCluster, solanaRpcUrl } from "../../../lib/solana/client";
import { isSolanaAddress } from "../../../lib/solana/launch-config";
import { deriveSolanaProjectAccounts, getSolanaDeploymentConfig, routerBackedSolanaMode, SPLIT_PROTOCOL_TREASURY } from "../../../lib/solana/raydium-accounts";
import { createServerSupabaseClient } from "../../../lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const PROJECT_DISCRIMINATOR = createHash("sha256").update("account:Project").digest().subarray(0, 8);
type ClaimRole = "protocol" | "creator" | "project_treasury" | "community";

export async function GET(request: Request) {
  if (!routerBackedSolanaMode) return Response.json({ error: "Router claims are unavailable in routerless Solana V1. View the public fee ledger for operator-managed payments." }, { status: 410 });
  const wallet = new URL(request.url).searchParams.get("wallet") ?? "";
  if (!isSolanaAddress(wallet)) return Response.json({ error: "Invalid Solana wallet address." }, { status: 400 });
  const deployment = getSolanaDeploymentConfig();
  if (!deployment) return Response.json({ error: "SPLIT Solana deployment is not configured." }, { status: 503 });
  try {
    const client = createServerSupabaseClient();
    const filters = [`creator_address.eq.${wallet}`, `project_treasury_address.eq.${wallet}`, `community_address.eq.${wallet}`];
    const query = client.from("solana_projects")
      .select("mint_address,symbol,creator_address,project_treasury_address,community_address")
      .eq("cluster", solanaCluster).eq("finalized", true).eq("is_hidden", false)
      .limit(100);
    const { data, error } = wallet === SPLIT_PROTOCOL_TREASURY.toBase58() ? await query : await query.or(filters.join(","));
    if (error) throw error;
    const projects = data ?? [];
    if (!projects.length) return Response.json({ entries: [], observedFinalizedSlot: null });
    const accountIds = projects.map((project) => deriveSolanaProjectAccounts(project.mint_address, deployment.router).project);
    const connection = new Connection(solanaRpcUrl, { commitment: "finalized" });
    const response = await connection.getMultipleAccountsInfoAndContext(accountIds, { commitment: "finalized" });
    const entries: Array<{ mint: string; symbol: string; role: ClaimRole; pendingWsolRaw: string; liquidityLockedWsolRaw: string }> = [];
    for (let index = 0; index < projects.length; index += 1) {
      const project = projects[index];
      const info = response.value[index];
      if (!info || !info.owner.equals(deployment.router) || info.data.length < 249
        || !info.data.subarray(0, 8).equals(PROJECT_DISCRIMINATOR)
        || !new PublicKey(info.data.subarray(8, 40)).equals(new PublicKey(project.mint_address))
        || !new PublicKey(info.data.subarray(72, 104)).equals(new PublicKey(project.creator_address))
        || !new PublicKey(info.data.subarray(104, 136)).equals(new PublicKey(project.project_treasury_address))
        || !new PublicKey(info.data.subarray(136, 168)).equals(new PublicKey(project.community_address))
        || !new PublicKey(info.data.subarray(168, 200)).equals(SPLIT_PROTOCOL_TREASURY)) continue;
      const roles: Array<[ClaimRole, string, number]> = [
        ["protocol", SPLIT_PROTOCOL_TREASURY.toBase58(), 209],
        ["creator", project.creator_address, 217],
        ["project_treasury", project.project_treasury_address, 225],
        ["community", project.community_address, 233],
      ];
      for (const [role, recipient, offset] of roles) {
        if (recipient === wallet) entries.push({ mint: project.mint_address, symbol: project.symbol,
          role, pendingWsolRaw: info.data.readBigUInt64LE(offset).toString(),
          liquidityLockedWsolRaw: info.data.readBigUInt64LE(241).toString() });
      }
    }
    return Response.json({ entries, observedFinalizedSlot: response.context.slot },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Solana claim balances unavailable", error);
    return Response.json({ error: "Solana claim balances are unavailable." }, { status: 503 });
  }
}
