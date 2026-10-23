import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { requireAdminSignature } from "../../../../lib/solana/admin-auth";
import { solanaCluster, solanaRpcUrl } from "../../../../lib/solana/client";
import { isSolanaAddress } from "../../../../lib/solana/launch-config";
import { createIndexerSupabaseClient } from "../../../../lib/supabase/server";

export const runtime = "nodejs";
const TX_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const body = await request.json() as { mint?: string; wallet?: string; nonce?: string; signature?: string;
      receiptId?: string; destination?: string; payoutSignature?: string; instructionIndex?: number };
    if (!body.mint || !isSolanaAddress(body.mint) || !body.wallet || !body.nonce || !body.signature
      || !body.receiptId || !UUID.test(body.receiptId) || !body.payoutSignature || !TX_SIGNATURE.test(body.payoutSignature)
      || !["protocol", "creator", "project_treasury", "community"].includes(body.destination ?? "")
      || !Number.isInteger(body.instructionIndex) || body.instructionIndex! < 0)
      return Response.json({ error: "Invalid payout reconciliation request." }, { status: 400 });
    const config = await requireAdminSignature({ purpose: "payout", mint: body.mint,
      wallet: body.wallet, nonce: body.nonce, signature: body.signature });
    const db = createIndexerSupabaseClient();
    const { data: project } = await db.from("solana_projects").select("id")
      .eq("cluster", solanaCluster).eq("mint_address", body.mint).eq("finalized", true).single();
    const { data: receipt } = await db.from("solana_fee_receipts").select("id")
      .eq("id", body.receiptId).eq("project_id", project?.id ?? "").eq("finalized", true).single();
    const { data: allocation } = await db.from("solana_fee_allocations")
      .select("recipient_address,amount_wsol_raw").eq("receipt_id", receipt?.id ?? "")
      .eq("destination", body.destination).single();
    if (!project || !receipt || !allocation || !allocation.recipient_address) throw new Error("No verified outstanding allocation.");
    const recipient = new PublicKey(allocation.recipient_address);
    const sourceAta = getAssociatedTokenAddressSync(NATIVE_MINT, config.feeWallet);
    const recipientAta = getAssociatedTokenAddressSync(NATIVE_MINT, recipient);
    const connection = new Connection(solanaRpcUrl, "finalized");
    const tx = await connection.getParsedTransaction(body.payoutSignature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    if (!tx || tx.meta?.err || !tx.meta) throw new Error("Payout transaction is not finalized.");
    const ix = tx.transaction.message.instructions[body.instructionIndex!];
    if (!ix || !("parsed" in ix) || ix.program !== "spl-token"
      || !["transfer", "transferChecked"].includes(ix.parsed.type)
      || ix.parsed.info?.source !== sourceAta.toBase58() || ix.parsed.info?.destination !== recipientAta.toBase58())
      throw new Error("Payout is not a SPLIT wallet WSOL transfer to the expected recipient.");
    const raw = ix.parsed.info?.tokenAmount?.amount ?? ix.parsed.info?.amount;
    const amount = BigInt(raw ?? "0");
    if (amount <= BigInt(0)) throw new Error("Payout amount is zero.");
    const recipientAccountIndex = tx.transaction.message.accountKeys.findIndex((account) => account.pubkey.equals(recipientAta));
    const tokenBalance = tx.meta.postTokenBalances?.find((item) => item.accountIndex === recipientAccountIndex
      && item.mint === NATIVE_MINT.toBase58() && item.owner === recipient.toBase58());
    if (!tokenBalance) throw new Error("Recipient WSOL account authority could not be verified.");
    const { data: payoutId, error } = await db.rpc("record_solana_payout", {
      p_receipt_id: receipt.id, p_destination: body.destination, p_recipient: recipient.toBase58(),
      p_amount: amount.toString(), p_signature: body.payoutSignature,
      p_instruction_index: body.instructionIndex, p_slot: tx.slot });
    if (error) throw error;
    return Response.json({ payoutId, amountWsolRaw: amount.toString(), signature: body.payoutSignature },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Payout verification failed." }, { status: 409 });
  }
}
