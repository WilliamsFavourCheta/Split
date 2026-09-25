"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { EXPLORER_URL, explorerAddress, explorerTx, shortAddress, type Token } from "../data/mock";
import { Icon } from "./icons";
import { useToast, useWallet } from "./providers";
import { AppShell, CopyButton, PageIntro, StatusBadge } from "./shell";
import { FlowDiagram, SplitStrip } from "./visuals";

type RoutingEventView = { id: string; tx_hash: string; block_number: number; destination_type: string; destination_address: string | null; raw_amount: string; currency: string | null; token_decimals: number | null };
type AccrualEventView = { id: string; tx_hash: string; block_number: number; raw_amount: string; currency: string; swapper_address: string };

function TokenGlyph({ token, large = false }: { token: Token; large?: boolean }) {
  return <span className={`token-glyph ${large ? "token-glyph-large" : ""}`} style={{ "--token-color": token.color } as React.CSSProperties}>{token.ticker[0]}</span>;
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
    {loading ? <DataSkeleton /> : dataUnavailable ? <div className="empty-state glass-panel"><Icon name="search" size={30} /><h2>Chain index unavailable</h2><p>Apply the SPLIT protocol index migration and configure the indexer. No demo launches are shown.</p></div> : filtered.length ? <div className="token-grid">{filtered.map((token) => <TokenCard token={token} key={token.address} />)}</div> : <div className="empty-state glass-panel"><Icon name="search" size={30} /><h2>No launches found</h2><p>Try a different name, ticker, address, or status.</p><button className="button button-outline" onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</button></div>}
    <div className="explore-footnote"><span><span className="help-mark">?</span>Only confirmed SPLIT factory launches appear here.</span><a href="https://docs.robinhood.com/chain/" target="_blank" rel="noreferrer">Robinhood Chain docs <Icon name="external" size={13} /></a></div>
  </div></AppShell>;
}

export function ProjectNotIndexedPage({ address }: { address: string }) {
  return <AppShell><div className="section-shell page-body empty-state glass-panel"><Icon name="search" size={30} /><h1>No SPLIT launch indexed</h1><p>{address} is not a canonical token address emitted by the configured SPLIT factory, or the indexer has not caught up yet.</p><Link className="button button-outline" href="/explore">Back to Explore</Link></div></AppShell>;
}

function TokenCard({ token }: { token: Token }) {
  const { showToast } = useToast();
  const copy = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    try { await navigator.clipboard.writeText(token.address); showToast("Contract address copied", "success"); } catch { showToast("Clipboard permission was blocked", "error"); }
  };
  return <article className="token-card glass-panel"><Link href={`/token/${token.address}`} aria-label={`View ${token.name}`}><div className="token-card-head"><TokenGlyph token={token} /><div><h2>{token.name}</h2><span>${token.ticker}</span></div><StatusBadge status={token.status} /></div><dl className="token-metrics"><div><dt>Mcap</dt><dd>{token.marketCap}</dd></div><div><dt>Vol 24h</dt><dd>{token.volume}</dd></div><div><dt>Liquidity</dt><dd>{token.liquidity}</dd></div></dl><div className="card-split"><div><span>Onchain fee configuration</span><strong>Immutable split</strong></div><SplitStrip allocations={token.split} /><div className="card-legend">{token.split.map((item) => <span key={item.key}><i style={{ background: item.color }} />{item.label}<b>{item.value}%</b></span>)}</div></div><div className="token-card-foot"><span>Launched {token.launched}</span><div><button className="copy-contract" onClick={copy}><Icon name="copy" size={14} />Copy</button><span>View token</span><Icon name="external" size={14} /></div></div></Link></article>;
}

