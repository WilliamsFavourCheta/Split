"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Allocation } from "../data/mock";
import { selectPriceSnapshots, type PriceSnapshot, type PricePeriod } from "../lib/projects/price";

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

function formatSnapshotPrice(value: number) {
  return `${new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 }).format(value)} ETH`;
}

export function TokenPriceChart({ ticker, snapshots, status = "ready" }: { ticker: string; snapshots: PriceSnapshot[]; status?: "ready" | "unconfigured" | "migration-required" }) {
  const [period, setPeriod] = useState<PricePeriod>("1D");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const visible = useMemo(() => selectPriceSnapshots(snapshots, period), [period, snapshots]);
  const values = visible.map((point) => point.priceEth);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const spread = Math.max(high - low, Math.abs(high) * 0.03, Number.MIN_VALUE);
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
    {visible.length > 0 ? <><div className="token-chart-frame"><svg ref={svgRef} viewBox="0 0 850 220" preserveAspectRatio="none" role="img" aria-label={`${visible.length} indexed pool price events`} onPointerMove={updateHover} onPointerLeave={() => setHoverIndex(null)}><defs><linearGradient id="token-chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#9c6cff" stopOpacity=".3" /><stop offset="100%" stopColor="#9c6cff" stopOpacity="0" /></linearGradient></defs>{[24, 78, 132, 186].map((y) => <line key={y} x1="0" y1={y} x2="850" y2={y} className="chart-grid-line" />)}{area ? <path d={area} fill="url(#token-chart-fill)" /> : null}{coords.length > 1 ? <polyline points={line} className="chart-line" /> : coords.map((point) => <circle key={`${point.x}:${point.y}`} cx={point.x} cy={point.y} r="5" className="token-chart-dot" />)}{activePoint && coords[activeIndex] ? <circle cx={coords[activeIndex].x} cy={coords[activeIndex].y} r="5" className="token-chart-focus" /> : null}</svg>{activePoint ? <div className="token-chart-tooltip" style={{ left: `${Math.min(88, Math.max(12, (coords[activeIndex]?.x ?? 425) / 8.5))}%` }}><strong>{formatSnapshotPrice(activePoint.priceEth)}</strong><small>{new Date(activePoint.snapshotAt).toLocaleString()}</small></div> : null}</div><div className="token-chart-axis"><span>{visible[0] ? new Date(visible[0].snapshotAt).toLocaleDateString() : ""}</span><span>{visible.length > 2 ? new Date(visible[Math.floor(visible.length / 2)].snapshotAt).toLocaleDateString() : ""}</span><span>{visible.at(-1) ? new Date(visible.at(-1)!.snapshotAt).toLocaleDateString() : ""}</span></div></> : <div className="token-chart-empty"><div className="token-chart-grid" /><span className="eyebrow">{status === "migration-required" ? "Price-history migration required" : status === "unconfigured" ? "Chart data not configured" : "Waiting for official pool prices"}</span><p>{status === "migration-required" ? "Price-history indexing is unavailable. Ask the operator to verify the already-applied migration and indexer." : status === "unconfigured" ? "Configure the SPLIT indexer and database to load official pool price events." : "There are no official pool price observations for this period yet. The chart uses canonical Robinhood Chain launch and Swap events; no sample prices are shown."}</p></div>}
    <small className="token-chart-source">Source: post-swap sqrtPriceX96 from the Robinhood Chain Uniswap v4 PoolManager.</small>
  </section>;
}

export function FlowDiagram({ allocations }: { allocations: Allocation[] }) {
  return <div className="flow-diagram"><div className="flow-input"><span>Official SPLIT pool fee</span><strong>1% on registered-pool swaps</strong></div><div className="flow-line" /><div className="flow-output"><div className="protocol-fee-row"><strong>Protocol Treasury · 10%</strong><span>of collected SPLIT fee</span></div><p>Remaining 90% → project split</p><FeeBars allocations={allocations} /><small>Seeded liquidity is permanently committed; later Liquidity allocations stay pending in the vault and are not automatically reinvested.</small></div><div className="flow-execution"><span className="eyebrow">Execution</span><div>{allocations.map((item) => <span key={item.label} style={{ "--dot-color": item.color } as React.CSSProperties}>{item.label.slice(0, 4)}</span>)}</div></div></div>;
}
