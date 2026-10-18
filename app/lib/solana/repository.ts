import "server-only";
import { createServerSupabaseClient } from "../supabase/server";
import { solanaCluster } from "./client";
import { isSolanaAddress } from "./launch-config";

export type SolanaProjectRecord = {
  mint_address: string;
  pool_address: string;
  creator_address: string;
  name: string;
  symbol: string;
  decimals: number;
  status: "curve" | "graduated";
  launched_at: string | null;
  creator_bps: number;
  liquidity_bps: number;
  treasury_bps: number;
  community_bps: number;
};

export type SolanaPriceSample = {
  slot: number;
  sampled_at: string;
  price_usd: number | null;
  market_cap_usd: number | null;
};

export type SolanaTradeRecord = {
  signature: string;
  slot: number;
  traded_at: string;
  side: "buy" | "sell";
  base_amount_raw: string;
  quote_amount_raw: string;
};

const isProject = (row: SolanaProjectRecord) =>
  isSolanaAddress(row.mint_address) && isSolanaAddress(row.pool_address)
  && isSolanaAddress(row.creator_address)
  && (row.status === "curve" || row.status === "graduated")
  && typeof row.name === "string" && typeof row.symbol === "string";

export async function getSolanaProjects() {
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase.from("solana_projects")
    .select("mint_address,pool_address,creator_address,name,symbol,decimals,status,launched_at,creator_bps,liquidity_bps,treasury_bps,community_bps")
    .eq("cluster", solanaCluster).eq("finalized", true).eq("is_hidden", false)
    .order("launched_at", { ascending: false }).limit(100);
  if (error) throw new Error(`Solana project index unavailable: ${error.code}`);
  return ((data ?? []) as SolanaProjectRecord[]).filter(isProject);
}

export async function getSolanaProject(mint: string) {
  if (!isSolanaAddress(mint)) return null;
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase.from("solana_projects")
    .select("mint_address,pool_address,creator_address,name,symbol,decimals,status,launched_at,creator_bps,liquidity_bps,treasury_bps,community_bps")
    .eq("cluster", solanaCluster).eq("mint_address", mint).eq("finalized", true).eq("is_hidden", false)
    .maybeSingle();
  if (error) throw new Error(`Solana project index unavailable: ${error.code}`);
  return data && isProject(data as SolanaProjectRecord) ? data as SolanaProjectRecord : null;
}

export async function getSolanaProjectFeed(projectMint: string) {
  const supabase = createServerSupabaseClient();
  const { data: project, error: projectError } = await supabase.from("solana_projects")
    .select("id").eq("cluster", solanaCluster).eq("mint_address", projectMint)
    .eq("finalized", true).eq("is_hidden", false).maybeSingle();
  if (projectError) throw new Error(`Solana project index unavailable: ${projectError.code}`);
  if (!project) return { samples: [] as SolanaPriceSample[], trades: [] as SolanaTradeRecord[] };
  const [prices, trades] = await Promise.all([
    supabase.from("solana_price_samples")
      .select("slot,sampled_at,price_usd,market_cap_usd")
      .eq("project_id", project.id).eq("finalized", true)
      .order("slot", { ascending: false }).limit(100),
    supabase.from("solana_trades")
      .select("signature,slot,traded_at,side,base_amount_raw,quote_amount_raw")
      .eq("project_id", project.id).eq("finalized", true)
      .order("slot", { ascending: false }).limit(25),
  ]);
  if (prices.error || trades.error) throw new Error("Solana market feed unavailable.");
  return {
    samples: ((prices.data ?? []) as SolanaPriceSample[]).reverse(),
    trades: (trades.data ?? []) as SolanaTradeRecord[],
  };
}
