"use client";

import { useEffect, useMemo, useState } from "react";
import type { SolanaPriceSample } from "../../lib/solana/repository";

type Mode = "price_usd" | "market_cap_usd";
type LiveResponse = { status?: string; sample?: SolanaPriceSample; error?: string; market_cap_basis?: string };

function numeric(value: number | null) {
  const parsed = Number(value);
  return value !== null && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function SolanaMarketChart({ mint, samples }: { mint: string; samples: SolanaPriceSample[] }) {
  const [mode, setMode] = useState<Mode>("price_usd");
  const [liveSamples, setLiveSamples] = useState(samples);
  const [freshness, setFreshness] = useState("Checking finalized onchain price...");
  const points = useMemo(() => liveSamples.map((sample) => numeric(sample[mode])).filter((value): value is number => value !== null), [liveSamples, mode]);
  const available = points.length > 0;
  const latest = available ? points[points.length - 1] : null;

  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const response = await fetch(`/api/solana/tokens/${encodeURIComponent(mint)}/live`, { cache: "no-store" });
        const result = await response.json() as LiveResponse;
        if (!active) return;
        if (!response.ok || !result.sample || numeric(result.sample.price_usd) === null
          || numeric(result.sample.market_cap_usd) === null) {
          setFreshness(result.status === "graduated" ? "Curve trading ended at graduation; CPMM pricing is pending."
            : result.error || "Live price unavailable. Showing the last finalized sample.");
          return;
        }
        setFreshness(`Finalized slot ${result.sample.slot} · refreshed ${new Date(result.sample.sampled_at).toLocaleTimeString()}`);
        setLiveSamples((previous) => {
          const last = previous.at(-1);
          if (last && last.slot >= result.sample!.slot) return previous;
          return [...previous, result.sample!].slice(-100);
        });
      } catch {
        if (active) setFreshness("Live price unavailable. Showing the last finalized sample.");
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 20_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [mint]);

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
    <div className="solana-market-heading"><div><span className="eyebrow">Finalized onchain price</span><h2>{mode === "price_usd" ? "Token price" : "Market cap / FDV"}</h2></div>
      <div className="solana-chart-modes"><button type="button" aria-pressed={mode === "price_usd"} onClick={() => setMode("price_usd")}>USD</button>
        <button type="button" aria-pressed={mode === "market_cap_usd"} onClick={() => setMode("market_cap_usd")}>Market cap</button></div></div>
    {latest !== null ? <strong className="solana-chart-value">${latest.toLocaleString("en-US", { maximumSignificantDigits: 7 })}</strong> : null}
    {available ? <svg className="solana-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img"
      aria-label={`${mode === "price_usd" ? "USD price" : "USD market cap"} across ${points.length} finalized samples`}>
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke" /></svg>
      : <p>No finalized price sample is available yet.</p>}
    <small aria-live="polite">{freshness}</small>
    {mode === "market_cap_usd" ? <small>Based on the token&apos;s fixed total supply.</small> : null}
  </section>;
}
