"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Icon } from "./icons";
import { useToast, useWallet } from "./providers";
import { WalletControl } from "./wallet-control";
import { shortenAddress } from "../web3/format";

const NAV_ITEMS = [
  { href: "/", label: "Home" },
  { href: "/explore", label: "Explore" },
  { href: "/launch/details", label: "Launch" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/how-it-works", label: "How It Works" },
];

function routeActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname.startsWith(href.split("/").slice(0, 2).join("/"));
}

export function SplitLogo({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`brand-lockup ${compact ? "brand-compact" : ""}`}>
      <span className="brand-mark" aria-hidden="true"><Image className="brand-mark-art" src="/split-logo-lockup.png" alt="" width={1240} height={1240} priority /></span>
      {!compact ? <span className="brand-word">SPLIT</span> : null}
    </span>
  );
}

export function WalletActionButton({ className = "button button-primary", connectLabel = "Connect Wallet" }: { className?: string; connectLabel?: string }) {
  const wallet = useWallet();
  if (wallet.status === "connected") return null;
  if (wallet.status === "wrong-network") return <button className="button button-warning" onClick={() => void wallet.switchNetwork()}>Switch Network</button>;
  if (wallet.status === "connecting" || wallet.status === "restoring" || wallet.status === "switching" || wallet.status === "disconnecting") return <button className={className} disabled><span className="spinner" />{wallet.status === "restoring" ? "Restoring Wallet" : wallet.status === "switching" ? "Switching Network" : wallet.status === "disconnecting" ? "Disconnecting" : "Connecting"}</button>;
  return <button className={className} onClick={() => void wallet.openWallet()}>{wallet.status === "unavailable" ? "No Wallet Found" : connectLabel}</button>;
}

export function AppHeader() {
  const pathname = usePathname();
  const wallet = useWallet();
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const menuOpen = menuPath === pathname;

  return (
    <>
      <header className="app-header">
        <div className="header-inner">
          <Link href="/" className="brand-link" aria-label="SPLIT home"><SplitLogo compact /></Link>
          <nav className="desktop-nav" aria-label="Main navigation">
            {NAV_ITEMS.map((item) => (
              <Link className={routeActive(pathname, item.href) ? "active" : ""} href={item.href} key={item.href}>{item.label}</Link>
            ))}
          </nav>
          <div className="header-actions">
            <span className={`network-pill ${wallet.status === "wrong-network" ? "network-pill-wrong" : wallet.status === "connected" ? "network-pill-connected" : "network-pill-idle"}`} aria-live="polite"><span className="status-dot" />{wallet.status === "wrong-network" ? `Wrong / ${wallet.chainName}` : wallet.status === "connected" ? wallet.chainName : `Target / ${wallet.targetChainName}`}</span>
            <WalletControl />
            <button className="mobile-menu-button" onClick={() => setMenuPath(menuOpen ? null : pathname)} aria-label="Toggle navigation" aria-expanded={menuOpen}>
              <Icon name={menuOpen ? "close" : "menu"} />
            </button>
          </div>
        </div>
        {menuOpen ? (
          <nav className="mobile-nav" aria-label="Mobile navigation">
            {NAV_ITEMS.map((item) => <Link className={routeActive(pathname, item.href) ? "active" : ""} href={item.href} key={item.href}>{item.label}<Icon name="arrow" /></Link>)}
            <span className={`network-pill ${wallet.status === "wrong-network" ? "network-pill-wrong" : wallet.status === "connected" ? "network-pill-connected" : "network-pill-idle"}`} aria-live="polite"><span className="status-dot" />{wallet.status === "wrong-network" ? `Wrong / ${wallet.chainName}` : wallet.status === "connected" ? wallet.chainName : `Target / ${wallet.targetChainName}`}</span>
            {wallet.status === "connected" ? <div className="mobile-wallet-state"><span>{shortenAddress(wallet.address)} · {wallet.chainName}</span><button className="text-button" onClick={() => void wallet.disconnect()}>Disconnect</button></div> : <WalletControl className="button button-outline mobile-wallet-control" />}
          </nav>
        ) : null}
      </header>
    </>
  );
}

export function AppShell({ children, footer = true }: { children: React.ReactNode; footer?: boolean }) {
  return (
    <div className="app-shell">
      <AppHeader />
      <main>{children}</main>
      {footer ? <AppFooter /> : null}
    </div>
  );
}

export function AppFooter() {
  return (
    <footer className="app-footer section-shell">
      <div><SplitLogo /><span className="footer-note">Built on Robinhood Chain.</span></div>
      <nav aria-label="Footer navigation">
        <Link href="/how-it-works">Protocol</Link>
        <Link href="/settings">Settings</Link>
        <a href="https://docs.robinhood.com/chain/" target="_blank" rel="noreferrer">Chain docs <Icon name="external" size={12} /></a>
      </nav>
      <div className="footer-socials">
        <a href="https://x.com" target="_blank" rel="noreferrer" aria-label="SPLIT on X"><Icon name="twitter" size={14} /></a>
        <a href="https://t.me" target="_blank" rel="noreferrer" aria-label="SPLIT on Telegram"><Icon name="telegram" size={14} /></a>
        <a href="https://discord.com" target="_blank" rel="noreferrer" aria-label="SPLIT on Discord"><Icon name="discord" size={14} /></a>
      </div>
    </footer>
  );
}

export function PageIntro({ eyebrow, title, description, aside }: { eyebrow: string; title: React.ReactNode; description?: string; aside?: React.ReactNode }) {
  return (
    <div className="page-intro">
      <div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1></div>
      {aside ?? (description ? <p>{description}</p> : null)}
    </div>
  );
}

export function StatusBadge({ status }: { status: "live" | "graduated" | "upcoming" | "failed" }) {
  return <span className={`status-badge status-${status}`}><span className="status-dot" />{status}</span>;
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const { showToast } = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      showToast("Copied to clipboard", "success");
    } catch {
      showToast("Clipboard permission was blocked", "error");
    }
  };
  return <button className="icon-button" onClick={copy} aria-label={label} title={label}><Icon name="copy" size={15} /></button>;
}

