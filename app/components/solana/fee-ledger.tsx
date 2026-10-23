"use client";

import { useEffect, useState } from "react";

type Allocation = { destination: string; recipient: string | null; dueWsolRaw: string;
  confirmedPaidWsolRaw: string; outstandingWsolRaw: string; status: string;
  payouts: Array<{ signature: string; amount_wsol_raw: string }> };
type Receipt = { id: string; signature: string; amount_wsol_raw: string; slot: number;
  allocations: Allocation[]; reconciliation: string };

const sol = (raw: string) => {
  const units = BigInt(raw);
  const whole = units / BigInt(1_000_000_000);
  const fraction = (units % BigInt(1_000_000_000)).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
};

export function SolanaFeeLedger({ mint }: { mint: string }) {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/solana/ledger?mint=${encodeURIComponent(mint)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error("Fee ledger unavailable."); return response.json(); })
      .then((result: { receipts?: Receipt[] }) => setReceipts(result.receipts ?? []))
      .catch(() => { if (!controller.signal.aborted) setError("Verified fee ledger unavailable."); });
    return () => controller.abort();
  }, [mint]);
  return <section className="glass-panel solana-market-panel">
    <h2>Verified fee ledger</h2>
    <p>SPLIT holds claimed platform fees before any operator-managed payout. The amounts below are policy calculations, not onchain SPLIT claims.</p>
    {error ? <p>{error}</p> : receipts.length ? receipts.map((receipt) => <div key={receipt.id}>
      <p>Pool receipt: {sol(receipt.amount_wsol_raw)} WSOL · finalized slot {receipt.slot} · <code>{receipt.signature}</code></p>
      {receipt.allocations.map((allocation) => <p key={allocation.destination}>
        {allocation.destination.replaceAll("_", " ")}: {sol(allocation.dueWsolRaw)} due; {sol(allocation.confirmedPaidWsolRaw)} confirmed paid; {sol(allocation.outstandingWsolRaw)} outstanding ({allocation.status}).
        {allocation.payouts.map((payout) => <span key={payout.signature}> Payment <code>{payout.signature}</code>.</span>)}
      </p>)}
    </div>) : <p>No verified pool-specific SPLIT fee receipt has been recorded.</p>}
  </section>;
}
