"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Allocation } from "../data/mock";

export function Reveal({ children, className = "", delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { threshold: 0.14 });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return <div ref={ref} style={{ "--reveal-delay": `${delay}ms` } as React.CSSProperties} className={`reveal ${visible ? "is-visible" : ""} ${className}`}>{children}</div>;
}

export function RouteCore({ compact = false, allocations }: { compact?: boolean; allocations?: Allocation[] }) {
  const values = allocations ?? [
    { label: "Creator", value: 40, color: "#9c6cff" },
    { label: "Liquidity", value: 30, color: "#8150ed" },
      { label: "Project Treasury", value: 20, color: "#6135bd" },
    { label: "Community", value: 10, color: "#c6a3ff" },
  ];
  return (
    <div className={`route-core ${compact ? "route-core-compact" : ""}`} aria-label="One fee routed to four destinations">
      <div className="route-orbit route-orbit-outer" /><div className="route-orbit route-orbit-inner" />
      <div className="route-chamber"><span className="route-input" /><span className="route-node" />{values.map((item, index) => <span key={item.label} className={`route-stream route-stream-${index + 1}`} />)}</div>
      <div className="route-labels">{values.map((item) => <span key={item.label}><small>{item.label}</small><strong>{item.value}%</strong></span>)}</div>
    </div>
  );
}

export function FeeBars({ allocations, interactive = false }: { allocations: Allocation[]; interactive?: boolean }) {
  return <div className={`fee-bars ${interactive ? "fee-bars-interactive" : ""}`}>{allocations.map((item) => <div className="fee-bar-row" key={item.key}><div><span>{item.label}</span><strong>{item.value}%</strong></div><div className="fee-track"><span style={{ width: `${item.value}%`, background: item.color }} /></div></div>)}</div>;
}

export function SplitStrip({ allocations }: { allocations: Allocation[] }) {
  return <div className="split-strip" aria-label={allocations.map((a) => `${a.label} ${a.value}%`).join(", ")}>{allocations.map((item) => <span key={item.key} style={{ width: `${item.value}%`, background: item.color }} />)}</div>;
}

export function Donut({ allocations, size = 76 }: { allocations: Allocation[]; size?: number }) {
  const circles = allocations.map((item, index) => {
    const offset = 25 - allocations.slice(0, index).reduce((total, allocation) => total + allocation.value, 0);
    return <circle key={item.key} cx="50" cy="50" r="39" pathLength="100" fill="none" stroke={item.color} strokeWidth="8" strokeDasharray={`${item.value} ${100 - item.value}`} strokeDashoffset={offset} />;
  });
  return <svg className="donut" width={size} height={size} viewBox="0 0 100 100" aria-label="Fee split chart">{circles}</svg>;
}

const chartSets: Record<string, string> = {
  "24H": "M0 188 C42 174 64 178 96 154 S148 174 178 142 S222 154 256 121 S310 142 346 106 S398 129 430 92 S486 123 526 83 S584 108 628 64 S692 90 738 54 S794 78 850 42",
  "7D": "M0 176 C54 156 82 192 130 150 S208 94 265 122 S352 154 410 96 S498 70 555 102 S640 54 704 70 S792 34 850 48",
  "30D": "M0 198 C70 180 112 120 164 145 S266 192 330 132 S434 104 498 116 S612 52 686 82 S780 38 850 34",
  ALL: "M0 212 C48 198 88 220 130 185 S210 166 264 174 S342 134 405 148 S492 98 556 112 S646 64 708 78 S798 28 850 38",
};

export function PriceChart({ period = "24H" }: { period?: string }) {
  const path = chartSets[period] ?? chartSets["24H"];
  return <div className="price-chart" aria-label={`${period} mock price chart`}><svg viewBox="0 0 850 240" preserveAspectRatio="none" role="img"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#8b5cff" stopOpacity=".38" /><stop offset="100%" stopColor="#8b5cff" stopOpacity="0" /></linearGradient><filter id="chart-glow"><feGaussianBlur stdDeviation="4" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter></defs>{[28, 86, 144, 202].map((y) => <line key={y} x1="0" y1={y} x2="850" y2={y} className="chart-grid-line" />)}<path d={`${path} L850 240 L0 240 Z`} fill="url(#chart-fill)" /><path d={path} className="chart-line" filter="url(#chart-glow)" /></svg><div className="chart-tooltip"><strong>$0.0042</strong><small>Now</small></div><div className="chart-axis"><span>12:00</span><span>18:00</span><span>00:00</span><span>06:00</span><span>12:00</span></div></div>;
}

type PriceSnapshot = { priceEth: number; snapshotAt: string };
type ChartPeriod = "1D" | "7D" | "30D" | "ALL";

function formatSnapshotPrice(value: number) {
  return `${new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 }).format(value)} ETH`;
}