export function TokenDetailPage({ token, routingEvents = [], accrualEvents = [] }: { token: Token; routingEvents?: RoutingEventView[]; accrualEvents?: AccrualEventView[] }) {
  const router = useRouter();
  const wallet = useWallet();
  const [tradeOpen, setTradeOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => { const timer = window.setTimeout(() => setLoading(false), 380); return () => clearTimeout(timer); }, []);
  const canManage = wallet.status === "connected" && wallet.address?.toLowerCase() === token.owner.toLowerCase();

  if (loading) return <AppShell><div className="section-shell page-body"><div className="detail-skeleton"><span /><span /><span /><span /></div></div></AppShell>;

  return <AppShell><div className="section-shell page-body token-detail-page">
    <button className="back-link" onClick={() => window.history.length > 1 ? router.back() : router.push("/explore")}><Icon name="back" />Explore</button>
    <section className="token-identity"><div className="token-title-row"><TokenGlyph token={token} large /><div><StatusBadge status={token.status} /><h1>{token.name} <span>${token.ticker}</span></h1><div className="contract-line"><code>{shortAddress(token.address, 8, 6)}</code><CopyButton value={token.address} label="Copy contract address" /><span>Contract address</span></div></div></div><div className="token-socials"><a href={token.twitter} target="_blank" rel="noreferrer" aria-label="X"><Icon name="twitter" /></a><a href={token.telegram} target="_blank" rel="noreferrer" aria-label="Telegram"><Icon name="telegram" /></a><a href={token.discord} target="_blank" rel="noreferrer" aria-label="Discord"><Icon name="discord" /></a><a href={token.website} target="_blank" rel="noreferrer" aria-label="Website"><Icon name="globe" /></a></div><div className="token-actions"><button className="button button-primary" onClick={() => setTradeOpen(true)}>Trade <Icon name="external" /></button><a className="button button-outline" href={explorerAddress(token.address)} target="_blank" rel="noreferrer">View contract <Icon name="external" /></a>{canManage ? <Link className="button button-quiet" href={`/manage/${token.address}`}>Manage project</Link> : null}</div></section>
    <dl className="market-stat-strip glass-panel"><div><dt>Price</dt><dd>{token.price}</dd></div><div><dt>Market cap</dt><dd>{token.marketCap}</dd></div><div><dt>Volume · 24h</dt><dd>{token.volume}</dd></div><div><dt>Liquidity</dt><dd>{token.liquidity}</dd></div><div><dt>Holders</dt><dd>{token.holders}</dd></div></dl>
    <section className="detail-section"><div className="section-heading"><div><span className="eyebrow">Market performance</span><h2>Price action</h2></div></div><div className="empty-state glass-panel"><p>Price history is not yet indexed. No chart data is being simulated.</p></div></section>
    <section className="detail-section fees-section"><span className="eyebrow">Onchain fee accounting</span><h2>Where the fees go</h2><p>The immutable fee split is read from the indexed onchain configuration. Accrued fees, allocations, successful claims, and vault credits are separate events.</p><div className="fee-detail-grid"><div className="glass-panel routing-panel"><FlowDiagram allocations={token.split} /></div><div className="glass-panel fee-totals"><span className="eyebrow">Event counts (latest 50)</span><div className="fee-total-row"><span>Fees accrued</span><strong>{accrualEvents.length}</strong></div><div className="fee-total-row"><span>Fees allocated</span><strong>{routingEvents.length}</strong></div><p>Allocation is not payment. Amounts may be in ETH or the launched token and are not combined into a misleading USD total.</p></div></div></section>
    <section className="detail-section history-section"><div className="section-heading"><div><span className="eyebrow">Canonical chain logs</span><h2>Fee allocations</h2></div><a href={`${EXPLORER_URL}/address/${token.address}?tab=txs`} target="_blank" rel="noreferrer">View explorer <Icon name="external" /></a></div>{routingEvents.length ? <div className="history-list">{routingEvents.map((row) => <div className="history-row" key={row.id}><span className="history-icon"><Icon name="wallet" /></span><strong>{formatUnits(BigInt(row.raw_amount), row.token_decimals ?? 18)} {row.currency?.toLowerCase() === "0x0000000000000000000000000000000000000000" ? "ETH" : token.ticker}</strong><span className="history-arrow">→</span><strong>{row.destination_type}</strong><small>Block {row.block_number}</small><a href={explorerTx(row.tx_hash)} target="_blank" rel="noreferrer">View tx <Icon name="external" size={12} /></a></div>)}</div> : <div className="empty-state glass-panel"><p>No canonical fee allocations have been indexed for this project yet.</p></div>}</section>
    {tradeOpen ? <div className="modal-backdrop" role="presentation" onMouseDown={() => setTradeOpen(false)}><div className="modal glass-panel" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setTradeOpen(false)}><Icon name="close" /></button><span className="eyebrow">Trading interface</span><h2>Trade ${token.ticker}</h2><p>The production trading route has not been configured yet. No swap will be fabricated.</p><a className="button button-primary" href={explorerAddress(token.address)} target="_blank" rel="noreferrer">Inspect token on Blockscout <Icon name="external" /></a></div></div> : null}
  </div></AppShell>;
}
