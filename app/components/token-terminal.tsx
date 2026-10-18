"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { useReadContract } from "wagmi";
import { formatUnits, zeroAddress, type Address } from "viem";
import { splitFeeRouterAddresses } from "../contracts/addresses";
import { splitFeeRouterAbi } from "../contracts/abis";
import { explorerAddress, explorerTx, shortAddress, type Token } from "../data/mock";
import { formatEthAmount, formatTokenQuantity, isProtocolTreasury, matchingProjectRoles, projectCompletionPath } from "../lib/projects/token-display";
import { sqrtPriceX96ToEthPerToken } from "../lib/projects/price";
import type { PriceSnapshot } from "../lib/projects/price";
import { Icon } from "./icons";
import { LiveSwapFeed, type LiveSwap } from "./live-swap-feed";
import { TokenPriceChart } from "./token-price-chart";
import { useWallet } from "./providers";
import { AppShell, CopyButton, StatusBadge } from "./shell";
import { TradePanel } from "./trade-panel";

type FeeAsset = { currency: string; accrued: string; routed: string; protocol: string; creator: string; liquidity: string; treasury: string; community: string };
type AllocationEvent = { id: string; tx_hash: string; block_number: number; block_timestamp: string | null; currency: string; gross_amount_raw: string; protocol_allocation_raw: string; creator_allocation_raw: string; liquidity_allocation_raw: string; project_treasury_allocation_raw: string; community_allocation_raw: string };

function amount(raw: string, currency: string, token: Token) {
  const unit = currency.toLowerCase() === zeroAddress ? "ETH" : token.ticker;
  const value = Number(formatUnits(BigInt(raw), 18));
  const formatted = value === 0 ? "0" : value < 0.000001 ? value.toPrecision(4) : new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(value);
  return `${formatted} ${unit}`;
}

function Destination({ label, value, address }: { label: string; value: number; address?: string }) {
  return <div className="terminal-destination"><div><span>{label}</span><strong>{value}%</strong></div><div>{address ? <><code>{label === "Liquidity" ? "SplitVault" : shortAddress(address, 7, 5)}</code><CopyButton value={address} label={`Copy ${label} destination`} /></> : <span>Destination unavailable</span>}</div></div>;
}

