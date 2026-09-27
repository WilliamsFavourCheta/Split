"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { formatEther, isAddress, parseEther } from "viem";
import { DEFAULT_SPLIT } from "../data/mock";
import { Icon } from "./icons";
import { useLaunchDraft, useWallet } from "./providers";
import { AppShell } from "./shell";
import { RouteCore, SplitStrip } from "./visuals";
import { OnchainLaunchReview } from "./onchain-launch-flow";

export type LaunchStep = "details" | "market" | "split" | "review";

function formatTokenSupply(value: string) {
  const [integer = "0", fraction] = value.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

const steps: { key: LaunchStep; number: number; label: string; href: string }[] = [
  { key: "details", number: 1, label: "Token", href: "/launch/details" },
  { key: "market", number: 2, label: "Market", href: "/launch/market" },
  { key: "split", number: 3, label: "Split", href: "/launch/split" },
  { key: "review", number: 4, label: "Review", href: "/launch/review" },
];

export function LaunchWizard({ step }: { step: LaunchStep }) {
  const index = steps.findIndex((item) => item.key === step);
  return <AppShell footer={false}><div className="section-shell page-body launch-page"><div className="launch-kicker"><div><span className="eyebrow">Launch protocol / New token</span><h1>Configure your launch</h1></div><span className="saved-state"><Icon name="lock" />Saved locally</span></div><nav className="launch-stepper" aria-label="Launch steps">{steps.map((item, itemIndex) => <Link href={item.href} className={`${itemIndex === index ? "active" : ""} ${itemIndex < index ? "complete" : ""}`} key={item.key}><span>{itemIndex < index ? <Icon name="check" /> : item.number}</span><strong>0{item.number} {item.label}</strong></Link>)}</nav>{step === "details" ? <DetailsStep /> : step === "market" ? <MarketStep /> : step === "split" ? <SplitStep /> : <OnchainLaunchReview />}</div></AppShell>;
}

function DetailsStep() {
  const { draft, updateDraft } = useLaunchDraft();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [touched, setTouched] = useState(false);
  const valid = draft.name.trim().length >= 2 && /^[A-Za-z0-9]{2,8}$/.test(draft.symbol.trim());
  const continueFlow = () => { setTouched(true); if (valid) router.push("/launch/market"); };
  return <div className="launch-content-grid"><section className="launch-form-card glass-panel"><span className="eyebrow">Step 01 / Token</span><h2>Create your<br /><span>token.</span></h2><p>Give your protocol a name, a voice, and a destination.</p><div className="form-grid"><label>Token name*<input value={draft.name} onChange={(e) => updateDraft({ name: e.target.value })} placeholder="e.g. Orbit" aria-invalid={touched && draft.name.trim().length < 2} /></label><label>Token symbol*<input value={draft.symbol} onChange={(e) => updateDraft({ symbol: e.target.value.toUpperCase().slice(0, 8) })} placeholder="ORB" aria-invalid={touched && !/^[A-Za-z0-9]{2,8}$/.test(draft.symbol)} /></label><label className="field-full">Description<textarea value={draft.description} onChange={(e) => updateDraft({ description: e.target.value })} placeholder="What is this token about?" maxLength={360} /></label><label className="field-full">Token logo upload<input ref={fileRef} className="sr-only" type="file" accept="image/png,image/jpeg,image/svg+xml" onChange={(e) => updateDraft({ logoName: e.target.files?.[0]?.name ?? "" })} /><button type="button" className="upload-dropzone" onClick={() => fileRef.current?.click()}><Icon name="upload" /><span>{draft.logoName || <>Drop an image here or <b>browse</b></>}</span><small>PNG, JPG or SVG Â· 2MB max</small></button></label></div><div className="form-divider" /><div className="form-section-head"><span className="eyebrow">Socials</span><small>All optional</small></div><div className="form-grid"><label>Website<input value={draft.website} onChange={(e) => updateDraft({ website: e.target.value })} placeholder="https://" /></label><label>X / Twitter<input value={draft.twitter} onChange={(e) => updateDraft({ twitter: e.target.value })} placeholder="https://x.com/" /></label><label>Telegram<input value={draft.telegram} onChange={(e) => updateDraft({ telegram: e.target.value })} placeholder="https://t.me/" /></label><label>Discord<input value={draft.discord} onChange={(e) => updateDraft({ discord: e.target.value })} placeholder="https://discord.gg/" /></label></div>{touched && !valid ? <p className="form-error">Enter a token name and a 2â€“8 character symbol.</p> : null}<button className="button button-primary form-continue" onClick={continueFlow}>Continue <Icon name="arrow" /></button></section><TokenPreview /></div>;
}

function MarketStep() {
  const { draft, updateDraft } = useLaunchDraft();
  const router = useRouter();
  const [touched, setTouched] = useState(false);
  const valid = /^(?=.*[1-9])\d+(?:\.\d{1,18})?$/.test(draft.initialLiquidity)
    && /^(?=.*[1-9])\d+(?:\.\d{1,18})?$/.test(draft.tokenSeedAmount);
  const continueFlow = () => { setTouched(true); if (valid) router.push("/launch/split"); };
  let totalEth = "0.000500";
  try { totalEth = formatEther(parseEther(draft.initialLiquidity || "0") + parseEther("0.0005")); } catch { /* Invalid drafts are explained below. */ }
  return <div className="launch-content-grid"><section className="launch-form-card glass-panel"><span className="eyebrow">Step 02 / Market</span><h2>Shape the<br /><span>market.</span></h2><p>Set token supply and initial pool liquidity. The protocol launch fee is separate from your seed.</p><div className="form-grid market-form"><label>Fixed token supply<input value="1,000,000,000" readOnly aria-readonly="true" /></label><label>Quote asset<select value={draft.quoteAsset} onChange={(e) => updateDraft({ quoteAsset: e.target.value })}><option>ETH</option><option disabled>USDC â€” unavailable</option></select></label><label>Initial ETH liquidity*<input type="number" min="0.000000000000000001" step="any" value={draft.initialLiquidity} onChange={(e) => updateDraft({ initialLiquidity: e.target.value })} /></label><label>Token amount for liquidity*<input type="number" min="0.000000000000000001" step="any" value={draft.tokenSeedAmount} onChange={(e) => updateDraft({ tokenSeedAmount: e.target.value })} /></label></div><div className="launch-cost-summary"><div><span>Launch fee</span><strong>0.0005 ETH</strong><small>Paid to SPLIT Protocol Treasury</small></div><div><span>Initial liquidity</span><strong>{draft.initialLiquidity || "0"} ETH + {draft.tokenSeedAmount || "0"} tokens</strong><small>Seeded separately through the Liquidity Vault</small></div></div><div className="info-callout"><Icon name="lock" /><div><strong>1% on official registered-pool swaps</strong><p>Other pools and venues are outside SPLIT fee accounting. Of each fee collected by the official SPLIT pool hook, 10% is Protocol Revenue and the remaining 90% follows your configurable 100% project split. The pool also charges its separate 0.30% LP fee.</p></div></div><div className="launch-cost-summary"><div><span>Total ETH required</span><strong>{totalEth} ETH</strong><small>Launch fee + ETH liquidity; excludes gas</small></div></div>{touched && !valid ? <p className="form-error">Enter positive ETH and token seed amounts with no more than 18 decimal places.</p> : null}<div className="wizard-actions"><Link className="button button-outline" href="/launch/details"><Icon name="back" />Back</Link><button className="button button-primary" onClick={continueFlow}>Continue <Icon name="arrow" /></button></div></section><MarketPreview /></div>;
}

function SplitStep() {
  const { draft, updateAllocation, updateDraft } = useLaunchDraft();
  const router = useRouter();
  const allocations = useMemo(() => DEFAULT_SPLIT.map((item) => ({ ...item, value: draft.allocations[item.key] })), [draft.allocations]);
  const total = Object.values(draft.allocations).reduce((sum, value) => sum + value, 0);
  const communityValid = isAddress(draft.communityAddress);
  const projectTreasuryValid = draft.allocations.projectTreasury === 0 || isAddress(draft.projectTreasuryAddress);
  return <div className="split-builder-layout"><section className="launch-form-card glass-panel split-controls"><span className="eyebrow">Step 03 / Split</span><h2>Route every<br /><span>fee.</span></h2><p>Configure how the remaining 90% of SPLITâ€™s collected swap fee is allocated. These project shares must total 100%; Protocol Revenue is separate and fixed at 10%.</p>{allocations.map((item) => <div className="allocation-control" key={item.key}><div><span><i style={{ background: item.color }} />{item.label}</span><label><input type="number" min="0" max="100" value={item.value} onChange={(e) => updateAllocation(item.key, Number(e.target.value))} aria-label={`${item.label} percentage`} />%</label></div><input type="range" min="0" max="100" value={item.value} onChange={(e) => updateAllocation(item.key, Number(e.target.value))} style={{ "--range-progress": `${item.value}%`, "--range-color": item.color } as React.CSSProperties} /></div>)}<label className="field-full">Project Treasury destination{draft.allocations.projectTreasury > 0 ? "*" : " (optional at 0%)"}<input value={draft.projectTreasuryAddress} onChange={(e) => updateDraft({ projectTreasuryAddress: e.target.value.trim() })} placeholder="0xâ€¦" aria-invalid={draft.projectTreasuryAddress.length > 0 && !projectTreasuryValid} /></label><label className="field-full">Community destination*<input value={draft.communityAddress} onChange={(e) => updateDraft({ communityAddress: e.target.value.trim() })} placeholder="0xâ€¦" aria-invalid={draft.communityAddress.length > 0 && !communityValid} /></label><small>The creator is your connected wallet. Project Treasury is configurable and independent of the global SPLIT Protocol Treasury. Liquidity is permanently reserved in the SPLIT vault.</small><div className={`allocation-total ${total === 100 ? "valid" : "invalid"}`}><span>Project allocation total</span><strong>{total}%</strong><small>{total === 100 ? "Ready to continue" : total < 100 ? `${100 - total}% remains unallocated` : `${total - 100}% over allocation`}</small></div><div className="wizard-actions"><Link className="button button-outline" href="/launch/market"><Icon name="back" />Back</Link><button className="button button-primary" disabled={total !== 100 || !communityValid || !projectTreasuryValid} onClick={() => router.push("/launch/review")}>Continue <Icon name="arrow" /></button></div></section><section className="split-visual glass-panel"><span className="eyebrow">Live routing model</span><RouteCore allocations={allocations} /><SplitStrip allocations={allocations} /><p>Of each 1% SPLIT swap fee, 10% is protocol revenue. The remaining 90% follows this project split. Project allocation must equal exactly 100%.</p></section></div>;
}

export function LegacyReviewStep() {
  const { draft } = useLaunchDraft();
  const wallet = useWallet();
  const allocations = DEFAULT_SPLIT.map((item) => ({ ...item, value: draft.allocations[item.key] }));
  let totalEthRequired = "Unavailable";
  try { totalEthRequired = formatEther(parseEther(draft.initialLiquidity) + parseEther("0.0005")); } catch { /* incomplete draft */ }
  const action = () => {
    if (wallet.status === "wrong-network") void wallet.switchNetwork();
    else if (wallet.status !== "connected") void wallet.openWallet();
  };
  const busy = wallet.status === "connecting" || wallet.status === "restoring" || wallet.status === "switching" || wallet.status === "disconnecting";
  const actionLabel = wallet.status === "wrong-network"
    ? "Switch Network"
    : wallet.status === "connecting"
      ? "Connecting Wallet"
      : wallet.status === "restoring"
        ? "Restoring Wallet"
        : wallet.status === "switching"
          ? "Switching Network"
          : wallet.status === "connected"
            ? "Factory Not Deployed"
            : wallet.status === "unavailable"
              ? "No Wallet Found"
              : "Connect Wallet";
  return <div className="review-layout"><section><span className="eyebrow">Step 04 / Review</span><h2 className="review-title">Review your<br /><span>launch.</span></h2><p className="review-lede">Confirm these launch settings. Deployment will be enabled once the verified SPLIT factory is deployed and configured.</p><ReviewSection title="Token" editHref="/launch/details"><dl><div><dt>Name</dt><dd>{draft.name || "Not provided"}</dd></div><div><dt>Symbol</dt><dd>${draft.symbol || "â€”"}</dd></div><div><dt>Description</dt><dd>{draft.description || "No description"}</dd></div></dl></ReviewSection><ReviewSection title="Market" editHref="/launch/market"><dl><div><dt>Total supply</dt><dd>{formatTokenSupply(draft.supply || "0")}</dd></div><div><dt>Launch fee</dt><dd>0.0005 ETH (global Protocol Treasury)</dd></div><div><dt>Initial liquidity</dt><dd>{draft.initialLiquidity} ETH (project seed)</dd></div><div><dt>Total ETH required</dt><dd>{totalEthRequired} ETH + gas</dd></div><div><dt>SPLIT trading fee</dt><dd>1% on official registered-pool swaps · 10% Protocol Treasury · 90% programmable</dd></div></dl></ReviewSection><ReviewSection title="Project split (100% of programmable 90%)" editHref="/launch/split"><SplitStrip allocations={allocations} /><div className="review-split">{allocations.map((item) => <span key={item.key}><i style={{ background: item.color }} />{item.label}<strong>{item.value}%</strong></span>)}</div><p>Protocol Treasury is global, fixed, and independent of the per-project split.</p><p>Creator recipient: <code>{wallet.address || "Connect wallet"}</code></p><p>Liquidity allocation: <strong>{draft.allocations.liquidity}%</strong> to the vault. Seeded liquidity is permanently committed; later Liquidity allocations remain pending and are not automatically reinvested.</p><p>Project Treasury recipient: <code>{draft.allocations.projectTreasury === 0 ? "Not allocated (0%)" : draft.projectTreasuryAddress || "Not set"}</code></p><p>Community recipient: <code>{draft.communityAddress || "Not set"}</code></p></ReviewSection></section><aside className="deploy-card glass-panel"><span className="eyebrow">Deployment</span><h3>{wallet.status === "connected" ? "Awaiting contract deployment" : "Wallet ready"}</h3><p>SPLITâ€™s factory address and ABI have not been deployed/configured yet, so no transaction can be sent from this screen.</p><div className="deploy-cost"><span>Target network</span><strong>{wallet.targetChainName}</strong><span>Contract status</span><strong>Not configured</strong></div><button className="button button-primary deploy-button" disabled={busy || wallet.status === "connected"} onClick={action}>{busy ? <><span className="spinner" />{actionLabel}</> : wallet.status === "connected" ? actionLabel : <>{actionLabel} <Icon name={wallet.status === "wrong-network" ? "globe" : "wallet"} /></>}</button><small className="deploy-disclaimer"><Icon name="lock" />No mock transaction is sent. Contract writes stay blocked until the verified factory is configured.</small></aside></div>;
}

function ReviewSection({ title, editHref, children }: { title: string; editHref: string; children: React.ReactNode }) {
  return <section className="review-section glass-panel"><div><h3>{title}</h3><Link href={editHref}>Edit {title} <Icon name="arrow" size={13} /></Link></div>{children}</section>;
}

function TokenPreview() {
  const { draft } = useLaunchDraft();
  return <aside className="launch-preview glass-panel"><div className="form-section-head"><span className="eyebrow">Live token preview</span><span className="draft-badge"><span className="status-dot" />Draft</span></div><div className="preview-card"><div className="preview-token-head"><span className="preview-token-glyph">{draft.symbol[0] || "T"}</span><div><strong>{draft.name || "Your Token"}</strong><span>${draft.symbol || "TKN"}</span></div><span className="status-badge status-upcoming">Upcoming</span></div><dl><div><dt>Mcap</dt><dd>â€”</dd></div><div><dt>Vol (24h)</dt><dd>â€”</dd></div><div><dt>Liq</dt><dd>â€”</dd></div></dl><span className="eyebrow">SPLIT swap fee <b>1% / 10% protocol share</b></span><small>Launch fee: 0.0005 ETH, separate from initial liquidity.</small><SplitStrip allocations={DEFAULT_SPLIT} /><div className="preview-actions"><Link href="/explore">View detail <Icon name="external" size={13} /></Link><button type="button" className="preview-trade" disabled title="Trading becomes available after deployment">Trade</button></div></div><p>This is how your token will appear across the launchpad.</p></aside>;
}

function MarketPreview() {
  const { draft } = useLaunchDraft();
  return <aside className="launch-preview glass-panel"><span className="eyebrow">Market summary</span><h3>{draft.name || "Your token"} / {draft.quoteAsset}</h3><dl className="market-preview-list"><div><dt>Supply</dt><dd>{formatTokenSupply(draft.supply || "0")}</dd></div><div><dt>Initial liquidity</dt><dd>{draft.initialLiquidity || "0"} ETH</dd></div><div><dt>Fee source</dt><dd>{draft.feeRate || "0"}% on official registered SPLIT-pool swaps</dd></div><div><dt>Price discovery</dt><dd>At launch</dd></div></dl><div className="market-orbit"><span /><i /></div><p>Final values remain subject to contract-side validation.</p></aside>;
}

