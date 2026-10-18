"use client";

import { useMemo, useState } from "react";
import type { SolanaPriceSample } from "../../lib/solana/repository";

type Mode = "price_usd" | "market_cap_usd";

function numeric(value: number | null) {
  const parsed = Number(value);
  return value !== null && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function SolanaMarketChart({ samples }: { samples: SolanaPriceSample[] }) {
  const [mode, setMode] = useState<Mode>("price_usd");
  const points = useMemo(() => samples.map((sample) => numeric(sample[mode])).filter((value): value is number => value !== null), [samples, mode]);
  const available = points.length > 0;
  const latest = available ? points[points.length - 1] : null;
  const path = useMemo(() => {
    if (!available) return "";
    const low = Math.min(...points);
    const high = Math.max(...points);
    const span = high - low || 1;
    return points.map((point, index) => {
      const x = points.length === 1 ? 50 : index * 100 / (points.length - 1);
      const y = 94 - (point - low) * 82 / span;
      return `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(" ");
  }, [available, points]);

  return <section className="glass-panel solana-market-panel">
    <div className="solana-market-heading"><div><span className="eyebrow">Finalized market samples</span><h2>{mode === "price_usd" ? "Token price" : "Market cap"}</h2></div><div className="solana-chart-modes"><button type="button" aria-pressed={mode === "price_usd"} onClick={() => setMode("price_usd")}>USD</button><button type="button" aria-pressed={mode === "market_cap_usd"} onClick={() => setMode("market_cap_usd")}>Market cap</button></div></div>
    {latest !== null ? <strong className="solana-chart-value">${latest.toLocaleString("en-US", { maximumSignificantDigits: 7 })}</strong> : null}
    {available ? <svg className="solana-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`${mode === "price_usd" ? "USD price" : "USD market cap"} across ${points.length} finalized samples`}><path d={path} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke" /></svg> : <p>Price history is unavailable until finalized trades and a historical SOL/USD rate have been indexed.</p>}
    {samples.length ? <small>Last on-chain sample: {samples[samples.length - 1].sampled_at.replace("T", " ").slice(0, 19)} UTC. The chart moves only when a new finalized price sample arrives.</small> : null}
  </section>;
}
