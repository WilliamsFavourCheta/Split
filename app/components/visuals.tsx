"use client";

import { useEffect, useRef, useState } from "react";
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

export function FlowDiagram({ allocations }: { allocations: Allocation[] }) {
  return <div className="flow-diagram"><div className="flow-input"><span>Official SPLIT pool fee</span><strong>1% on registered-pool swaps</strong></div><div className="flow-line" /><div className="flow-output"><div className="protocol-fee-row"><strong>Protocol Treasury · 10%</strong><span>of collected SPLIT fee</span></div><p>Remaining 90% → project split</p><FeeBars allocations={allocations} /><small>Seeded liquidity is permanently committed; later Liquidity allocations stay pending in the vault and are not automatically reinvested.</small></div><div className="flow-execution"><span className="eyebrow">Execution</span><div>{allocations.map((item) => <span key={item.label} style={{ "--dot-color": item.color } as React.CSSProperties}>{item.label.slice(0, 4)}</span>)}</div></div></div>;
}
