import { createServerSupabaseClient } from "../../../lib/supabase/server";
import { solanaCluster } from "../../../lib/solana/client";
import { isSolanaAddress } from "../../../lib/solana/launch-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const creator = new URL(request.url).searchParams.get("creator") ?? "";
  if (!isSolanaAddress(creator)) return Response.json({ error: "Invalid creator wallet." }, { status: 400 });
  try {
    const { data, error } = await createServerSupabaseClient().from("solana_projects")
      .select("mint_address,pool_address,name,symbol,status,launched_at,fee_model")
      .eq("cluster", solanaCluster).eq("creator_address", creator).eq("finalized", true).eq("is_hidden", false)
      .order("launched_at", { ascending: false }).limit(100);
    if (error) throw error;
    return Response.json({ projects: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Creator project index is unavailable." }, { status: 503 });
  }
}
