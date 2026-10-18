"use client";

import { useConnectedWallet } from "@solana/kit-plugin-wallet/react";
import { useClient } from "@solana/react";
import { useMemo, useState } from "react";
import { DEFAULT_SOLANA_LAUNCH_DRAFT, projectShareOfGrossFee, validateSolanaLaunch, type SolanaLaunchDraft, type SolanaSplit } from "../../lib/solana/launch-config";
import { solanaCluster, type SplitSolanaClient } from "../../lib/solana/client";

const destinations: Array<{ key: keyof SolanaSplit; label: string }> = [
  { key: "creator", label: "Creator" }, { key: "liquidity", label: "Liquidity" },
  { key: "projectTreasury", label: "Project treasury" }, { key: "community", label: "Community" },
];

export function SolanaLaunchForm() {
  const client = useClient<SplitSolanaClient>();
  const wallet = useConnectedWallet(client);
  const [draft, setDraft] = useState<SolanaLaunchDraft>(DEFAULT_SOLANA_LAUNCH_DRAFT);
  const errors = useMemo(() => validateSolanaLaunch(draft), [draft]);
  const set = <K extends keyof SolanaLaunchDraft>(key: K, value: SolanaLaunchDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  return <div className="section-shell solana-page solana-launch-page"><span className="eyebrow">Create on Solana · {solanaCluster}</span><h1>Shape the launch.</h1><p>The four destinations are fixed before the first trade. The creator wallet is the connected Solana wallet.</p><div className="solana-launch-grid"><section className="glass-panel solana-form-card"><h2>Token</h2><div className="form-grid"><label>Name<input value={draft.name} onChange={(event) => set("name", event.target.value)} maxLength={32} placeholder="Your token" /></label><label>Symbol<input value={draft.symbol} onChange={(event) => set("symbol", event.target.value.toUpperCase())} maxLength={10} placeholder="SPLIT" /></label><label className="field-full">Description<textarea value={draft.description} onChange={(event) => set("description", event.target.value)} maxLength={360} /></label><label>Website<input type="url" value={draft.website} onChange={(event) => set("website", event.target.value)} placeholder="https://" /></label><label>X<input type="url" value={draft.twitter} onChange={(event) => set("twitter", event.target.value)} placeholder="https://x.com/" /></label></div><h2>Curve</h2><label>Graduation target · SOL<input type="number" min={24} step="1" value={draft.graduationTargetSol} onChange={(event) => set("graduationTargetSol", event.target.value)} /></label><small>Preview target. The supported range must be verified against Raydium configuration before launch transactions are enabled.</small></section><section className="glass-panel solana-form-card"><h2>Immutable fee split</h2><p>10% of SPLIT&apos;s platform fee goes to the protocol. These shares divide the remaining 90%.</p>{destinations.map(({ key, label }) => <label className="solana-split-row" key={key}><span>{label}</span><input type="number" min={0} max={100} step={1} value={draft.split[key]} onChange={(event) => set("split", { ...draft.split, [key]: Number(event.target.value) })} /><strong>%</strong><small>{projectShareOfGrossFee(draft.split[key]) / 100}% of collected SPLIT fees</small></label>)}<label>Project treasury Solana address<input value={draft.projectTreasuryAddress} onChange={(event) => set("projectTreasuryAddress", event.target.value.trim())} placeholder="Base58 wallet address" /></label><label>Community Solana address<input value={draft.communityAddress} onChange={(event) => set("communityAddress", event.target.value.trim())} placeholder="Base58 wallet address" /></label><div className="solana-form-review"><strong>Creator: {wallet?.account.address ?? "Connect a Solana wallet"}</strong><small>Planned supply: 1,000,000,000 tokens</small><small>Cluster: {solanaCluster}</small></div>{errors.length ? <ul className="solana-form-errors">{errors.map((error) => <li key={error}>{error}</li>)}</ul> : null}<button type="button" className="button button-primary" disabled title="Launch transactions will be enabled after the SPLIT Solana fee program and Raydium platform configuration are deployed and verified.">Launch configuration pending</button><small>No wallet transaction can be sent until the Solana fee program and platform configuration are verified.</small></section></div></div>;
}
