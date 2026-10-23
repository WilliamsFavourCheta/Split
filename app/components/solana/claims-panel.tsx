import Link from "next/link";

export function SolanaClaimsPanel() {
  return <div className="section-shell solana-page">
    <span className="eyebrow">Solana fee transparency</span>
    <h1>Fee receipts and payments</h1>
    <p>Raydium accrues SPLIT&apos;s 1% platform fee while a token trades on its LaunchLab curve. The SPLIT fee wallet must sign each pool-specific claim. SPLIT then controls those funds until it signs outgoing payments.</p>
    <p>The 10% protocol / 36% creator / 27% liquidity reserve / 18% treasury / 9% community default is an operator-managed policy applied to fees SPLIT actually collects. It is not enforced by a SPLIT program, and recipients have no direct wallet claim in this version.</p>
    <p>Open a token&apos;s detail page to see verified pool receipts, calculations, confirmed payouts, and outstanding amounts. If there is no verified pool receipt, no project allocation is shown.</p>
    <Link href="/solana/explore" className="button button-primary">Explore tokens</Link>
    <p><Link href="/solana/admin/fees">SPLIT operator fee console</Link></p>
  </div>;
}
