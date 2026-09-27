"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { AppShell } from "./shell";
import { Reveal } from "./visuals";

const steps = [
  { number: "01", title: "Create", copy: "Launch your token with a name, ticker, supply, and a clear market identity." },
  { number: "02", title: "Program", copy: "Define exactly where fee revenue flows — by percentage and by destination." },
  { number: "03", title: "Launch", copy: "Review the configuration and deploy through the verified contract adapter." },
  { number: "04", title: "Route", copy: "Fees from swaps through the official registered SPLIT pool follow the fixed protocol share and immutable project allocation." },
];

export function HowItWorksPage() {
  return <AppShell><div className="how-page">
    <section className="how-hero section-shell"><Reveal><span className="eyebrow">The SPLIT protocol</span><h1>How Split<br /><span>works.</span></h1><p>The 1% SPLIT fee applies only to swaps through the official pool created and registered for a SPLIT launch. Other pools and venues do not pay this hook fee.</p><div><Link className="button button-primary" href="/launch/details">Launch a token <Icon name="arrow" /></Link><Link className="button button-outline" href="/explore">Explore launches</Link></div></Reveal><Reveal delay={120} className="how-hero-visual"><HowFlow /></Reveal></section>
    <section className="how-story"><div className="section-shell"><div className="how-story-head"><span className="eyebrow">Create → Program → Launch → Route</span><h2>A launch is a system,<br />not a moment.</h2></div><StepNarrative /></div></section>
    <section className="how-proof section-shell"><Reveal className="how-proof-title"><span className="eyebrow">Protocol principles</span><h2>Designed to be read.</h2><p>The interface keeps configuration, routing, and transaction history understandable at every stage.</p></Reveal><div className="proof-grid"><Reveal className="proof-card"><span>01</span><h3>Onchain.</h3><p>Routing events resolve to verifiable Robinhood Chain transactions.</p></Reveal><Reveal delay={80} className="proof-card"><span>02</span><h3>Visible.</h3><p>Anyone can inspect a project’s allocation before interacting with it.</p></Reveal><Reveal delay={160} className="proof-card"><span>03</span><h3>Verifiable.</h3><p>Immutable configurations are clearly separated from editable project metadata.</p></Reveal></div><a className="proof-link" href="https://docs.robinhood.com/chain/" target="_blank" rel="noreferrer">View Robinhood Chain documentation <Icon name="external" /></a></section>
    <section className="how-cta"><Reveal><HowFlow compact /><h2>Give every fee<br /><span>a destination.</span></h2><div><Link className="button button-primary" href="/launch/details">Launch a token <Icon name="arrow" /></Link><Link className="button button-outline" href="/explore">Explore</Link></div></Reveal></section>
  </div></AppShell>;
}

function StepNarrative() {
  const stepNodes = useRef<(HTMLElement | null)[]>([]);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting);
      if (!visible.length) return;
      const closest = visible.reduce((a, b) => Math.abs(a.boundingClientRect.top - innerHeight * .38) < Math.abs(b.boundingClientRect.top - innerHeight * .38) ? a : b);
      const index = Number((closest.target as HTMLElement).dataset.stepIndex);
      if (Number.isFinite(index)) setActive(index);
    }, { rootMargin: "-28% 0px -48% 0px", threshold: [0, .2, .55] });
    stepNodes.current.forEach((node) => node && observer.observe(node));
    return () => observer.disconnect();
  }, []);
  return <div className="how-step-list" aria-label="Scroll through the SPLIT launch process">
    <p className="how-step-status" aria-live="polite">Step {active + 1} of {steps.length} · {steps[active].title}</p>
    {steps.map((step, index) => <article ref={(node) => { stepNodes.current[index] = node; }} data-step-index={index} className={`how-step ${active === index ? "is-active" : ""}`} key={step.number} aria-current={active === index ? "step" : undefined}>
      <div className="how-step-number">{step.number}<span /></div>
      <div><span className="eyebrow">Phase {step.number}</span><h3>{step.title}</h3><p>{step.copy}</p>{index === 0 ? <Link href="/launch/details">Start with token details <Icon name="arrow" /></Link> : index === 3 ? <Link href="/token/0x1a2b6D3414Cfa18E7B2C82D085D72445B02B89ef">See a live routing model <Icon name="arrow" /></Link> : null}</div>
      <div className={`step-visual step-visual-${index + 1}`} aria-hidden="true"><i /><i /><i /><span className="step-energy" /></div>
    </article>)}
  </div>;
}

function HowFlow({ compact = false }: { compact?: boolean }) {
  return <div className={`how-flow ${compact ? "how-flow-compact" : ""}`} aria-label="Official registered SPLIT pool swap fee flows into SPLIT core and routes to four destinations"><div className="how-flow-source"><span>Official SPLIT pool swap</span><i /><span>1% fee</span><i /></div><div className="how-flow-core">Split core</div><div className="how-flow-branches">{["Creator", "Liquidity", "Project Treasury", "Community"].map((label, index) => <span className={`branch-${index + 1}`} key={label}><i /><b>{label}</b></span>)}</div></div>;
}
