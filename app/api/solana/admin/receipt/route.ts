import { createHash } from "node:crypto";
import { getBase58Encoder } from "@solana/kit";
import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { requireAdminSignature } from "../../../../lib/solana/admin-auth";
import { solanaRpcUrl } from "../../../../lib/solana/client";
import { isSolanaAddress } from "../../../../lib/solana/launch-config";
import { calculateOperatorAllocation } from "../../../../lib/solana/routerless-policy";
import { createIndexerSupabaseClient } from "../../../../lib/supabase/server";
import { verifySolanaLaunch } from "../../../../lib/solana/verify-launch";
import { SPLIT_PROTOCOL_TREASURY } from "../../../../lib/solana/raydium-accounts";

export const runtime = "nodejs";
const CLAIM = createHash("sha256").update("global:claim_platform_fee").digest().subarray(0, 8);
const TX_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

export async function POST(request: Request) {
  try {
    const body = await request.json() as { mint?: string; wallet?: string; nonce?: string; signature?: string; claimSignature?: string };
    if (!body.mint || !isSolanaAddress(body.mint) || !body.wallet || !body.nonce || !body.signature
      || !body.claimSignature || !TX_SIGNATURE.test(body.claimSignature))
      return Response.json({ error: "Invalid receipt request." }, { status: 400 });
    const config = await requireAdminSignature({ purpose: "receipt", mint: body.mint,
      wallet: body.wallet, nonce: body.nonce, signature: body.signature });
    const launch = await verifySolanaLaunch(body.mint);
    const db = createIndexerSupabaseClient();
    const { data: project, error: projectError } = await db.from("solana_projects")
      .select("id,creator_address,project_treasury_address,community_address,creator_bps,liquidity_bps,treasury_bps,community_bps,fee_model")
      .eq("cluster", process.env.NEXT_PUBLIC_SOLANA_CLUSTER === "mainnet-beta" ? "mainnet-beta" : "devnet")
      .eq("mint_address", body.mint).eq("finalized", true).single();
    if (projectError || !project || project.fee_model !== "operator_managed" || project.creator_address !== launch.creator)
      throw new Error("Indexed routerless project is unavailable.");
    const connection = new Connection(solanaRpcUrl, "finalized");
    const tx = await connection.getParsedTransaction(body.claimSignature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    if (!tx || tx.meta?.err || !tx.meta) throw new Error("Raydium claim is not finalized.");
    const ata = getAssociatedTokenAddressSync(NATIVE_MINT, config.feeWallet);
    const claimIndexes: number[] = [];
    tx.transaction.message.instructions.forEach((ix, index) => {
      if (!("data" in ix) || !ix.programId.equals(config.raydium)) return;
      const data = Buffer.from(getBase58Encoder().encode(ix.data));
      if (data.subarray(0, 8).equals(CLAIM)
        && ix.accounts.some((key) => key.equals(new PublicKey(launch.pool)))
        && ix.accounts.some((key) => key.equals(config.platform))
        && ix.accounts.some((key) => key.equals(config.feeWallet))
        && ix.accounts.some((key) => key.equals(ata))) claimIndexes.push(index);
    });
    if (claimIndexes.length !== 1) throw new Error("Expected one SPLIT pool-specific Raydium claim.");
    const inner = tx.meta.innerInstructions?.find((item) => item.index === claimIndexes[0])?.instructions ?? [];
    const transfers = inner.filter((ix) => "parsed" in ix && ix.program === "spl-token"
      && (ix.parsed.type === "transfer" || ix.parsed.type === "transferChecked")
      && ix.parsed.info?.destination === ata.toBase58());
    if (transfers.length !== 1 || !("parsed" in transfers[0])) throw new Error("Pool claim transfer cannot be attributed.");
    const transfer = transfers[0].parsed.info as { source?: string; amount?: string; tokenAmount?: { amount?: string } };
    const amount = BigInt(transfer.tokenAmount?.amount ?? transfer.amount ?? "0");
    if (amount <= BigInt(0)) throw new Error("Pool claim amount is zero.");
    const poolAccount = await connection.getAccountInfo(new PublicKey(launch.pool), "finalized");
    if (!poolAccount) throw new Error("Raydium pool is unavailable.");
    const { LaunchpadPool } = await import("@raydium-io/raydium-sdk-v2");
    const pool = LaunchpadPool.decode(poolAccount.data);
    if (transfer.source !== pool.vaultB.toBase58()) throw new Error("Claim transfer source is not this pool's quote vault.");
    const split = calculateOperatorAllocation(amount, {
      creator: project.creator_bps / 100, liquidity: project.liquidity_bps / 100,
      projectTreasury: project.treasury_bps / 100, community: project.community_bps / 100 });
    const recipients = { protocol: SPLIT_PROTOCOL_TREASURY.toBase58(), creator: project.creator_address,
      liquidity: null, projectTreasury: project.project_treasury_address, community: project.community_address };
    const allocations = Object.entries(split).map(([destination, value]) => ({
      destination: destination === "projectTreasury" ? "project_treasury" : destination,
      recipient: recipients[destination as keyof typeof recipients], amount: value.toString() }));
    const { data: receiptId, error } = await db.rpc("record_solana_fee_receipt", {
      p_project_id: project.id, p_signature: body.claimSignature, p_slot: tx.slot,
      p_amount: amount.toString(), p_recipient_token_account: ata.toBase58(), p_allocations: allocations });
    if (error) throw error;
    return Response.json({ receiptId, mint: body.mint, pool: launch.pool, amountWsolRaw: amount.toString(), allocations },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Fee receipt verification failed." }, { status: 409 });
  }
}
