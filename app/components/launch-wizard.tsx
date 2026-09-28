"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatEther, isAddress, parseEther } from "viem";
import { DEFAULT_SPLIT } from "../data/mock";
import { Icon } from "./icons";
import { useLaunchDraft } from "./providers";
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

async function prepareLogo(file: File) {
  const allowedTypes = ["image/png", "image/jpeg", "image/webp"];
  if (!allowedTypes.includes(file.type)) throw new Error("Choose a PNG, JPG, or WebP image.");
  if (file.size > 5 * 1024 * 1024) throw new Error("The image must be 5 MB or smaller.");
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not prepare the image.");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  let blob: Blob | null = null;
  for (const quality of [0.84, 0.72, 0.6]) {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
    if (blob && blob.size <= 512 * 1024) break;
  }
  if (!blob || blob.size > 512 * 1024) throw new Error("This image could not be compressed small enough. Try a simpler or smaller image.");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The image could not be read."));
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("The image could not be read."));
    reader.readAsDataURL(blob);
  });
  return dataUrl;
}

export function LaunchWizard({ step }: { step: LaunchStep }) {
  const index = steps.findIndex((item) => item.key === step);
  const router = useRouter();
  const { draft, draftHydrated } = useLaunchDraft();
  const detailsValid = draft.name.trim().length >= 2 && new TextEncoder().encode(draft.name.trim()).length <= 64
    && /^[A-Za-z0-9]{2,8}$/.test(draft.symbol.trim());
  const marketValid = /^(?=.*[1-9])\d+(?:\.\d{1,18})?$/.test(draft.initialLiquidity)
    && /^(?=.*[1-9])\d+(?:\.\d{1,18})?$/.test(draft.tokenSeedAmount)
    && (() => { try { return parseEther(draft.tokenSeedAmount) <= parseEther("1000000000"); } catch { return false; } })()
    && draft.quoteAsset === "ETH";
  const splitValid = Object.values(draft.allocations).every((value) => Number.isInteger(value) && value >= 0 && value <= 100)
    && Object.values(draft.allocations).reduce((sum, value) => sum + value, 0) === 100
    && isAddress(draft.communityAddress)
    && (draft.allocations.projectTreasury === 0 || isAddress(draft.projectTreasuryAddress));
  const firstIncomplete = !detailsValid ? "details" : !marketValid ? "market" : !splitValid ? "split" : null;
  const redirectRequired = Boolean(firstIncomplete && index > steps.findIndex((item) => item.key === firstIncomplete));
  useEffect(() => {
    if (!draftHydrated) return;
    if (redirectRequired && firstIncomplete) {
      router.replace(steps.find((item) => item.key === firstIncomplete)!.href);
    }
  }, [draftHydrated, firstIncomplete, redirectRequired, router]);
  if (!draftHydrated || redirectRequired) return <AppShell footer={false}><div className="section-shell page-body" role="status">Restoring launch draft...</div></AppShell>;
  return <AppShell footer={false}><div className="section-shell page-body launch-page"><div className="launch-kicker"><div><span className="eyebrow">Launch protocol / New token</span><h1>Configure your launch</h1></div><span className="saved-state"><Icon name="lock" />Saved locally</span></div><nav className="launch-stepper" aria-label="Launch steps">{steps.map((item, itemIndex) => <Link href={item.href} className={`${itemIndex === index ? "active" : ""} ${itemIndex < index ? "complete" : ""}`} key={item.key}><span>{itemIndex < index ? <Icon name="check" /> : item.number}</span><strong>0{item.number} {item.label}</strong></Link>)}</nav>{step === "details" ? <DetailsStep /> : step === "market" ? <MarketStep /> : step === "split" ? <SplitStep /> : <OnchainLaunchReview />}</div></AppShell>;
}

