import { solanaCluster } from "../../../lib/solana/client";
import { isSolanaAddress } from "../../../lib/solana/launch-config";
import { createServerSupabaseClient } from "../../../lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const mint = new URL(request.url).searchParams.get("mint") ?? "";
  if (!isSolanaAddress(mint)) return Response.json({ error: "Invalid token mint." }, { status: 400 });
  try {
    const db = createServerSupabaseClient();
    const { data: project, error: projectError } = await db.from("solana_projects")
      .select("id,mint_address,fee_model,creator_bps,liquidity_bps,treasury_bps,community_bps")
      .eq("cluster", solanaCluster).eq("mint_address", mint).eq("finalized", true).eq("is_hidden", false).maybeSingle();
    if (projectError) throw projectError;
    if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
    if (project.fee_model !== "operator_managed") return Response.json({ model: "router", receipts: [] });
    const { data: receipts, error } = await db.from("solana_fee_receipts")
      .select("id,signature,slot,amount_wsol_raw,recipient_token_account,recorded_at")
      .eq("project_id", project.id).eq("finalized", true).order("slot", { ascending: false }).limit(100);
    if (error) throw error;
    const ids = (receipts ?? []).map((receipt) => receipt.id);
    if (!ids.length) return Response.json({ model: "operator_managed", receipts: [], attribution: "No verified per-pool claim receipts yet." });
    const [allocationsResult, payoutsResult] = await Promise.all([
      db.from("solana_fee_allocations").select("receipt_id,destination,recipient_address,amount_wsol_raw").in("receipt_id", ids),
      db.from("solana_payouts").select("receipt_id,destination,recipient_address,amount_wsol_raw,signature,slot")
        .in("receipt_id", ids).eq("finalized", true),
    ]);
    if (allocationsResult.error || payoutsResult.error) throw new Error("Fee ledger is incomplete.");
    const result = (receipts ?? []).map((receipt) => {
      const allocations = (allocationsResult.data ?? []).filter((row) => row.receipt_id === receipt.id).map((row) => {
        const payouts = (payoutsResult.data ?? []).filter((payment) => payment.receipt_id === receipt.id
          && payment.destination === row.destination && payment.recipient_address === row.recipient_address);
        const paid = payouts.reduce((sum, payment) => sum + BigInt(payment.amount_wsol_raw), BigInt(0));
        const due = BigInt(row.amount_wsol_raw);
        return { destination: row.destination, recipient: row.recipient_address, dueWsolRaw: due.toString(),
          confirmedPaidWsolRaw: paid.toString(), outstandingWsolRaw: (due - paid).toString(), payouts,
          status: row.destination === "liquidity" ? "reserved_by_operator" : paid >= due ? "confirmed" : paid > 0 ? "partial" : "unpaid" };
      });
      return { ...receipt, allocations, reconciliation: allocations.length === 5 ? "calculated" : "incomplete" };
    });
    return Response.json({ model: "operator_managed", receipts: result,
      custody: "SPLIT controls claimed fees until it signs payout transactions. Allocations are policy, not program-enforced." },
      { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Public fee ledger is unavailable." }, { status: 503 });
  }
}
