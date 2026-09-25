"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { useWallet } from "./providers";
import { shortenAddress } from "../web3/format";

export function WalletControl({ className = "button button-outline header-wallet" }: { className?: string }) {
  const wallet = useWallet();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  if (wallet.status === "connected") {
    return (
      <div className="wallet-menu-wrap" ref={menuRef}>
        <button className="wallet-pill" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-controls="wallet-account-menu">
          <span className="wallet-avatar"><Icon name="wallet" size={14} /></span>
          {shortenAddress(wallet.address)}
          <span className="wallet-caret" aria-hidden="true">⌄</span>
        </button>
        {menuOpen ? (
          <div className="wallet-dropdown glass-panel" id="wallet-account-menu">
            <span className="eyebrow">Connected wallet</span>
            <strong>{shortenAddress(wallet.address, 8, 6)}</strong>
            <span className="wallet-network-label"><i className="status-dot" />{wallet.chainName}</span>
            <Link href="/settings" onClick={() => setMenuOpen(false)}><Icon name="settings" size={15} />Wallet settings</Link>
            <button className="danger-text" onClick={() => { setMenuOpen(false); void wallet.disconnect(); }}>Disconnect from SPLIT</button>
          </div>
        ) : null}
      </div>
    );
  }

  const pending = wallet.status === "connecting" || wallet.status === "restoring" || wallet.status === "switching" || wallet.status === "disconnecting";
  if (wallet.status === "wrong-network") {
    const buttonClass = className.includes("header-wallet") ? "button button-warning header-wallet" : "button button-warning mobile-wallet-control";
    const disconnectClass = className.includes("header-wallet") ? "button button-outline header-wallet" : "button button-outline mobile-wallet-control";
    return <div className="wallet-wrong-controls"><span className="wallet-pill wallet-pill-wrong"><span className="wallet-avatar"><Icon name="wallet" size={14} /></span>{shortenAddress(wallet.address)}</span><button className={buttonClass} disabled={pending} onClick={() => void wallet.switchNetwork()}>Switch Network</button><button className={disconnectClass} disabled={pending} onClick={() => void wallet.disconnect()}>Disconnect</button></div>;
  }

  if (wallet.status === "restoring") return <button className={className} disabled><span className="spinner" />Restoring Wallet</button>;
  if (wallet.status === "connecting") return <button className={className} disabled><span className="spinner" />Connecting</button>;
  if (wallet.status === "switching") return <button className={className} disabled><span className="spinner" />Switching Network</button>;
  if (wallet.status === "disconnecting") return <button className={className} disabled><span className="spinner" />Disconnecting</button>;

  return (
    <button className={className} onClick={() => void wallet.openWallet()} title={wallet.status === "unavailable" ? wallet.error ?? "Install an EVM-compatible wallet" : undefined}>
      {wallet.status === "unavailable" ? "No Wallet Found" : "Connect Wallet"}
    </button>
  );
}