function DetailsStep() {
  const { draft, updateDraft } = useLaunchDraft();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [touched, setTouched] = useState(false);
  const [logoError, setLogoError] = useState("");
  const [dragging, setDragging] = useState(false);
  const valid = draft.name.trim().length >= 2 && new TextEncoder().encode(draft.name.trim()).length <= 64 && /^[A-Za-z0-9]{2,8}$/.test(draft.symbol.trim());
  const continueFlow = () => { setTouched(true); if (valid) router.push("/launch/market"); };
  const handleLogo = async (file?: File) => {
    if (!file) return;
    setLogoError("");
    try {
      const logoDataUrl = await prepareLogo(file);
      updateDraft({ logoName: file.name, logoDataUrl });
    } catch (error) {
      setLogoError(error instanceof Error ? error.message : "The image could not be prepared.");
    }
  };
  return (
    <div className="launch-content-grid">
      <section className="launch-form-card glass-panel">
        <span className="eyebrow">Step 01 / Token</span>
        <h2>Create your<br /><span>token.</span></h2>
        <p>Give your protocol a name, a voice, and a destination.</p>
        <div className="form-grid">
          <label>Token name*<input value={draft.name} onChange={(e) => updateDraft({ name: e.target.value })} placeholder="e.g. Orbit" aria-invalid={touched && draft.name.trim().length < 2} /></label>
          <label>Token symbol*<input value={draft.symbol} onChange={(e) => updateDraft({ symbol: e.target.value.toUpperCase().slice(0, 8) })} placeholder="ORB" aria-invalid={touched && !/^[A-Za-z0-9]{2,8}$/.test(draft.symbol)} /></label>
          <label className="field-full">Description<textarea value={draft.description} onChange={(e) => updateDraft({ description: e.target.value })} placeholder="What is this token about?" maxLength={360} /></label>
          <label className="field-full">Token logo upload
            <input ref={fileRef} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => { void handleLogo(e.target.files?.[0]); e.currentTarget.value = ""; }} />
            <button type="button" className={`upload-dropzone ${dragging ? "is-dragging" : ""}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(e) => { e.preventDefault(); setDragging(false); void handleLogo(e.dataTransfer.files[0]); }}>
              <Icon name="upload" />
              {draft.logoDataUrl ? <Image src={draft.logoDataUrl} width={68} height={68} unoptimized alt="Token logo preview" /> : null}
              <span>{draft.logoName || <>Drop an image here or <b>browse</b></>}</span>
              <small>PNG, JPG or WebP - up to 5 MB. Saved as a compact local draft preview.</small>
            </button>
            {draft.logoDataUrl ? <button type="button" className="text-button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); updateDraft({ logoName: "", logoDataUrl: "" }); }}>Remove image</button> : null}
            {logoError ? <small className="form-error" role="alert">{logoError}</small> : null}
          </label>
        </div>
        <div className="form-divider" />
        <div className="form-section-head"><span className="eyebrow">Socials</span><small>All optional</small></div>
        <div className="form-grid">
          <label>Website<input value={draft.website} onChange={(e) => updateDraft({ website: e.target.value })} placeholder="https://" /></label>
          <label>X / Twitter<input value={draft.twitter} onChange={(e) => updateDraft({ twitter: e.target.value })} placeholder="https://x.com/" /></label>
          <label>Telegram<input value={draft.telegram} onChange={(e) => updateDraft({ telegram: e.target.value })} placeholder="https://t.me/" /></label>
          <label>Discord<input value={draft.discord} onChange={(e) => updateDraft({ discord: e.target.value })} placeholder="https://discord.gg/" /></label>
        </div>
        {touched && !valid ? <p className="form-error">Enter a token name and a 2-8 character symbol.</p> : null}
        <button className="button button-primary form-continue" onClick={continueFlow}>Continue <Icon name="arrow" /></button>
      </section>
      <TokenPreview />
    </div>
  );
}

function MarketStep() {
  const { draft, updateDraft } = useLaunchDraft();
  const router = useRouter();
  const [touched, setTouched] = useState(false);
  const valid = /^(?=.*[1-9])\d+(?:\.\d{1,18})?$/.test(draft.initialLiquidity)
    && /^(?=.*[1-9])\d+(?:\.\d{1,18})?$/.test(draft.tokenSeedAmount)
    && (() => { try { return parseEther(draft.tokenSeedAmount) <= parseEther("1000000000"); } catch { return false; } })()
    && draft.quoteAsset === "ETH";
  const continueFlow = () => { setTouched(true); if (valid) router.push("/launch/split"); };
  let totalEth = "0.000500";
  try { totalEth = formatEther(parseEther(draft.initialLiquidity || "0") + parseEther("0.0005")); } catch { /* Invalid drafts are explained below. */ }
  return <div className="launch-content-grid"><section className="launch-form-card glass-panel"><span className="eyebrow">Step 02 / Market</span><h2>Shape the<br /><span>market.</span></h2><p>Set token supply and initial pool liquidity. The protocol launch fee is separate from your seed.</p><div className="form-grid market-form"><label>Fixed token supply<input value="1,000,000,000" readOnly aria-readonly="true" /></label><label>Quote asset<select value={draft.quoteAsset} onChange={(e) => updateDraft({ quoteAsset: e.target.value })}><option>ETH</option><option disabled>USDC - unavailable</option></select></label><label>Initial ETH liquidity*<input type="number" min="0.000000000000000001" step="any" value={draft.initialLiquidity} onChange={(e) => updateDraft({ initialLiquidity: e.target.value })} /></label><label>Token amount for liquidity*<input type="number" min="0.000000000000000001" step="any" value={draft.tokenSeedAmount} onChange={(e) => updateDraft({ tokenSeedAmount: e.target.value })} /></label></div><div className="launch-cost-summary"><div><span>Launch fee</span><strong>0.0005 ETH</strong><small>Paid to SPLIT Protocol Treasury</small></div><div><span>Initial liquidity</span><strong>{draft.initialLiquidity || "0"} ETH + {draft.tokenSeedAmount || "0"} tokens</strong><small>Seeded separately through the Liquidity Vault</small></div></div><div className="info-callout"><Icon name="lock" /><div><strong>1% on official registered-pool swaps</strong><p>Other pools and venues are outside SPLIT fee accounting. Of each fee collected by the official SPLIT pool hook, 10% is Protocol Revenue and the remaining 90% follows your configurable 100% project split. The pool also charges its separate 0.30% LP fee.</p></div></div><div className="launch-cost-summary"><div><span>Total ETH required</span><strong>{totalEth} ETH</strong><small>Launch fee + ETH liquidity; excludes gas</small></div></div>{touched && !valid ? <p className="form-error">Enter positive seed amounts with up to 18 decimals; token seed cannot exceed 1 billion.</p> : null}<div className="wizard-actions"><Link className="button button-outline" href="/launch/details"><Icon name="back" />Back</Link><button className="button button-primary" onClick={continueFlow}>Continue <Icon name="arrow" /></button></div></section><MarketPreview /></div>;
}

function SplitStep() {
  const { draft, updateAllocation, updateDraft } = useLaunchDraft();
  const router = useRouter();
  const allocations = useMemo(() => DEFAULT_SPLIT.map((item) => ({ ...item, value: draft.allocations[item.key] })), [draft.allocations]);
  const total = Object.values(draft.allocations).reduce((sum, value) => sum + value, 0);
  const wholePercentages = Object.values(draft.allocations).every((value) => Number.isInteger(value) && value >= 0 && value <= 100);
  const communityValid = isAddress(draft.communityAddress);
  const projectTreasuryValid = draft.allocations.projectTreasury === 0 || isAddress(draft.projectTreasuryAddress);
  return <div className="split-builder-layout"><section className="launch-form-card glass-panel split-controls"><span className="eyebrow">Step 03 / Split</span><h2>Route every<br /><span>fee.</span></h2><p>Configure how the remaining 90% of SPLIT&apos;s collected swap fee is allocated. These project shares must total 100%; Protocol Revenue is separate and fixed at 10%.</p>{allocations.map((item) => <div className="allocation-control" key={item.key}><div><span><i style={{ background: item.color }} />{item.label}</span><label><input type="number" min="0" max="100" value={item.value} onChange={(e) => updateAllocation(item.key, Number(e.target.value))} aria-label={`${item.label} percentage`} />%</label></div><input type="range" min="0" max="100" value={item.value} onChange={(e) => updateAllocation(item.key, Number(e.target.value))} style={{ "--range-progress": `${item.value}%`, "--range-color": item.color } as React.CSSProperties} /></div>)}<label className="field-full">Project Treasury destination{draft.allocations.projectTreasury > 0 ? "*" : " (optional at 0%)"}<input value={draft.projectTreasuryAddress} onChange={(e) => updateDraft({ projectTreasuryAddress: e.target.value.trim() })} placeholder="0x..." aria-invalid={draft.projectTreasuryAddress.length > 0 && !projectTreasuryValid} /></label><label className="field-full">Community destination*<input value={draft.communityAddress} onChange={(e) => updateDraft({ communityAddress: e.target.value.trim() })} placeholder="0x..." aria-invalid={draft.communityAddress.length > 0 && !communityValid} /></label><small>The creator is your connected wallet. Project Treasury is configurable and independent of the global SPLIT Protocol Treasury. Liquidity is permanently reserved in the SPLIT vault.</small><div className={`allocation-total ${total === 100 ? "valid" : "invalid"}`}><span>Project allocation total</span><strong>{total}%</strong><small>{total === 100 ? "Ready to continue" : total < 100 ? `${100 - total}% remains unallocated` : `${total - 100}% over allocation`}</small></div><div className="wizard-actions"><Link className="button button-outline" href="/launch/market"><Icon name="back" />Back</Link><button className="button button-primary" disabled={total !== 100 || !wholePercentages || !communityValid || !projectTreasuryValid} onClick={() => router.push("/launch/review")}>Continue <Icon name="arrow" /></button></div></section><section className="split-visual glass-panel"><span className="eyebrow">Live routing model</span><RouteCore allocations={allocations} /><SplitStrip allocations={allocations} /><p>Of each 1% SPLIT swap fee, 10% is protocol revenue. The remaining 90% follows this project split. Project allocation must equal exactly 100%.</p></section></div>;
}

function TokenPreview() {
  const { draft } = useLaunchDraft();
  return <aside className="launch-preview glass-panel"><div className="form-section-head"><span className="eyebrow">Live token preview</span><span className="draft-badge"><span className="status-dot" />Draft</span></div><div className="preview-card"><div className="preview-token-head"><span className="preview-token-glyph">{draft.logoDataUrl ? <Image src={draft.logoDataUrl} width={50} height={50} unoptimized alt="" /> : draft.symbol[0] || "T"}</span><div><strong>{draft.name || "Your Token"}</strong><span>${draft.symbol || "TKN"}</span></div><span className="status-badge status-upcoming">Upcoming</span></div><dl><div><dt>Mcap</dt><dd>-</dd></div><div><dt>Vol (24h)</dt><dd>-</dd></div><div><dt>Liq</dt><dd>-</dd></div></dl><span className="eyebrow">SPLIT swap fee <b>1% / 10% protocol share</b></span><small>Launch fee: 0.0005 ETH, separate from initial liquidity.</small><SplitStrip allocations={DEFAULT_SPLIT.map((item) => ({ ...item, value: draft.allocations[item.key] }))} /><div className="preview-actions"><Link href="/explore">Explore launches <Icon name="external" size={13} /></Link><button type="button" className="preview-trade" disabled title="Trading becomes available after deployment">Trade</button></div></div><p>This is how your token will appear across the launchpad.</p></aside>;
}

function MarketPreview() {
  const { draft } = useLaunchDraft();
  return <aside className="launch-preview glass-panel"><span className="eyebrow">Market summary</span><h3>{draft.name || "Your token"} / {draft.quoteAsset}</h3><dl className="market-preview-list"><div><dt>Supply</dt><dd>{formatTokenSupply(draft.supply || "0")}</dd></div><div><dt>Initial liquidity</dt><dd>{draft.initialLiquidity || "0"} ETH</dd></div><div><dt>Fee source</dt><dd>1% on official registered SPLIT-pool swaps</dd></div><div><dt>Price discovery</dt><dd>At launch</dd></div></dl><div className="market-orbit"><span /><i /></div><p>Final values remain subject to contract-side validation.</p></aside>;
}