export function TokenPriceChart({ ticker, snapshots, status = "ready" }: { ticker: string; snapshots: PriceSnapshot[]; status?: "ready" | "unconfigured" | "migration-required" }) {
  const [period, setPeriod] = useState<ChartPeriod>("1D");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const visible = useMemo(() => {
    if (period === "ALL" || snapshots.length === 0) return snapshots;
    const ranges: Record<Exclude<ChartPeriod, "ALL">, number> = { "1D": 86_400_000, "7D": 604_800_000, "30D": 2_592_000_000 };
    const latestSnapshotAt = new Date(snapshots.at(-1)!.snapshotAt).getTime();
    const cutoff = latestSnapshotAt - ranges[period];
    return snapshots.filter((point) => new Date(point.snapshotAt).getTime() >= cutoff);
  }, [period, snapshots]);
  const values = visible.map((point) => point.priceEth);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const spread = Math.max(high - low, Math.abs(high) * 0.03, Number.EPSILON);
  const coords = visible.map((point, index) => ({
    x: visible.length === 1 ? 425 : 12 + (index / (visible.length - 1)) * 826,
    y: 12 + ((high + spread * 0.08 - point.priceEth) / (spread * 1.16)) * 180,
  }));
  const line = coords.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
  const area = coords.length > 1 ? `M${coords[0].x},210 L${coords.map((point) => `${point.x},${point.y}`).join(" L")} L${coords.at(-1)?.x},210 Z` : "";
  const activeIndex = hoverIndex === null ? visible.length - 1 : hoverIndex;
  const activePoint = visible[activeIndex];
  const change = visible.length > 1 && visible[0].priceEth > 0
    ? ((visible.at(-1)!.priceEth - visible[0].priceEth) / visible[0].priceEth) * 100
    : null;
  const updateHover = (event: React.PointerEvent<SVGSVGElement>) => {
    if (visible.length < 2 || !svgRef.current) return;
    const bounds = svgRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    setHoverIndex(Math.round(x * (visible.length - 1)));
  };

  return <section className="token-price-chart glass-panel" aria-label={`${ticker} historical price chart`}>
    <div className="token-chart-head"><div><span className="eyebrow">Official pool price in ETH per token</span><strong>{activePoint ? formatSnapshotPrice(activePoint.priceEth) : "No price data"}</strong>{change !== null ? <small className={change >= 0 ? "success-text" : "error-text"}>{change >= 0 ? "+" : ""}{change.toFixed(2)}% in selected period</small> : null}</div><div className="period-tabs" role="tablist" aria-label="Price chart period">{(["1D", "7D", "30D", "ALL"] as const).map((item) => <button type="button" key={item} role="tab" aria-selected={period === item} className={period === item ? "active" : ""} onClick={() => { setPeriod(item); setHoverIndex(null); }}>{item}</button>)}</div></div>
    {visible.length > 0 ? <><div className="token-chart-frame"><svg ref={svgRef} viewBox="0 0 850 220" preserveAspectRatio="none" role="img" aria-label={`${visible.length} indexed pool price events`} onPointerMove={updateHover} onPointerLeave={() => setHoverIndex(null)}><defs><linearGradient id="token-chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#9c6cff" stopOpacity=".3" /><stop offset="100%" stopColor="#9c6cff" stopOpacity="0" /></linearGradient></defs>{[24, 78, 132, 186].map((y) => <line key={y} x1="0" y1={y} x2="850" y2={y} className="chart-grid-line" />)}{area ? <path d={area} fill="url(#token-chart-fill)" /> : null}{coords.length > 1 ? <polyline points={line} className="chart-line" /> : coords.map((point) => <circle key={`${point.x}:${point.y}`} cx={point.x} cy={point.y} r="5" className="token-chart-dot" />)}{activePoint && coords[activeIndex] ? <circle cx={coords[activeIndex].x} cy={coords[activeIndex].y} r="5" className="token-chart-focus" /> : null}</svg>{activePoint ? <div className="token-chart-tooltip" style={{ left: `${Math.min(88, Math.max(12, (coords[activeIndex]?.x ?? 425) / 8.5))}%` }}><strong>{formatSnapshotPrice(activePoint.priceEth)}</strong><small>{new Date(activePoint.snapshotAt).toLocaleString()}</small></div> : null}</div><div className="token-chart-axis"><span>{visible[0] ? new Date(visible[0].snapshotAt).toLocaleDateString() : ""}</span><span>{visible.length > 2 ? new Date(visible[Math.floor(visible.length / 2)].snapshotAt).toLocaleDateString() : ""}</span><span>{visible.at(-1) ? new Date(visible.at(-1)!.snapshotAt).toLocaleDateString() : ""}</span></div></> : <div className="token-chart-empty"><div className="token-chart-grid" /><span className="eyebrow">{status === "migration-required" ? "Price-history migration required" : status === "unconfigured" ? "Chart data not configured" : "Waiting for on-chain trades"}</span><p>{status === "migration-required" ? "Apply supabase/migrations/202609280003_project_price_history.sql to enable exact, canonical pool-price history." : status === "unconfigured" ? "Configure the SPLIT indexer and database to load official pool price events." : "There are no official pool trades for this period yet. The chart uses only canonical Robinhood Chain Swap events; no sample or simulated prices are shown."}</p></div>}
    <small className="token-chart-source">Source: post-swap sqrtPriceX96 from the Robinhood Chain Uniswap v4 PoolManager.</small>
  </section>;
}

export function FlowDiagram({ allocations }: { allocations: Allocation[] }) {
  return <div className="flow-diagram"><div className="flow-input"><span>Official SPLIT pool fee</span><strong>1% on registered-pool swaps</strong></div><div className="flow-line" /><div className="flow-output"><div className="protocol-fee-row"><strong>Protocol Treasury · 10%</strong><span>of collected SPLIT fee</span></div><p>Remaining 90% → project split</p><FeeBars allocations={allocations} /><small>Seeded liquidity is permanently committed; later Liquidity allocations stay pending in the vault and are not automatically reinvested.</small></div><div className="flow-execution"><span className="eyebrow">Execution</span><div>{allocations.map((item) => <span key={item.label} style={{ "--dot-color": item.color } as React.CSSProperties}>{item.label.slice(0, 4)}</span>)}</div></div></div>;
}
