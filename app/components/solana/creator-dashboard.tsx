"use client";

import Link from "next/link";
import { useClient } from "@solana/react";
import { useConnectedWallet } from "@solana/kit-plugin-wallet/react";
import { useEffect, useState } from "react";
import type { SplitSolanaClient } from "../../lib/solana/client";

type Project = { mint_address: string; name: string; symbol: string; status: string; launched_at: string | null };

export function SolanaCreatorDashboard() {
  const client = useClient<SplitSolanaClient>();
  const wallet = useConnectedWallet(client);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!wallet) return;
    const controller = new AbortController();
    fetch(`/api/solana/projects?creator=${encodeURIComponent(wallet.account.address)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error(); return response.json(); })
      .then((result: { projects?: Project[] }) => setProjects(result.projects ?? []))
      .catch(() => { if (!controller.signal.aborted) setError("Creator projects are unavailable."); });
    return () => controller.abort();
  }, [wallet]);
  return <div className="section-shell solana-page"><span className="eyebrow">Solana creator dashboard</span><h1>Your launches</h1>
    {!wallet ? <p>Connect your Solana wallet to see verified launches associated with it.</p> : <>
      <p>Creator wallet: <code>{wallet.account.address}</code></p>
      {error ? <p>{error}</p> : projects.length ? <div className="solana-project-list">{projects.map((project) =>
        <Link className="glass-panel solana-project-row" href={`/solana/token/${project.mint_address}`} key={project.mint_address}>
          <span><strong>{project.name}</strong><small>{project.symbol} · {project.status}</small></span>
          <span className="solana-project-mint">{project.mint_address.slice(0, 6)}…{project.mint_address.slice(-6)}</span>
        </Link>)}</div> : <p>No finalized SPLIT Solana launch has been indexed for this wallet.</p>}
    </>}
  </div>;
}
