"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { DEFAULT_SPLIT } from "../../data/mock";
import "./hero.css";

export function FeeHero() {
  const section = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const labels = useRef<(HTMLButtonElement | null)[]>([]);
  const coreLabel = useRef<HTMLDivElement>(null);
  const incomingLabel = useRef<HTMLSpanElement>(null);
  const progressBar = useRef<HTMLSpanElement>(null);
  const phaseLabel = useRef<HTMLSpanElement>(null);
  const selected = useRef(-1);
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    const observer = new IntersectionObserver(async ([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      try {
        const { createHeroScene } = await import("./hero-scene");
        if (cancelled || !stage.current || !section.current || !viewport.current) return;
        dispose = createHeroScene({
          container: stage.current, section: section.current, viewport: viewport.current,
          labels: labels.current, coreLabel: coreLabel.current!, incomingLabel: incomingLabel.current!,
          progressBar: progressBar.current!, phaseLabel: phaseLabel.current!, selected,
          onReady: () => setReady(true), onFailure: () => setReady(false),
        });
      } catch {
        // The complete HTML/SVG representation stays available if WebGL or its chunk fails.
        if (!cancelled) setReady(false);
      }
    }, { rootMargin: "200px" });
    if (section.current) observer.observe(section.current);
    return () => { cancelled = true; observer.disconnect(); dispose?.(); };
  }, []);

  const highlight = (index: number) => { selected.current = index; setActive(index); };
  return <section ref={section} className={`fee-hero ${ready ? "scene-ready" : "scene-fallback"}`} id="top" aria-label="One trading fee, four destinations">
    <div ref={viewport} className="fee-viewport">
      <div className="fee-atmosphere" aria-hidden="true" />
      <div className="fee-intro">
        <span className="fee-kicker">SPLIT <i /> ROBINHOOD CHAIN</span>
        <h1>Give every fee<br /><span>a destination.</span></h1>
        <p>Launch tokens with programmable fee distribution<br className="fee-desktop-break" /> on Robinhood Chain.</p>
        <div className="fee-actions"><Link className="button button-primary" href="/launch/details">Launch a Token <Icon name="arrow" /></Link><Link className="button button-outline" href="/explore">Explore <span aria-hidden="true">↓</span></Link></div>
        <div className="fee-steps"><span><Icon name="layers" /><span><b>Create</b>Your token</span></span><span><Icon name="settings" /><span><b>Program</b>Fee distribution</span></span><span><Icon name="arrow" /><span><b>Launch</b>On Robinhood Chain</span></span></div>
      </div>
      <div className="fee-machine" aria-label="Interactive fee routing model">
        <div className="fee-static" aria-hidden="true">
          <svg viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid meet"><defs><linearGradient id="fee-glass"><stop stopColor="#d8b4ff" stopOpacity=".65"/><stop offset=".35" stopColor="#4a2378" stopOpacity=".15"/><stop offset="1" stopColor="#ad6cff" stopOpacity=".6"/></linearGradient><filter id="fee-glow"><feGaussianBlur stdDeviation="7"/></filter></defs><g fill="none" stroke="url(#fee-glass)" strokeWidth="24"><path d="M40 300C190 350 270 340 420 300"/>{[130,240,350,460].map((y) => <path key={y} d={`M560 300 C650 300 650 ${y} 780 ${y}`} />)}</g><g fill="none" stroke="#b076ff" strokeWidth="3"><path d="M40 300C190 350 270 340 420 300"/>{[130,240,350,460].map((y) => <path key={y} d={`M560 300 C650 300 650 ${y} 780 ${y}`} />)}</g><rect x="405" y="190" width="160" height="220" rx="28" fill="#130c23" stroke="url(#fee-glass)" strokeWidth="12"/><rect x="425" y="210" width="120" height="180" rx="18" fill="#100b1b" stroke="#a26af2"/>{[90,200,310,420].map((y) => <rect key={y} x="780" y={y} width="170" height="80" rx="14" fill="#120b21" stroke="url(#fee-glass)" strokeWidth="7"/>)}<circle cx="250" cy="326" r="30" fill="#aa57ff" filter="url(#fee-glow)"/><circle cx="250" cy="326" r="17" fill="#eedcff"/></svg>
        </div>
        <div ref={stage} className="fee-canvas" aria-hidden="true" />
        <div ref={coreLabel} className="fee-core-label" aria-hidden="true"><Image className="fee-core-logo" src="/split-logo-lockup.png" alt="" width={1240} height={1240} /><small>ROUTING CORE</small></div>
        <span ref={incomingLabel} className="fee-input-label">Trading fee</span>
        <div className="fee-destinations" aria-label="Inspect an allocation">
          {DEFAULT_SPLIT.map((item, index) => <button key={item.key} ref={(el) => { labels.current[index] = el; }} className={`fee-destination fee-destination-${index} ${active === index ? "is-inspected" : ""}`} aria-pressed={active === index} aria-label={`${item.label} allocation, ${item.value} percent`} onPointerEnter={(e) => { if (e.pointerType === "mouse") highlight(index); }} onPointerLeave={(e) => { if (e.pointerType === "mouse") highlight(-1); }} onFocus={() => highlight(index)} onBlur={() => highlight(-1)} onClick={() => highlight(selected.current === index ? -1 : index)} onKeyDown={(e) => { if (e.key === "Escape") { highlight(-1); e.currentTarget.blur(); } }}><Icon name={index === 0 ? "wallet" : index === 1 ? "layers" : index === 2 ? "chart" : "globe"} /><span><small>{item.label}</small><strong>{item.value}%</strong></span><span className="fee-allocation-note">{item.label} Allocation</span></button>)}
        </div>
      </div>
      <div className="fee-footer"><div className="fee-facts"><span><strong>One fee</strong>A single source</span><span><strong>Four routes</strong>Programmed at launch</span><span><strong>100%</strong>Allocated with purpose</span></div><a className="fee-scroll" href="#origin"><span className="fee-mouse"><i /></span>Scroll to route</a><div className="fee-journey-status"><span ref={phaseLabel}>01 / A fee enters</span><div><span ref={progressBar} /></div></div></div>
      <span className="sr-only">Scroll to move a fee into the processor and distribute it. Scroll back to reverse. Focus or tap a destination to highlight its route.</span>
    </div>
  </section>;
}
