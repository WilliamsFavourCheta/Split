import Link from "next/link";
import type { Metadata } from "next";
import { SolanaWalletControl } from "../components/solana/wallet-control";
import { SplitSolanaProvider } from "../components/solana/providers";

export const metadata: Metadata = {
  title: "SPLIT V2 is coming to Solana",
  description: "SPLIT V1 is live on Robinhood Chain. Solana launches are coming in V2.",
};

export default function SolanaLayout({ children }: { children: React.ReactNode }) {
  return <SplitSolanaProvider><div className="solana-shell">
    <header className="solana-header section-shell">
      <Link className="solana-brand" href="/solana">SPLIT <span>Solana</span></Link>
      <nav aria-label="Solana navigation">
        <Link href="/solana">Overview</Link>
        <Link href="/solana/explore">Explore</Link>
        <Link href="/solana/launch">Launch</Link>
        <Link href="/solana/dashboard">Dashboard</Link>
        <Link href="/solana/claims">Fee ledger</Link>
      </nav>
      <SolanaWalletControl />
    </header>
    <main>{children}</main>
    <footer className="section-shell solana-footer">SPLIT V1 live on Robinhood Chain · Solana launches coming in V2</footer>
  </div></SplitSolanaProvider>;
}
