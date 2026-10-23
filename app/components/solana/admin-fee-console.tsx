"use client";

import { getBase58Decoder } from "@solana/kit";
import { useClient, useSignAndSendTransaction, useSignMessage } from "@solana/react";
import { useConnectedWallet } from "@solana/kit-plugin-wallet/react";
import { Connection } from "@solana/web3.js";
import { useState } from "react";
import { solanaCluster, solanaRpcUrl, type SplitSolanaClient } from "../../lib/solana/client";
import { isSolanaAddress } from "../../lib/solana/launch-config";

type Prepared = { transaction: string; mint: string; pool: string; wallet: string;
  recipientTokenAccount: string; expectedAvailableWsolRaw: string };

export function SolanaAdminFeeConsole() {
  const client = useClient<SplitSolanaClient>();
  const connected = useConnectedWallet(client);
  if (!connected) return <div className="section-shell solana-page"><h1>SPLIT fee operator</h1><p>Connect the configured SPLIT fee wallet to prepare a pool-specific Raydium claim.</p></div>;
  return <ConnectedConsole key={connected.account.address} account={connected.account} />;
}

function ConnectedConsole({ account }: { account: NonNullable<ReturnType<typeof useConnectedWallet>>["account"] }) {
  const signMessage = useSignMessage(account);
  const signAndSend = useSignAndSendTransaction(account, solanaCluster === "mainnet-beta" ? "solana:mainnet" : "solana:devnet");
  const [mint, setMint] = useState("");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [receiptId, setReceiptId] = useState("");
  const [payoutSignature, setPayoutSignature] = useState("");
  const [destination, setDestination] = useState("creator");
  const [instructionIndex, setInstructionIndex] = useState(0);

  async function authorize(purpose: "claim" | "receipt" | "payout") {
    const challengeResponse = await fetch("/api/solana/admin/challenge", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose, mint }) });
    const challenge = await challengeResponse.json() as { message?: string; nonce?: string; wallet?: string; error?: string };
    if (!challengeResponse.ok || !challenge.message || !challenge.nonce || challenge.wallet !== account.address)
      throw new Error(challenge.error || "Connected wallet is not SPLIT's configured fee wallet.");
    const signed = await signMessage({ message: new TextEncoder().encode(challenge.message) });
    const signature = btoa(String.fromCharCode(...signed.signature));
    return { mint, wallet: account.address, nonce: challenge.nonce, signature };
  }

  async function prepare() {
    setBusy(true); setError(""); setPrepared(null);
    try {
      if (!isSolanaAddress(mint)) throw new Error("Enter a valid SPLIT token mint.");
      const auth = await authorize("claim");
      const response = await fetch("/api/solana/admin/claim", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(auth) });
      const result = await response.json() as (Prepared & { error?: string });
      if (!response.ok || !result.transaction) throw new Error(result.error || "Claim preparation failed.");
      setPrepared(result); setStatus("Review the pool, wallet, recipient and amount before signing.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Claim preparation failed."); }
    finally { setBusy(false); }
  }

  async function submit() {
    if (!prepared || prepared.wallet !== account.address) return;
    setBusy(true); setError("");
    try {
      const bytes = Uint8Array.from(atob(prepared.transaction), (char) => char.charCodeAt(0));
      const sent = await signAndSend({ transaction: bytes });
      const claimSignature = getBase58Decoder().decode(sent.signature);
      setStatus(`Submitted ${claimSignature}; waiting for finalization.`);
      const connection = new Connection(solanaRpcUrl, "finalized");
      const deadline = Date.now() + 120_000;
      let confirmed = false;
      while (Date.now() < deadline) {
        const state = (await connection.getSignatureStatuses([claimSignature], { searchTransactionHistory: true })).value[0];
        if (state?.err) throw new Error(`Raydium claim failed: ${JSON.stringify(state.err)}`);
        if (state?.confirmationStatus === "finalized") { confirmed = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      if (!confirmed) throw new Error(`Claim ${claimSignature} may be pending. Verify it before retrying.`);
      setStatus(`Claim finalized: ${claimSignature}. Recording pool-specific receipt.`);
      const auth = await authorize("receipt");
      const response = await fetch("/api/solana/admin/receipt", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...auth, claimSignature }) });
      const result = await response.json() as { receiptId?: string; error?: string };
      if (!response.ok || !result.receiptId) throw new Error(`Claim finalized but receipt needs reconciliation: ${result.error || claimSignature}`);
      setStatus(`Claim finalized and receipt ${result.receiptId} recorded. No payout was sent.`);
      setPrepared(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Claim failed."); }
    finally { setBusy(false); }
  }

  async function reconcilePayout() {
    setBusy(true); setError("");
    try {
      if (!isSolanaAddress(mint)) throw new Error("Enter the payout token mint.");
      const auth = await authorize("payout");
      const response = await fetch("/api/solana/admin/payout", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...auth, receiptId, destination, payoutSignature, instructionIndex }) });
      const result = await response.json() as { payoutId?: string; error?: string };
      if (!response.ok || !result.payoutId) throw new Error(result.error || "Payout could not be reconciled.");
      setStatus(`Confirmed payout ${result.payoutId} recorded from transaction ${payoutSignature}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Payout reconciliation failed."); }
    finally { setBusy(false); }
  }

  return <div className="section-shell solana-page"><span className="eyebrow">{solanaCluster} · administrator only</span>
    <h1>Collect SPLIT platform fees</h1><p>Only the configured SPLIT fee wallet can sign Raydium&apos;s per-pool claim. Claimed WSOL remains under SPLIT control until separately signed payouts are confirmed.</p>
    <p>Connected wallet: <code>{account.address}</code></p>
    <label>Token mint<input value={mint} onChange={(event) => { setMint(event.target.value.trim()); setPrepared(null); }} placeholder="Solana token mint" /></label>
    <button type="button" className="button button-outline" disabled={busy || !isSolanaAddress(mint)} onClick={() => void prepare()}>Prepare claim</button>
    {prepared ? <section className="glass-panel solana-form-card"><h2>Review transaction</h2>
      <p>Cluster: {solanaCluster}<br />Raydium pool: <code>{prepared.pool}</code><br />Signer and fee payer: <code>{prepared.wallet}</code><br />Recipient WSOL account: <code>{prepared.recipientTokenAccount}</code><br />Pool fee counter: {prepared.expectedAvailableWsolRaw} raw WSOL units</p>
      <p>The wallet will sign a Raydium claim and may create its WSOL token account. No project recipient is paid by this transaction.</p>
      <button type="button" className="button button-primary" disabled={busy} onClick={() => void submit()}>Sign and submit claim</button>
    </section> : null}
    <section className="glass-panel solana-form-card"><h2>Record a separately signed payout</h2>
      <p>This only verifies and records an already finalized WSOL transfer. It does not prepare, sign, or send a payout.</p>
      <label>Receipt ID<input value={receiptId} onChange={(event) => setReceiptId(event.target.value.trim())} /></label>
      <label>Destination<select value={destination} onChange={(event) => setDestination(event.target.value)}>
        <option value="protocol">Protocol</option><option value="creator">Creator</option>
        <option value="project_treasury">Project treasury</option><option value="community">Community</option>
      </select></label>
      <label>Finalized payout signature<input value={payoutSignature} onChange={(event) => setPayoutSignature(event.target.value.trim())} /></label>
      <label>Instruction index<input type="number" min={0} step={1} value={instructionIndex}
        onChange={(event) => setInstructionIndex(Number(event.target.value))} /></label>
      <button type="button" className="button button-outline" disabled={busy || !receiptId || !payoutSignature || !isSolanaAddress(mint)}
        onClick={() => void reconcilePayout()}>Verify and record payout</button>
    </section>
    {status ? <p aria-live="polite">{status}</p> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}
  </div>;
}
