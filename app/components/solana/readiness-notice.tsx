"use client";

import { useEffect, useState } from "react";
import type { SolanaLaunchReadiness } from "../../lib/solana/readiness";

export function SolanaReadinessNotice() {
  const [state, setState] = useState<SolanaLaunchReadiness | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/solana/readiness", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unavailable");
        return response.json() as Promise<SolanaLaunchReadiness>;
      })
      .then((result) => setState(result))
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, []);

  return <section className="glass-panel solana-form-card" aria-live="polite">
    <h2>Deployment status</h2>
    {error ? <p>Could not verify Solana deployment status from the current RPC.</p>
      : !state ? <p>Checking finalized Solana configuration...</p>
        : state.ready ? <p>On-chain configuration verified at finalized slot {state.observedFinalizedSlot}.</p>
          : <ul className="solana-form-errors">{state.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
    {state?.configId ? <small>Raydium config: {state.configId}</small> : null}
  </section>;
}
