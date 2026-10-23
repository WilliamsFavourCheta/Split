"use client";

import { useSignAndSendTransaction, useSignMessage } from "@solana/react";
import { useConnectedWallet } from "@solana/kit-plugin-wallet/react";
import { Keypair } from "@solana/web3.js";
import { useState } from "react";
import { executeSolanaLaunch } from "../../lib/solana/launch-transaction";
import { publishSolanaTokenMetadata } from "../../lib/solana/publish-metadata";
import { solanaCluster } from "../../lib/solana/client";
import type { SolanaLaunchDraft } from "../../lib/solana/launch-config";
import { routerBackedSolanaMode } from "../../lib/solana/raydium-accounts";

type WalletAccount = NonNullable<ReturnType<typeof useConnectedWallet>>["account"];

export function SolanaLaunchAction({ account, draft, logo, valid }: {
  account: WalletAccount; draft: SolanaLaunchDraft; logo: File | null; valid: boolean;
}) {
  const signMessage = useSignMessage(account);
  const signAndSend = useSignAndSendTransaction(account, solanaCluster === "mainnet-beta" ? "solana:mainnet" : "solana:devnet");
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const [mint, setMint] = useState("");
  const [signature, setSignature] = useState("");
  const [launchSignatures, setLaunchSignatures] = useState<string[]>([]);

  async function confirmLaunch(mintAddress: string, signatures: string[]) {
    setStep("Verifying finalized accounts and automatically saving your project");
    const response = await fetch("/api/solana/launches/confirm", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mint: mintAddress, launchSignatures: signatures }) });
    const result = await response.json() as { saved?: boolean; tokenPath?: string; error?: string };
    if (!response.ok || !result.saved || !result.tokenPath) {
      throw new Error(`Launch is finalized, but automatic saving is pending: ${result.error || "indexer unavailable"}`);
    }
    window.location.assign(result.tokenPath);
  }

  async function start() {
    setBusy(true);
    setError("");
    try {
      setStep("Checking finalized deployment configuration");
      const response = await fetch("/api/solana/readiness", { cache: "no-store" });
      const readiness = await response.json() as { ready?: boolean; reasons?: string[] };
      if (!response.ok || !readiness.ready) throw new Error(readiness.reasons?.join(" ") || "Solana launch configuration is unavailable.");
      if (!routerBackedSolanaMode) {
        const quoteResponse = await fetch("/api/solana/cost", { cache: "no-store" });
        const quote = await quoteResponse.json() as { withinBudget?: boolean; error?: string };
        if (!quoteResponse.ok || !quote.withinBudget) throw new Error(quote.error || "The current mainnet cost quote exceeds the $20 launch budget.");
      }
      const pair = Keypair.generate();
      setMint(pair.publicKey.toBase58());
      setStep("Sign token metadata in your wallet");
      const uri = await publishSolanaTokenMetadata({
        mint: pair.publicKey.toBase58(), creator: account.address,
        draft: { name: draft.name, symbol: draft.symbol, description: draft.description,
          website: draft.website, x: draft.twitter, projectTreasuryAddress: draft.projectTreasuryAddress,
          communityAddress: draft.communityAddress, split: draft.split }, logo, signMessage,
      });
      const launched = await executeSolanaLaunch({ mint: pair, creatorAddress: account.address,
        draft, metadataUri: uri, signAndSend, progress: setStep });
      setSignature(launched.launchSignatures.at(-1) ?? "");
      setLaunchSignatures(launched.launchSignatures);
      await confirmLaunch(launched.mint, launched.launchSignatures);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The Solana launch could not be completed.");
      setStep("");
    } finally {
      setBusy(false);
    }
  }

  return <div className="solana-launch-action">
    {!reviewing ? <button type="button" className="button button-primary" disabled={!valid}
      onClick={() => setReviewing(true)}>Review Solana launch</button> : <div className="glass-panel solana-form-card">
      <h3>Review wallet transactions</h3>
      <p>{draft.name.trim()} ({draft.symbol.trim().toUpperCase()}) on {solanaCluster}. Your wallet pays Solana rent and transaction fees. The graduation target is {draft.graduationTargetSol} SOL raised by buyers. Raydium collects SPLIT&apos;s 1% platform fee during curve trading.</p>
      <p>SPLIT controls claimed fees. The displayed allocations are an operator-managed policy, not enforced by an onchain SPLIT router. They require pool-specific receipts and confirmed payout transactions.</p>
      <p>Project treasury: {draft.projectTreasuryAddress}<br />Community: {draft.communityAddress}</p>
      <p>Wallet signatures bind your metadata and policy, then create the Raydium curve. The launch transaction is simulated before signing.</p>
      <button type="button" className="button button-primary" disabled={busy || !valid || Boolean(signature)}
        onClick={() => void start()}>{busy ? "Working..." : "Approve launch transactions"}</button>
      {!busy && !signature ? <button type="button" className="button button-outline" onClick={() => setReviewing(false)}>Back</button> : null}
    </div>}
    {step ? <p aria-live="polite">{step}</p> : null}
    {mint ? <p>Mint: <code>{mint}</code></p> : null}
    {signature ? <p>Finalized launch: <code>{signature}</code></p> : null}
    {signature && launchSignatures.length ? <button type="button" className="button button-outline"
      disabled={busy} onClick={() => void confirmLaunch(mint, launchSignatures).catch((cause) => setError(cause instanceof Error ? cause.message : "Indexing failed."))}>Retry automatic saving</button> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
  </div>;
}