function TokenClaims({ token }: { token: Token }) {
  const wallet = useWallet();
  const router = splitFeeRouterAddresses[4663];
  const pool = token.poolId as `0x${string}` | undefined;
  const walletAddress = wallet.status === "connected" ? wallet.address ?? undefined : undefined;
  const enabled = Boolean(router && pool && walletAddress);
  const split = useReadContract({ address: router, abi: splitFeeRouterAbi, functionName: "splits", args: [pool ?? `0x${"0".repeat(64)}`], chainId: 4663, query: { enabled } });
  const treasury = useReadContract({ address: router, abi: splitFeeRouterAbi, functionName: "protocolTreasury", chainId: 4663, query: { enabled } });
  const ethBalance = useReadContract({ address: router, abi: splitFeeRouterAbi, functionName: "claimable", args: [pool ?? `0x${"0".repeat(64)}`, walletAddress ?? zeroAddress, zeroAddress], chainId: 4663, query: { enabled, refetchInterval: 15_000 } });
  const tokenBalance = useReadContract({ address: router, abi: splitFeeRouterAbi, functionName: "claimable", args: [pool ?? `0x${"0".repeat(64)}`, walletAddress ?? zeroAddress, token.address as Address], chainId: 4663, query: { enabled, refetchInterval: 15_000 } });
  const protocolEth = useReadContract({ address: router, abi: splitFeeRouterAbi, functionName: "protocolClaimable", args: [pool ?? `0x${"0".repeat(64)}`, zeroAddress], chainId: 4663, query: { enabled, refetchInterval: 15_000 } });
  const protocolToken = useReadContract({ address: router, abi: splitFeeRouterAbi, functionName: "protocolClaimable", args: [pool ?? `0x${"0".repeat(64)}`, token.address as Address], chainId: 4663, query: { enabled, refetchInterval: 15_000 } });
  const launchFees = useReadContract({ address: router, abi: splitFeeRouterAbi, functionName: "protocolLaunchFeesAccrued", chainId: 4663, query: { enabled, refetchInterval: 15_000 } });
  if (!enabled || !split.data?.[7]) return null;
  const roles = matchingProjectRoles(walletAddress, [
    { label: "Creator", address: split.data[0] },
    { label: "Project Treasury", address: split.data[1] },
    { label: "Community", address: split.data[2] },
  ]);
  const isTreasury = isProtocolTreasury(walletAddress, treasury.data);
  if (!roles.length && !isTreasury) return null;
  return <section className="terminal-claims" aria-label="Claimable fees">
    {roles.length ? <div className="glass-panel terminal-claim-card"><span className="eyebrow">Your claimable fees</span><h2>Project revenue</h2><p>{roles.join(" + ")} {roles.length > 1 ? "share this wallet. The router combines their claimable amounts per asset." : "allocation for this wallet."}</p><div className="terminal-claim-values"><div><span>ETH</span><strong>{ethBalance.data === undefined ? "—" : amount(ethBalance.data.toString(), zeroAddress, token)}</strong></div><div><span>{token.ticker}</span><strong>{tokenBalance.data === undefined ? "—" : amount(tokenBalance.data.toString(), token.address, token)}</strong></div></div><Link className="button button-outline" href="/dashboard/fees">Claim available fees <Icon name="arrow" size={14} /></Link><small>Balances are read directly from SplitFeeRouter. Claim transactions are confirmed in the creator console.</small></div> : null}
    {isTreasury ? <div className="glass-panel terminal-claim-card"><span className="eyebrow">Authorized treasury only</span><h2>Protocol revenue</h2><div className="terminal-claim-values"><div><span>Swap fees · ETH</span><strong>{protocolEth.data === undefined ? "—" : amount(protocolEth.data.toString(), zeroAddress, token)}</strong></div><div><span>Swap fees · {token.ticker}</span><strong>{protocolToken.data === undefined ? "—" : amount(protocolToken.data.toString(), token.address, token)}</strong></div><div><span>Launch fees · ETH, all projects</span><strong>{launchFees.data === undefined ? "—" : amount(launchFees.data.toString(), zeroAddress, token)}</strong></div></div><Link className="button button-outline" href="/dashboard/fees">Manage protocol claims <Icon name="arrow" size={14} /></Link></div> : null}
  </section>;
}

