import { notFound } from "next/navigation";
import { connection } from "next/server";
import { SolanaMarketChart } from "../../../components/solana/market-chart";
import { SolanaFeeLedger } from "../../../components/solana/fee-ledger";
import { getSolanaProject, getSolanaProjectFeed } from "../../../lib/solana/repository";
import { solanaCluster } from "../../../lib/solana/client";

function formatRaw(raw: string, decimals: number) {
  try {
    const value = BigInt(raw);
    const divisor = BigInt(10) ** BigInt(decimals);
    const whole = value / divisor;
    const fraction = (value % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
  } catch { return "—"; }
}

export default async function SolanaTokenPage({ params }: { params: Promise<{ mint: string }> }) {
  await connection();
  const { mint } = await params;
  let project: Awaited<ReturnType<typeof getSolanaProject>> = null;
  let feed: Awaited<ReturnType<typeof getSolanaProjectFeed>> = { samples: [], trades: [] };
  let unavailable = false;
  try {
    project = await getSolanaProject(mint);
    if (project) feed = await getSolanaProjectFeed(mint);
  } catch { unavailable = true; }
  if (!project && !unavailable) notFound();
  return <div className="section-shell solana-page solana-token-page"><span className="eyebrow">SPLIT Solana · {solanaCluster}</span>
    {unavailable || !project ? <><h1>Token feed unavailable.</h1><p>The project database must be active before token data can be displayed.</p></> : <>
      <h1>{project.name} <span className="solana-symbol">${project.symbol}</span></h1>
      {solanaCluster === "mainnet-beta" ? <p><a className="button button-primary"
        href={project.status === "graduated"
          ? `https://raydium.io/swap/?inputMint=sol&outputMint=${project.mint_address}`
          : `https://raydium.io/launchpad/token/?mint=${project.mint_address}`}
        target="_blank" rel="noopener noreferrer">Trade on Raydium</a></p> : null}
      <p>{project.status === "curve" ? "Bonding curve trading" : project.status === "bonded" ? "Bonded, awaiting pool migration" : "Graduated pool trading"} · Mint {project.mint_address}</p>
      <div className="solana-token-grid"><SolanaMarketChart mint={project.mint_address} samples={feed.samples} /><section className="glass-panel solana-market-panel">
        <span className="eyebrow">{project.fee_model === "router" ? "Router split" : "Operator-managed payout policy"}</span>
        <h2>SPLIT platform fees</h2>
        <p>10% protocol · creator {project.creator_bps * 0.9 / 100}% · liquidity reserve {project.liquidity_bps * 0.9 / 100}% · treasury {project.treasury_bps * 0.9 / 100}% · community {project.community_bps * 0.9 / 100}% of fees SPLIT collects.</p>
        {project.fee_model === "operator_managed" ? <small>Raydium accrues SPLIT&apos;s 1% platform fee on curve trades. SPLIT controls claimed fees and must sign payouts. This policy is not enforced by an onchain SPLIT program and does not continue automatically after graduation.</small> : <small>Router-backed development mode.</small>}
      </section></div>
      {project.fee_model === "operator_managed" ? <SolanaFeeLedger mint={project.mint_address} /> : null}
      <section className="glass-panel solana-market-panel"><h2>Indexed trades</h2>{feed.trades.length ? <div className="solana-trade-list">{feed.trades.map((trade) => <div key={`${trade.signature}-${trade.slot}`} className="solana-trade-row"><strong>{trade.side.toUpperCase()}</strong><span>{formatRaw(String(trade.base_amount_raw), project.decimals)} {project.symbol}</span><span>{formatRaw(String(trade.quote_amount_raw), 9)} SOL</span><small>{trade.traded_at.replace("T", " ").slice(0, 19)} UTC</small></div>)}</div> : <p>No finalized trades have been indexed for this token yet.</p>}</section>
    </>}
  </div>;
}
