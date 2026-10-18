import Link from "next/link";
import type { Metadata } from "next";
import { SolanaWalletControl } from "../components/solana/wallet-control";
import { SplitSolanaProvider } from "../components/solana/providers";
import { solanaCluster } from "../lib/solana/client";

export const metadata: Metadata = {
  title: "Solana launchpad preview",
  description: "Preview SPLIT's Solana launch flow and immutable four-way platform fee split.",
};

export default function SolanaLayout({ children }: { children: React.ReactNode }) {
  return <SplitSolanaProvider><div className="solana-shell"><header className="solana-header section-shell"><Link className="solana-brand" href="/solana">SPLIT <span>Solana</span></Link><nav aria-label="Solana navigation"><Link href="/solana">Overview</Link><Link href="/solana/explore">Explore</Link><Link href="/solana/launch">Launch</Link></nav><SolanaWalletControl /></header><main>{children}</main><footer className="section-shell solana-footer">Solana {solanaCluster === "mainnet-beta" ? "Mainnet" : "Devnet"} · SPLIT four-way fee routing</footer></div></SplitSolanaProvider>;
}
