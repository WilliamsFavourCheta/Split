import Link from "next/link";
import { solanaCluster } from "../lib/solana/client";

export default function SolanaHome() {
  return <div className="section-shell solana-page"><span className="eyebrow">SPLIT on Solana · {solanaCluster === "mainnet-beta" ? "Mainnet" : "Devnet development"}</span><h1>Launch with a split that stays onchain.</h1><p>Solana launches will use a bonding curve, then graduate to a trading pool. Creator, liquidity, project treasury, and community destinations are recorded before trading begins.</p><Link href="/solana/launch" className="button button-primary">Prepare a launch</Link></div>;
}
