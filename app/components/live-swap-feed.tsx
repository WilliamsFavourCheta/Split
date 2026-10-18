"use client";

import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { explorerTx } from "../data/mock";
import { Icon } from "./icons";

export type LiveSwap = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  timestamp: string | null;
  direction: "buy" | "sell";
  ethAmountRaw: string;
  tokenAmountRaw: string;
  sqrtPriceX96: string;
};
type LiveResponse = { swaps: LiveSwap[]; throughBlock: number | null };

function compactAmount(raw: string) {
  const value = Number(formatUnits(BigInt(raw), 18));
  if (value === 0) return "0";
  if (value < 0.000001) return value.toPrecision(4);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(value);
}

export function LiveSwapFeed({ address, ticker, onSwaps }: { address: string; ticker: string; onSwaps?: (swaps: LiveSwap[]) => void }) {
  const [data, setData] = useState<LiveResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    async function refresh() {
      if (document.visibilityState === "hidden") return;
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch(`/api/tokens/${address}/live`, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Recent swaps unavailable");
        const next = await response.json() as LiveResponse;
        if (active) { setData(next); setError(false); onSwaps?.(next.swaps); }
      } catch (cause) {
        if (active && !(cause instanceof DOMException && cause.name === "AbortError")) setError(true);
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [address, onSwaps]);

  return <section className="terminal-live-feed" aria-label="Recent official pool swaps">
    <div className="terminal-section-title"><span className="eyebrow">Official pool activity</span><h2>Recent swaps</h2><p>Finalized Robinhood Chain swaps, checked every 30 seconds while this page is open.</p></div>
    <div className="glass-panel terminal-live-content">
      {error ? <p role="status">Recent swaps are temporarily unavailable. This panel will retry automatically.</p>
        : !data ? <p role="status">Loading recent swaps...</p>
          : data.swaps.length === 0 ? <div className="terminal-empty"><Icon name="chart" size={25} /><strong>No recent swaps</strong><p>No trades appeared in the latest 10,000 finalized blocks. Older indexed chart and fee history remain above and below.</p></div>
            : <div className="terminal-table-wrap"><table><thead><tr><th>Time</th><th>Side</th><th>ETH</th><th>{ticker}</th><th>Transaction</th></tr></thead><tbody>{data.swaps.map((swap) => <tr key={`${swap.txHash}:${swap.logIndex}`}><td>{swap.timestamp ? new Date(swap.timestamp).toLocaleString() : `Block ${swap.blockNumber.toLocaleString()}`}</td><td><span className={swap.direction === "buy" ? "success-text" : "error-text"}>{swap.direction === "buy" ? "Buy" : "Sell"}</span></td><td>{compactAmount(swap.ethAmountRaw)}</td><td>{compactAmount(swap.tokenAmountRaw)}</td><td><a href={explorerTx(swap.txHash)} target="_blank" rel="noreferrer">View <Icon name="external" size={12} /></a></td></tr>)}</tbody></table></div>}
      {data?.throughBlock ? <small>Finalized through block {data.throughBlock.toLocaleString()}.</small> : null}
    </div>
  </section>;
}
