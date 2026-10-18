"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { type Token } from "../data/mock";
import { Icon } from "./icons";
import { useToast } from "./providers";
import { AppShell, PageIntro, StatusBadge } from "./shell";
import { SplitStrip } from "./visuals";

function TokenGlyph({ token, large = false }: { token: Token; large?: boolean }) {
  return <span className={`token-glyph ${large ? "token-glyph-large" : ""}`} style={{ "--token-color": token.color } as React.CSSProperties}>{token.ticker[0]}{token.logoUrl ? <Image className="token-logo-image" src={token.logoUrl} width={large ? 70 : 42} height={large ? 70 : 42} unoptimized alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} /> : null}</span>;
}

function DataSkeleton({ cards = 6 }: { cards?: number }) {
  return <div className="token-grid" aria-label="Loading launches">{Array.from({ length: cards }).map((_, i) => <div className="token-card glass-panel skeleton-card" key={i}><span /><span /><span /><span /></div>)}</div>;
}

export function ExplorePage({ tokens, dataUnavailable = false }: { tokens: Token[]; dataUnavailable?: boolean }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | Token["status"]>("all");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => setLoading(false), 450);
    return () => window.clearTimeout(timer);
  }, []);

  const filtered = useMemo(() => tokens.filter((token) => {
    const matchesFilter = filter === "all" || token.status === filter;
    const term = query.trim().toLowerCase();
    const matchesSearch = !term || token.name.toLowerCase().includes(term) || token.ticker.toLowerCase().includes(term.replace("$", "")) || token.address.toLowerCase().includes(term);
    return matchesFilter && matchesSearch;
  }), [filter, query, tokens]);

  return <AppShell><div className="section-shell page-body marketplace-page">
    <PageIntro eyebrow="SPLIT / Marketplace" title={<>Explore<br /><span>Split</span></>} description="Discover launches and see exactly where their fees go." />
    <div className="explore-toolbar"><label className="search-field"><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search token, ticker or contract" aria-label="Search launches" /></label><div className="filter-tabs" role="tablist" aria-label="Launch filters">{(["all", "upcoming", "live", "graduated"] as const).map((status) => <button key={status} role="tab" aria-selected={filter === status} className={filter === status ? "active" : ""} onClick={() => setFilter(status)}>{status === "upcoming" ? "New" : status}</button>)}</div></div>
    <div className="list-meta"><span>{filtered.length} indexed launches</span><span>Robinhood Chain is the source of truth</span></div>
    {loading ? <DataSkeleton /> : dataUnavailable ? <div className="empty-state glass-panel"><Icon name="search" size={30} /><h2>Launch data unavailable</h2><p>The launch index could not be loaded. Check the data service and indexer, then try again.</p></div> : filtered.length ? <div className="token-grid">{filtered.map((token) => <TokenCard token={token} key={token.address} />)}</div> : <div className="empty-state glass-panel"><Icon name="search" size={30} /><h2>No launches found</h2><p>Try a different name, ticker, address, or status.</p><button className="button button-outline" onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</button></div>}
    <div className="explore-footnote"><span><span className="help-mark">?</span>Only confirmed SPLIT factory launches appear here.</span><a href="https://docs.robinhood.com/chain/" target="_blank" rel="noreferrer">Robinhood Chain docs <Icon name="external" size={13} /></a></div>
  </div></AppShell>;
}

export function ProjectNotIndexedPage({ address }: { address: string }) {
  return <AppShell><div className="section-shell page-body empty-state glass-panel"><Icon name="search" size={30} /><h1>No SPLIT launch indexed</h1><p>{address} is not a canonical token address emitted by the configured SPLIT factory, or the indexer has not caught up yet.</p><Link className="button button-outline" href="/explore">Back to Explore</Link></div></AppShell>;
}

export function ProjectDataUnavailablePage() {
  return <AppShell><div className="section-shell page-body empty-state glass-panel" role="alert"><Icon name="search" size={30} /><h1>Project data unavailable</h1><p>The launch index could not be loaded. Please try again after the data service is restored.</p><Link className="button button-outline" href="/explore">Back to Explore</Link></div></AppShell>;
}

function TokenCard({ token }: { token: Token }) {
  const { showToast } = useToast();
  const copy = async () => {
    try { await navigator.clipboard.writeText(token.address); showToast("Contract address copied", "success"); } catch { showToast("Clipboard permission was blocked", "error"); }
  };
  return <article className="token-card glass-panel">
    <Link href={`/token/${token.address}`} aria-label={`View ${token.name}`}>
      <div className="token-card-head"><TokenGlyph token={token} /><div><h2>{token.name}</h2><span>${token.ticker}</span></div><StatusBadge status={token.status} /></div>
      <dl className="token-metrics"><div><dt>Mcap</dt><dd>{token.marketCap}</dd></div><div><dt>Vol 24h</dt><dd>{token.volume}</dd></div><div><dt>Liquidity</dt><dd>{token.liquidity}</dd></div></dl>
      <div className="card-split"><div><span>Onchain fee configuration</span><strong>Immutable split</strong></div><SplitStrip allocations={token.split} /><div className="card-legend">{token.split.map((item) => <span key={item.key}><i style={{ background: item.color }} />{item.label}<b>{item.value}%</b></span>)}</div></div>
    </Link>
    <div className="token-card-foot token-card-actions"><span>Launched {token.launched}</span><div><button className="copy-contract" onClick={() => void copy()} aria-label={`Copy ${token.name} contract address`}><Icon name="copy" size={14} />Copy</button><Link href={`/token/${token.address}`}>View token <Icon name="external" size={14} /></Link></div></div>
  </article>;
}
