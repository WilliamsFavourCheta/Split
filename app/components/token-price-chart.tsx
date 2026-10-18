"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { buildChartSeries, type ChartMode, type PricePeriod, type PriceSnapshot, type UsdQuote } from "../lib/projects/price";

const modes: Array<{ value: ChartMode; label: string }> = [
  { value: "priceUsd", label: "Price · USD" },
  { value: "marketCapUsd", label: "Market cap · USD" },
  { value: "priceEth", label: "Price · ETH" },
  { value: "marketCapEth", label: "Market cap · ETH" },
];

function formatValue(value: number, mode: ChartMode) {
  const formatted = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 }).format(value);
  return mode.endsWith("Usd") ? `$${formatted}` : `${formatted} ETH`;
}

export function TokenPriceChart({ ticker, snapshots, status = "ready" }: {
  ticker: string;
  snapshots: PriceSnapshot[];
  status?: "ready" | "unconfigured" | "migration-required";
}) {
  const [period, setPeriod] = useState<PricePeriod>("1D");
  const [mode, setMode] = useState<ChartMode>("marketCapEth");
  const [quotes, setQuotes] = useState<UsdQuote[]>([]);
  const [usdError, setUsdError] = useState(false);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const fromSeconds = snapshots.length ? Math.floor(Date.parse(snapshots[0].snapshotAt) / 1_000) : null;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setNowMs(Date.now()));
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => { window.cancelAnimationFrame(frame); window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (fromSeconds === null || !Number.isFinite(fromSeconds)) return;
    let active = true;
    let controller: AbortController | null = null;
    async function refresh() {
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch(`/api/market/eth-usd?from=${fromSeconds}`, { signal: controller.signal });
        if (!response.ok) throw new Error("USD rates unavailable");
        const result = await response.json() as { quotes: UsdQuote[] };
        if (active) { setQuotes(result.quotes); setUsdError(false); }
      } catch (cause) {
        if (active && !(cause instanceof DOMException && cause.name === "AbortError")) setUsdError(true);
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 300_000);
    return () => { active = false; controller?.abort(); window.clearInterval(timer); };
  }, [fromSeconds]);

  const points = useMemo(() => nowMs === null ? [] : buildChartSeries(snapshots, quotes, period, mode, nowMs), [snapshots, quotes, period, mode, nowMs]);
  const values = points.map((point) => point.value);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const spread = Math.max(high - low, Math.abs(high) * 0.03, Number.MIN_VALUE);
  const firstTime = points.length ? Date.parse(points[0].snapshotAt) : 0;
  const lastTime = points.length ? Date.parse(points.at(-1)!.snapshotAt) : 0;
  const timeSpan = Math.max(1, lastTime - firstTime);
  const coords = points.map((point) => ({
    x: 12 + ((Date.parse(point.snapshotAt) - firstTime) / timeSpan) * 826,
    y: 12 + ((high + spread * 0.08 - point.value) / (spread * 1.16)) * 180,
  }));
  const line = coords.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
  const area = coords.length > 1 ? `M${coords[0].x},210 L${coords.map((point) => `${point.x},${point.y}`).join(" L")} L${coords.at(-1)?.x},210 Z` : "";
  const activeIndex = hoverIndex === null ? points.length - 1 : Math.min(hoverIndex, points.length - 1);
  const activePoint = points[activeIndex];
  const change = values.length > 1 && values[0] > 0 ? ((values.at(-1)! - values[0]) / values[0]) * 100 : null;
  const usdAvailable = quotes.length > 0;
  const eventCount = nowMs === null ? 0 : snapshots.filter((point) => period === "ALL" || Date.parse(point.snapshotAt) >= nowMs - ({ "1D": 86_400_000, "7D": 604_800_000, "30D": 2_592_000_000 } as const)[period]).length;

  const updateHover = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!coords.length || !svgRef.current) return;
    const bounds = svgRef.current.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * 850;
    let nearest = 0;
    for (let index = 1; index < coords.length; index += 1) {
      if (Math.abs(coords[index].x - x) < Math.abs(coords[nearest].x - x)) nearest = index;
    }
    setHoverIndex(nearest);
  };

  return <section className="token-price-chart glass-panel" aria-label={`${ticker} ${modes.find((item) => item.value === mode)?.label} chart`}>
    <div className="chart-mode-tabs" role="group" aria-label="Chart value">
      {modes.map((item) => <button key={item.value} type="button" className={mode === item.value ? "active" : ""} aria-pressed={mode === item.value} disabled={item.value.endsWith("Usd") && !usdAvailable} onClick={() => { setMode(item.value); setHoverIndex(null); }}>{item.label}</button>)}
    </div>
    <div className="token-chart-head"><div><span className="eyebrow">{modes.find((item) => item.value === mode)?.label}</span><strong>{activePoint ? formatValue(activePoint.value, mode) : "—"}</strong>{change !== null ? <small className={change >= 0 ? "success-text" : "error-text"}>{change >= 0 ? "+" : ""}{change.toFixed(2)}% in selected period</small> : null}</div><div className="period-tabs" role="tablist" aria-label="Chart period">{(["1D", "7D", "30D", "ALL"] as const).map((item) => <button type="button" key={item} role="tab" aria-selected={period === item} className={period === item ? "active" : ""} onClick={() => { setPeriod(item); setHoverIndex(null); }}>{item}</button>)}</div></div>
    {points.length ? <><div className="token-chart-frame"><svg ref={svgRef} viewBox="0 0 850 220" preserveAspectRatio="none" role="img" aria-label={`${points.length} timestamped chart values`} onPointerMove={updateHover} onPointerLeave={() => setHoverIndex(null)}><defs><linearGradient id="token-chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#9c6cff" stopOpacity=".3" /><stop offset="100%" stopColor="#9c6cff" stopOpacity="0" /></linearGradient></defs>{[24, 78, 132, 186].map((y) => <line key={y} x1="0" y1={y} x2="850" y2={y} className="chart-grid-line" />)}{area ? <path d={area} fill="url(#token-chart-fill)" /> : null}{coords.length > 1 ? <polyline points={line} className="chart-line" /> : coords.map((point) => <circle key={`${point.x}:${point.y}`} cx={point.x} cy={point.y} r="5" className="token-chart-dot" />)}{activePoint && coords[activeIndex] ? <circle cx={coords[activeIndex].x} cy={coords[activeIndex].y} r="5" className="token-chart-focus" /> : null}</svg>{activePoint ? <div className="token-chart-tooltip" style={{ left: `${Math.min(88, Math.max(12, (coords[activeIndex]?.x ?? 425) / 8.5))}%` }}><strong>{formatValue(activePoint.value, mode)}</strong><small>{new Date(activePoint.snapshotAt).toLocaleString()}</small></div> : null}</div><div className="token-chart-axis"><span>{new Date(points[0].snapshotAt).toLocaleDateString()}</span><span>{points.length > 2 ? new Date(points[Math.floor(points.length / 2)].snapshotAt).toLocaleDateString() : ""}</span><span>{new Date(points.at(-1)!.snapshotAt).toLocaleDateString()}</span></div>{eventCount <= 1 ? <p className="gas-disclaimer">{eventCount === 0 ? "No pool swaps in this period; the last onchain token price is carried forward." : "Only one pool price observation is available in this period."} {mode.endsWith("Usd") ? "USD values can still change with ETH/USD." : ""}</p> : null}</> : <div className="token-chart-empty"><div className="token-chart-grid" /><span className="eyebrow">{nowMs === null ? "Loading chart" : status === "migration-required" ? "Price history unavailable" : status === "unconfigured" ? "Chart data not configured" : "Waiting for official pool prices"}</span><p>{nowMs === null ? "Preparing official pool prices." : status === "migration-required" ? "Verify the price-history migration and indexer." : "The chart uses the official pool launch and swap prices. It will appear after the launch is indexed."}</p></div>}
    <small className="token-chart-source">Token ETH price comes from official pool events. Market cap is fully diluted using the fixed 1 billion supply. {usdError && !usdAvailable ? "USD conversion is temporarily unavailable." : usdAvailable ? <>USD estimates use historical ETH/USD samples from <a href="https://defillama.com" target="_blank" rel="noreferrer">DefiLlama</a>.</> : "Loading historical ETH/USD for USD views."}</small>
  </section>;
}