export function TokenTerminal({ token, priceHistory, priceHistoryStatus, feeActivity, allocationEvents }: {
  token: Token;
  priceHistory: PriceSnapshot[];
  priceHistoryStatus: "ready" | "unconfigured" | "migration-required";
  feeActivity: { trades: number; assets: FeeAsset[] };
  allocationEvents: AllocationEvent[];
}) {
  const wallet = useWallet();
  const [tradeOpen, setTradeOpen] = useState(false);
  const [visibleRows, setVisibleRows] = useState(10);
  const [livePriceSnapshots, setLivePriceSnapshots] = useState<PriceSnapshot[]>([]);
  const onLiveSwaps = useCallback((swaps: LiveSwap[]) => {
    setLivePriceSnapshots(swaps.flatMap((swap) => {
      if (!swap.timestamp) return [];
      const priceEth = sqrtPriceX96ToEthPerToken(swap.sqrtPriceX96);
      return priceEth === null ? [] : [{ priceEth, snapshotAt: swap.timestamp, eventId: `${swap.txHash}:${swap.logIndex}`, blockNumber: swap.blockNumber, logIndex: swap.logIndex }];
    }));
  }, []);
  const chartSnapshots = useMemo(() => {
    const byEvent = new Map<string, PriceSnapshot>();
    for (const snapshot of [...priceHistory, ...livePriceSnapshots]) {
      byEvent.set(snapshot.eventId ?? `${snapshot.snapshotAt}:${snapshot.priceEth}`, snapshot);
    }
    return [...byEvent.values()].sort((a, b) => Date.parse(a.snapshotAt) - Date.parse(b.snapshotAt) || (a.blockNumber ?? 0) - (b.blockNumber ?? 0) || (a.logIndex ?? 0) - (b.logIndex ?? 0));
  }, [priceHistory, livePriceSnapshots]);
  const isCreator = wallet.status === "connected" && wallet.address?.toLowerCase() === token.owner.toLowerCase();
  const profileMissing = !token.metadataSaved;
  const completionPath = projectCompletionPath(token.owner, isCreator ? wallet.address ?? undefined : undefined, Boolean(token.metadataSaved), token.launchTx);
  const links = ([
    ["Website", token.website], ["X", token.twitter], ["Telegram", token.telegram], ["Discord", token.discord],
  ] as const).filter(([, url]) => /^https:\/\//i.test(url));
  return <AppShell><div className="section-shell page-body terminal-page">
    <Link className="terminal-back" href="/explore"><Icon name="back" size={15} /> Explore tokens</Link>
    <header className="terminal-hero glass-panel"><div className="terminal-brand"><div className="terminal-avatar" style={{ "--token-color": token.color } as React.CSSProperties}>{token.ticker.slice(0, 2)}{token.logoUrl ? <Image src={token.logoUrl} alt={`${token.name} logo`} width={88} height={88} unoptimized onError={(event) => { event.currentTarget.style.display = "none"; }} /> : null}</div><div className="terminal-identity"><div className="terminal-identity-top"><span className="eyebrow">Robinhood Chain · official SPLIT pool</span><StatusBadge status={token.status} /></div><h1>{token.name}</h1><strong>${token.ticker}</strong><div className="terminal-ids"><span>Contract <code>{shortAddress(token.address, 8, 6)}</code><CopyButton value={token.address} label="Copy token contract" /></span><span>Creator <code>{shortAddress(token.owner, 8, 6)}</code><CopyButton value={token.owner} label="Copy creator address" /></span></div></div></div><div className="terminal-hero-actions"><button className="button button-primary" onClick={() => setTradeOpen(true)}>Trade <Icon name="arrow" size={16} /></button><a className="button button-outline" href={explorerAddress(token.address)} target="_blank" rel="noreferrer">View contract <Icon name="external" size={15} /></a>{isCreator ? <Link className="button button-quiet" href={`/manage/${token.address}`}>Manage project</Link> : null}</div></header>
    {isCreator && profileMissing ? <aside className="terminal-profile-warning"><Icon name="wallet" size={17} /><span><strong>Project profile incomplete.</strong> Finish the confirmed launch to publish its logo and description.</span>{completionPath ? <Link href={completionPath}>Complete launch <Icon name="arrow" size={13} /></Link> : null}</aside> : null}
    <dl className="terminal-stats"><div className="glass-panel"><dt>Price</dt><dd>{token.price === "-" ? "—" : token.price}</dd><small>ETH per token</small></div><div className="glass-panel"><dt>Fully diluted valuation</dt><dd>{token.marketCap === "-" ? "—" : token.marketCap}</dd><small>Fixed supply × indexed price</small></div><div className="glass-panel"><dt>24h volume</dt><dd>{token.volume === "-" ? "—" : token.volume}</dd><small>{token.volume === "-" ? "USD volume not indexed" : "Indexed USD metric"}</small></div><div className="glass-panel"><dt>Liquidity</dt><dd>{token.liquidity === "-" ? "—" : token.liquidity}</dd><small>{token.liquidity === "-" ? "USD estimate unavailable · seed is locked" : "Indexed USD metric"}</small></div><div className="glass-panel"><dt>Holders</dt><dd>{token.holders === "-" ? "—" : token.holders}</dd><small>{token.holders === "-" ? "Holder count not indexed" : "Indexed holders"}</small></div></dl>
    <div className="terminal-market-grid"><div className="terminal-chart"><div className="terminal-section-title"><span className="eyebrow">Market performance</span><h2>Price and market cap</h2></div><TokenPriceChart ticker={token.ticker} snapshots={chartSnapshots} status={priceHistoryStatus} /></div><div className="terminal-side"><section className="glass-panel terminal-launch"><span className="eyebrow">Verified launch</span><h2>Locked at launch</h2><dl><div><dt>Total supply</dt><dd title={token.totalSupply}>{formatTokenQuantity(token.totalSupply, token.ticker)}</dd></div><div><dt>Initial ETH seed</dt><dd>{formatEthAmount(token.initialSeedEth)}</dd></div><div><dt>Initial token seed</dt><dd title={token.initialSeedTokens}>{formatTokenQuantity(token.initialSeedTokens, token.ticker)}</dd></div><div><dt>Creator</dt><dd><code>{shortAddress(token.owner, 8, 6)}</code><CopyButton value={token.owner} label="Copy creator address" /></dd></div><div><dt>Official pool ID</dt><dd>{token.poolId ? <><code>{shortAddress(token.poolId, 8, 6)}</code><CopyButton value={token.poolId} label="Copy official pool ID" /></> : "—"}</dd></div><div><dt>Launch block</dt><dd>{token.launchBlock?.toLocaleString("en-US") ?? "—"}</dd></div><div><dt>Liquidity status</dt><dd><span className="terminal-locked"><Icon name="lock" size={13} /> Locked in SplitVault</span></dd></div><div><dt>SPLIT trading fee</dt><dd>1%</dd></div></dl>{token.launchTx ? <a href={explorerTx(token.launchTx)} target="_blank" rel="noreferrer">View launch transaction <Icon name="external" size={13} /></a> : null}</section><section className="glass-panel terminal-about"><span className="eyebrow">About</span><h2>Project profile</h2><p>{token.description || "Project profile has not been completed yet."}</p>{links.length ? <div className="terminal-about-links">{links.map(([label, url]) => <a key={label} href={url} target="_blank" rel="noreferrer">{label} <Icon name="external" size={13} /></a>)}</div> : null}{completionPath ? <Link href={completionPath}>Complete project profile <Icon name="arrow" size={13} /></Link> : null}</section></div></div>
    <section className="terminal-fees"><div className="terminal-section-title"><span className="eyebrow">Immutable fee routing</span><h2>Where the fees go</h2><p>Every trade pays a 1% SPLIT fee. The protocol receives 10%; the remaining 90% follows this project&apos;s immutable allocation.</p></div><div className="terminal-fee-grid"><div className="glass-panel terminal-routing"><div className="terminal-fee-source"><span>Official pool trade</span><strong>1% SPLIT fee</strong></div><div className="terminal-fee-branches"><div><span>Protocol Treasury</span><strong>10%</strong><small>of the collected SPLIT fee</small></div><div><span>Project portion</span><strong>90%</strong><small>of the collected SPLIT fee</small></div></div><div className="terminal-project-split"><span className="eyebrow">Of the 90% project portion</span>{token.split.map((part) => <div key={part.key}><span><i style={{ background: part.color }} />{part.label}</span><strong>{part.value}%</strong><small>{(part.value * 0.9).toLocaleString("en-US", { maximumFractionDigits: 2 })}% of collected fee</small></div>)}</div><p>Liquidity allocations remain reserved in SplitVault; they are not creator income.</p></div><div className="glass-panel terminal-activity"><span className="eyebrow">Fee activity</span><h3>{feeActivity.trades} indexed {feeActivity.trades === 1 ? "trade" : "trades"}</h3>{feeActivity.assets.length ? feeActivity.assets.map((asset) => <div className="terminal-activity-asset" key={asset.currency}><strong>{asset.currency.toLowerCase() === zeroAddress ? "ETH" : token.ticker}</strong><dl><div><dt>Total SPLIT fees accrued</dt><dd>{amount(asset.accrued, asset.currency, token)}</dd></div><div><dt>Fees routed</dt><dd>{amount(asset.routed, asset.currency, token)}</dd></div><div><dt>Protocol allocated</dt><dd>{amount(asset.protocol, asset.currency, token)}</dd></div><div><dt>Creator earned</dt><dd>{amount(asset.creator, asset.currency, token)}</dd></div><div><dt>Liquidity allocated</dt><dd>{amount(asset.liquidity, asset.currency, token)}</dd></div><div><dt>Project Treasury earned</dt><dd>{amount(asset.treasury, asset.currency, token)}</dd></div><div><dt>Community earned</dt><dd>{amount(asset.community, asset.currency, token)}</dd></div></dl></div>) : <p>No trading fees have accrued yet.</p>}<small>Canonical indexed events only. Fees accrue in the Hook before a separate routing transaction allocates them. Assets are shown separately.</small></div></div></section>
    <section className="terminal-destinations"><div className="terminal-section-title"><span className="eyebrow">Onchain destinations</span><h2>Project allocation</h2><p>Percentages below apply to the project portion of the collected fee.</p></div><div className="terminal-destination-grid">{token.split.map((part) => <Destination key={part.key} label={part.label} value={part.value} address={part.address} />)}</div></section>
    <TokenClaims token={token} />
    <LiveSwapFeed address={token.address} ticker={token.ticker} onSwaps={onLiveSwaps} />
    <section className="terminal-history"><div className="terminal-section-title"><span className="eyebrow">Canonical fee events</span><h2>Recent allocations</h2></div>{allocationEvents.length ? <><div className="terminal-table-wrap glass-panel"><table><thead><tr><th>Time</th><th>Event</th><th>Asset</th><th>Fee routed</th><th>Protocol</th><th>Creator</th><th>Liquidity</th><th>Treasury</th><th>Community</th><th>Tx</th></tr></thead><tbody>{allocationEvents.slice(0, visibleRows).map((row) => <tr key={row.id}><td>{row.block_timestamp ? new Date(row.block_timestamp).toLocaleString() : `Block ${row.block_number.toLocaleString()}`}</td><td>Allocation</td><td>{row.currency.toLowerCase() === zeroAddress ? "ETH" : token.ticker}</td><td>{amount(row.gross_amount_raw, row.currency, token)}</td><td>{amount(row.protocol_allocation_raw, row.currency, token)}</td><td>{amount(row.creator_allocation_raw, row.currency, token)}</td><td>{amount(row.liquidity_allocation_raw, row.currency, token)}</td><td>{amount(row.project_treasury_allocation_raw, row.currency, token)}</td><td>{amount(row.community_allocation_raw, row.currency, token)}</td><td><a href={explorerTx(row.tx_hash)} target="_blank" rel="noreferrer">View <Icon name="external" size={12} /></a></td></tr>)}</tbody></table></div>{visibleRows < allocationEvents.length ? <button className="button button-outline terminal-load-more" onClick={() => setVisibleRows((current) => current + 10)}>Load more</button> : null}<p className="terminal-table-note">One allocation can route fees accrued by several trades. Activity is capped to the 50 latest allocation events.</p></> : <div className="glass-panel terminal-empty"><Icon name="chart" size={25} /><strong>No fee activity yet</strong><p>Fee allocations will appear here after official pool trades are indexed and accrued fees are routed.</p></div>}</section>
    {tradeOpen ? <div className="modal-backdrop" role="presentation" onMouseDown={() => setTradeOpen(false)}><div className="modal glass-panel" role="dialog" aria-modal="true" aria-label={`Trade ${token.ticker}`} onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setTradeOpen(false)} aria-label="Close trading"><Icon name="close" /></button><span className="eyebrow">Official SPLIT pool</span><h2>Trade ${token.ticker}</h2><TradePanel token={token} /></div></div> : null}
  </div></AppShell>;
}
