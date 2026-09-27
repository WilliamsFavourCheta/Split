"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatUnits, type Address } from "viem";
import { useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { EXPLORER_URL, explorerTx, ROUTING_HISTORY, shortAddress, TOKENS, type Token } from "../data/mock";
import { Icon } from "./icons";
import { useToast, useWallet } from "./providers";
import { AppShell, CopyButton, StatusBadge, WalletActionButton } from "./shell";
import { FeeBars, FlowDiagram, PriceChart } from "./visuals";
import { Erc20BalanceLookup } from "./erc20-balance-lookup";
import { targetChainId } from "../web3/chains";
import { splitFeeRouterAbi } from "../contracts/abis";
import { splitFeeRouterAddresses } from "../contracts/addresses";

type DashboardTab = "overview" | "launches" | "fees";
type BalanceGroup = { currency: string; rawAmount: string; count: number; destinationType?: "creator" | "liquidity" | "project_treasury" | "protocol_treasury" | "community" };
type ClaimTarget = { poolId: `0x${string}`; tokenAddress: Address; name: string; symbol: string };
type DashboardData = { projects: Token[]; claimTargets: ClaimTarget[]; accrued: BalanceGroup[]; unrouted: BalanceGroup[] | null; allocated: BalanceGroup[]; claimed: BalanceGroup[]; liquidityReserved: Array<{ currency: string; rawAmount: string }> | null; protocolLaunchFeeClaims: Array<{ id: string; txHash: string; blockNumber: number; rawAmount: string }>; indexed: boolean };

function useDashboardData(address: string | null | undefined) {
  const [result, setResult] = useState<{ address: string | null; data: DashboardData | null }>({ address: null, data: null });
  useEffect(() => {
    if (address == null) return;
    let active = true;
    fetch(`/api/dashboard?wallet=${encodeURIComponent(address)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load account data.");
        return response.json() as Promise<DashboardData>;
      })
      .then((data) => { if (active) setResult({ address, data }); })
      .catch(() => { if (active) setResult({ address, data: null }); });
    return () => { active = false; };
  }, [address]);
  return address != null && result.address === address ? result.data : null;
}

function currencyLabel(currency: string, projects: Token[]) {
  if (currency.toLowerCase() === "0x0000000000000000000000000000000000000000") return "ETH";
  return projects.find((project) => project.address.toLowerCase() === currency.toLowerCase())?.ticker ?? shortAddress(currency);
}

function groupedAmounts(groups: BalanceGroup[], projects: Token[], destinationType?: BalanceGroup["destinationType"]) {
  const relevant = destinationType ? groups.filter((group) => group.destinationType === destinationType) : groups;
  if (!relevant.length) return "0";
  return relevant.map((group) => `${formatUnits(BigInt(group.rawAmount), 18)} ${currencyLabel(group.currency, projects)}`).join(" Â· ");
}

const dashboardTabs = [
  { key: "overview", label: "Overview", href: "/dashboard" },
  { key: "launches", label: "My Launches", href: "/dashboard/launches" },
  { key: "fees", label: "Fee Analytics", href: "/dashboard/fees" },
] as const;

function DashboardHead({ active }: { active: DashboardTab }) {
  const wallet = useWallet();
  return <><div className="dashboard-head"><div><span className="eyebrow">Creator console / 01</span><h1>Dashboard</h1><p>Connected wallet <strong>{wallet.address ? shortAddress(wallet.address) : "Not connected"}</strong></p></div><span className="network-pill"><span className="status-dot" />Network / {wallet.targetChainName}</span></div><nav className="dashboard-tabs">{dashboardTabs.map((tab) => <Link className={active === tab.key ? "active" : ""} href={tab.href} key={tab.key}>{tab.label}</Link>)}</nav></>;
}

function ConnectDashboard() {
  const wallet = useWallet();
  return <div className="connect-gate glass-panel"><span className="wallet-option-icon"><Icon name="wallet" /></span><span className="eyebrow">Creator console</span><h1>{wallet.status === "wrong-network" ? `Switch to ${wallet.targetChainName}` : "Connect to your dashboard"}</h1><p>Your launches and fee analytics are scoped to the connected wallet.</p><WalletActionButton /></div>;
}

function DashboardFrame({ active, children }: { active: DashboardTab; children: React.ReactNode }) {
  const wallet = useWallet();
  return <AppShell><div className="section-shell page-body dashboard-page">{wallet.status !== "connected" ? <ConnectDashboard /> : <><DashboardHead active={active} />{children}</>}</div></AppShell>;
}

export function DashboardOverview() { return <RealDashboardOverview />; }
export function DashboardLaunches() { return <RealDashboardLaunches />; }
export function DashboardFees() { return <RealDashboardFees />; }

export function LegacyDashboardOverview() {
  return <RealDashboardOverview />;
}

function StatCard({ label, value, icon, action }: { label: string; value: string; icon: "layers" | "chart" | "wallet" | "bars"; action?: React.ReactNode }) {
  return <div className="stat-card glass-panel"><div><span>{label}</span><Icon name={icon} /></div><strong>{value}</strong>{action}</div>;
}

function LaunchTable({ tokens }: { tokens: Token[] }) {
  return <div className="launch-table glass-panel"><div className="launch-table-head"><span>Token</span><span>Status</span><span>Market cap</span><span>Volume</span><span>Fees generated</span><span>Your allocation</span><span>Actions</span></div>{tokens.map((token, index) => <div className="launch-table-row" key={token.address}><div className="table-token"><span className="token-glyph" style={{ "--token-color": token.color } as React.CSSProperties}>{token.ticker[0]}</span><span><strong>{token.name}</strong><small>${token.ticker}</small></span></div><StatusBadge status={token.status} /><span data-label="Market cap">{token.marketCap}</span><span data-label="Volume">{token.volume}</span><span data-label="Fees generated">{index === 0 ? "$840" : index === 1 ? "$320" : "â€”"}</span><span className="allocation-label" data-label="Your allocation">40% creator</span><div className="table-actions"><Link href={`/manage/${token.address}`}>Manage</Link><Link href={`/token/${token.address}`}>View</Link></div></div>)}</div>;
}

export function LegacyDashboardLaunches() {
  return <DashboardFrame active="launches"><section className="dashboard-section standalone"><div className="section-heading"><div><span className="eyebrow">Portfolio</span><h2>My launches</h2><p>Projects owned by the connected wallet.</p></div><Link className="button button-primary" href="/launch/details">New launch <Icon name="arrow" /></Link></div><LaunchTable tokens={TOKENS.slice(0, 3)} /></section></DashboardFrame>;
}

export function LegacyDashboardFees() {
  const [period, setPeriod] = useState("30D");
  return <DashboardFrame active="fees"><section className="analytics-grid"><div className="glass-panel analytics-chart"><div className="section-heading"><div><span className="eyebrow">Fees routed over time</span><h2>$28,420</h2><p><span className="success-text">+18.4%</span> vs previous period</p></div><div className="period-tabs">{["7D", "30D", "ALL"].map((item) => <button className={period === item ? "active" : ""} onClick={() => setPeriod(item)} key={item}>{item}</button>)}</div></div><PriceChart period={period} /></div><div className="glass-panel analytics-breakdown"><span className="eyebrow">Destination breakdown</span><h2>Fee allocation</h2><FeeBars allocations={TOKENS[0].split} />{TOKENS[0].split.map((item) => <div className="analytics-row" key={item.key}><span><i style={{ background: item.color }} />{item.label}</span><strong>${(28420 * item.value / 100).toLocaleString()}</strong></div>)}</div></section><section className="dashboard-section"><div className="section-heading"><div><span className="eyebrow">Recent activity</span><h2>Routing events</h2></div><a href={EXPLORER_URL} target="_blank" rel="noreferrer">Open explorer <Icon name="external" /></a></div><div className="history-list">{ROUTING_HISTORY.map((row) => <div className="history-row" key={row.hash}><span className="history-icon"><Icon name="wallet" /></span><strong>{row.amount}</strong><span className="history-arrow">â†’</span><strong>{row.destination}</strong><small>{row.time}</small><a href={explorerTx(row.hash)} target="_blank" rel="noreferrer">View tx <Icon name="external" size={12} /></a></div>)}</div></section></DashboardFrame>;
}

function RealLaunchTable({ tokens }: { tokens: Token[] }) {
  if (!tokens.length) return <div className="empty-state glass-panel"><p>No launches from this connected wallet are indexed.</p></div>;
  return <div className="launch-table glass-panel"><div className="launch-table-head"><span>Token</span><span>Status</span><span>Market cap</span><span>Volume</span><span>Fee split</span><span>Creator allocation</span><span>Actions</span></div>{tokens.map((token) => <div className="launch-table-row" key={token.address}><div className="table-token"><span className="token-glyph" style={{ "--token-color": token.color } as React.CSSProperties}>{token.ticker[0]}</span><span><strong>{token.name}</strong><small>${token.ticker}</small></span></div><StatusBadge status={token.status} /><span data-label="Market cap">{token.marketCap}</span><span data-label="Volume">{token.volume}</span><span data-label="Fee split">{token.split.map((item) => item.value).join(" / ")}</span><span className="allocation-label" data-label="Creator allocation">{token.split.find((item) => item.key === "creator")?.value ?? 0}% creator</span><div className="table-actions"><Link href={`/manage/${token.address}`}>Manage</Link><Link href={`/token/${token.address}`}>View</Link></div></div>)}</div>;
}

export function RealDashboardOverview() {
  const wallet = useWallet();
  const data = useDashboardData(wallet.address);
  const projects = data?.projects ?? [];
  const reserved = data?.liquidityReserved?.map((item) => `${formatUnits(BigInt(item.rawAmount), 18)} ${currencyLabel(item.currency, projects)}`).join(" Â· ") || "â€”";
  return <DashboardFrame active="overview"><section className="stat-grid"><StatCard label="Indexed launches" value={data ? String(projects.length) : "Loadingâ€¦"} icon="layers" /><StatCard label="Fees accrued Â· indexed" value={data ? groupedAmounts(data.accrued, projects) : "Loadingâ€¦"} icon="chart" /><StatCard label="Fees allocated Â· indexed" value={data ? groupedAmounts(data.allocated, projects) : "Loadingâ€¦"} icon="wallet" /><StatCard label="Liquidity reserved Â· live vault read" value={data?.liquidityReserved ? reserved : "Not configured"} icon="bars" /></section><section className="dashboard-section"><div className="section-heading"><div><span className="eyebrow">Canonical onchain launches</span><h2>Your launches</h2></div><Link href="/dashboard/launches">View all <Icon name="external" /></Link></div>{data?.indexed ? <RealLaunchTable tokens={projects} /> : <div className="empty-state glass-panel"><p>Indexed portfolio data is unavailable until Supabase and the verified-contract indexer are configured.</p></div>}</section></DashboardFrame>;
}

export function RealDashboardLaunches() {
  const wallet = useWallet();
  const data = useDashboardData(wallet.address);
  return <DashboardFrame active="launches"><section className="dashboard-section standalone"><div className="section-heading"><div><span className="eyebrow">Portfolio</span><h2>My launches</h2><p>Projects owned by the connected wallet.</p></div><Link className="button button-primary" href="/launch/details">New launch <Icon name="arrow" /></Link></div>{data?.indexed ? <RealLaunchTable tokens={data.projects} /> : <div className="empty-state glass-panel"><p>Portfolio query is unavailable until the indexer is configured.</p></div>}</section></DashboardFrame>;
}

export function RealDashboardFees() {
  const wallet = useWallet();
  const data = useDashboardData(wallet.address);
  const projects = data?.projects ?? [];
  const reserved = data?.liquidityReserved?.map((item) => `${formatUnits(BigInt(item.rawAmount), 18)} ${currencyLabel(item.currency, projects)}`).join(" Â· ") || "0";
  const launchClaimTotal = data?.protocolLaunchFeeClaims.reduce((total, row) => total + BigInt(row.rawAmount), BigInt(0)) ?? BigInt(0);
  return <DashboardFrame active="fees"><section className="stat-grid"><StatCard label="Fees accrued Â· indexed" value={data ? groupedAmounts(data.accrued, projects) : "Loadingâ€¦"} icon="chart" /><StatCard label="Fees allocated Â· indexed" value={data ? groupedAmounts(data.allocated, projects) : "Loadingâ€¦"} icon="layers" /><StatCard label="Claimed Â· indexed history" value={data ? groupedAmounts(data.claimed, projects) : "Loadingâ€¦"} icon="wallet" /><StatCard label="Protocol launch fees claimed Â· ETH" value={data ? formatUnits(launchClaimTotal, 18) : "Loadingâ€¦"} icon="wallet" /></section><ClaimableFees targets={data?.claimTargets ?? []} /><section className="dashboard-section"><div className="section-heading"><div><span className="eyebrow">Protocol Treasury history</span><h2>Launch-fee claims</h2><p>Canonical ProtocolLaunchFeesClaimed logs indexed from the router.</p></div></div>{data?.protocolLaunchFeeClaims.length ? <div className="history-list">{data.protocolLaunchFeeClaims.map((row) => <div className="history-row" key={row.id}><span className="history-icon"><Icon name="wallet" /></span><strong>{formatUnits(BigInt(row.rawAmount), 18)} ETH</strong><span className="history-arrow">→</span><strong>Protocol Treasury</strong><small>Block {row.blockNumber}</small><a href={explorerTx(row.txHash)} target="_blank" rel="noreferrer">View tx <Icon name="external" size={12} /></a></div>)}</div> : <div className="empty-state glass-panel"><p>No canonical Protocol Treasury launch-fee claims have been indexed for this wallet.</p></div>}</section><section className="dashboard-section"><div className="section-heading"><div><span className="eyebrow">Liquidity accounting</span><h2>Liquidity reserved</h2></div></div><div className="glass-panel analytics-breakdown"><p>Pending liquidity is read from the SPLIT vault on Robinhood Chain. It is not claimable and is not creator income.</p><strong>{data?.liquidityReserved ? reserved : "Vault address not configured"}</strong><p>Supabase shows indexed history only. Claimable values are read directly from the router.</p></div></section>{!data?.indexed ? <div className="empty-state glass-panel"><p>Fee analytics appear after Supabase and the verified-contract indexer are configured.</p></div> : null}</DashboardFrame>;
}

function ClaimableFees({ targets }: { targets: ClaimTarget[] }) {
  const router = splitFeeRouterAddresses[targetChainId as 4663 | 46630];
  return <section className="dashboard-section">
    <div className="section-heading"><div><span className="eyebrow">Live contract balances</span><h2>Claimable recipient fees</h2><p>Only recipient addresses returned by the immutable router configuration are shown.</p></div></div>
    {!router ? <div className="empty-state glass-panel"><p>The verified fee router address is not configured for this network. No claim is simulated.</p></div> : <><ProtocolLaunchFeeClaim router={router} />{targets.length ? <div className="claimable-project-list">{targets.map((target) => <ClaimableProject key={target.poolId} target={target} router={router} />)}</div> : <div className="empty-state glass-panel"><p>No indexed SPLIT pool configurations are available to check yet.</p></div>}</>}
  </section>;
}

function ProtocolLaunchFeeClaim({ router }: { router: Address }) {
  const wallet = useWallet();
  const treasury = useReadContract({ address: router, abi: splitFeeRouterAbi, functionName: "protocolTreasury", chainId: targetChainId });
  const balance = useReadContract({ address: router, abi: splitFeeRouterAbi, functionName: "protocolLaunchFeesAccrued", chainId: targetChainId, query: { refetchInterval: 15_000 } });
  const writer = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: writer.data, chainId: targetChainId });
  const refetchBalance = balance.refetch;
  useEffect(() => { if (receipt.isSuccess) void refetchBalance(); }, [receipt.isSuccess, refetchBalance]);
  const amount = balance.data ?? BigInt(0);
  const isTreasury = Boolean(wallet.address && treasury.data && wallet.address.toLowerCase() === treasury.data.toLowerCase());
  if (!isTreasury) return null;
  const submit = async () => {
    if (amount === BigInt(0) || !wallet.address || writer.isPending) return;
    try {
      await writer.writeContractAsync({ address: router, abi: splitFeeRouterAbi, functionName: "claimProtocolLaunchFees", account: wallet.address, chainId: targetChainId });
    } catch { /* wagmi exposes the transaction error below */ }
  };
  return <article className="glass-panel claimable-project"><div className="claimable-project-head"><strong>Global Protocol Treasury</strong><small>Fixed successful-launch fees</small></div><div className="claimable-recipient"><span>Accrued launch fees · ETH</span><div className="claimable-currency"><strong>{formatUnits(amount, 18)}</strong><button className="button button-outline" disabled={amount === BigInt(0) || writer.isPending || receipt.isLoading || wallet.status !== "connected"} onClick={() => void submit()}>{writer.isPending || receipt.isLoading ? "Pending…" : amount > BigInt(0) ? "Claim protocol fees" : "Nothing to claim"}</button>{receipt.isSuccess ? <small>Claim confirmed</small> : null}{writer.error ? <small className="error-text">{writer.error.message}</small> : null}</div></div></article>;
}

function ClaimableProject({ target, router }: { target: ClaimTarget; router: Address }) {
  const wallet = useWallet();
  const splitRead = useReadContract({
    address: router,
    abi: splitFeeRouterAbi,
    functionName: "splits",
    args: [target.poolId],
    chainId: targetChainId,
  });
  const protocolTreasuryRead = useReadContract({ address: router, abi: splitFeeRouterAbi, functionName: "protocolTreasury", chainId: targetChainId });
  const split = splitRead.data as readonly [Address, Address, Address, number, number, number, number, boolean] | undefined;
  if (!wallet.address || !split || !split[7]) return null;
  const roles = [
    { label: "Creator", address: split[0], protocol: false },
    { label: "Project Treasury", address: split[1], protocol: false },
    { label: "Community", address: split[2], protocol: false },
    ...(protocolTreasuryRead.data ? [{ label: "Protocol Treasury", address: protocolTreasuryRead.data, protocol: true }] : []),
  ].filter((role) => role.address.toLowerCase() === wallet.address?.toLowerCase());
  if (roles.length === 0) return null;
  return <article className="glass-panel claimable-project"><div className="claimable-project-head"><strong>{target.name} <span>${target.symbol}</span></strong><small>Pool {shortAddress(target.poolId, 10, 6)}</small></div>{roles.map((role) => <div className="claimable-recipient" key={role.label}><span>Claimable {role.label} Fees</span><div><ClaimCurrency router={router} poolId={target.poolId} currency="0x0000000000000000000000000000000000000000" currencyName="ETH" role={role.label} protocol={role.protocol} /><ClaimCurrency router={router} poolId={target.poolId} currency={target.tokenAddress} currencyName={`$${target.symbol}`} role={role.label} protocol={role.protocol} /></div></div>)}</article>;
}

function ClaimCurrency({ router, poolId, currency, currencyName, role, protocol = false }: { router: Address; poolId: `0x${string}`; currency: Address; currencyName: string; role: string; protocol?: boolean }) {
  const wallet = useWallet();
  const balance = useReadContract({
    address: router,
    abi: splitFeeRouterAbi,
    functionName: protocol ? "protocolClaimable" : "claimable",
    args: protocol ? [poolId, currency] : [poolId, wallet.address ?? "0x0000000000000000000000000000000000000000", currency],
    chainId: targetChainId,
    query: { enabled: Boolean(wallet.address), refetchInterval: 15_000 },
  });
  const refetchBalance = balance.refetch;
  const writer = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: writer.data, chainId: targetChainId });
  useEffect(() => {
    if (receipt.isSuccess) void refetchBalance();
  }, [receipt.isSuccess, refetchBalance]);
  const amount = balance.data ?? BigInt(0);
  const submit = async () => {
    if (!wallet.address || amount === BigInt(0) || writer.isPending) return;
    try {
      await writer.writeContractAsync({
        address: router,
        abi: splitFeeRouterAbi,
        functionName: protocol ? "claimProtocolFees" : "claim",
        args: protocol ? [poolId, currency] : [poolId, currency],
        account: wallet.address,
        chainId: targetChainId,
      });
    } catch {
      // wagmi exposes the wallet/transaction error through writer.error below.
    }
  };
  const pending = receipt.isLoading || writer.isPending;
  return <div className="claimable-currency"><span>{currencyName}</span><strong>{formatUnits(amount, 18)}</strong><button className="button button-outline" disabled={amount === BigInt(0) || pending || wallet.status !== "connected"} onClick={() => void submit()}>{pending ? "Pendingâ€¦" : amount > BigInt(0) ? `Claim ${role}` : "Nothing to claim"}</button>{receipt.isSuccess ? <small>Claim confirmed Â· onchain balance refreshed</small> : null}{writer.error ? <small className="error-text">{writer.error.message}</small> : null}</div>;
}

/** Financial analytics deliberately separate indexed history from current live balances. */
export function IndexedDashboardFees() {
  return <RealDashboardFees />;
}

type ManageTab = "overview" | "routing" | "profile" | "transactions";
type ManageRouteEvent = { id: string; tx_hash: string; block_number: number; destination_type: string; raw_amount: string; currency: string | null; token_decimals: number | null };

export function LegacyManageProjectPage({ token }: { token: Token }) {
  const wallet = useWallet();
  const [tab, setTab] = useState<ManageTab>("routing");
  const { showToast } = useToast();
  const [profile, setProfile] = useState({ description: token.description, website: token.website, twitter: token.twitter });
  const authorized = wallet.status === "connected" && wallet.address?.toLowerCase() === token.owner.toLowerCase();

  if (wallet.status !== "connected") return <AppShell><div className="section-shell page-body"><div className="connect-gate glass-panel"><span className="wallet-option-icon"><Icon name="lock" /></span><span className="eyebrow">Creator controls</span><h1>{wallet.status === "wrong-network" ? `Switch to ${wallet.targetChainName}` : "Connect an authorized wallet"}</h1><p>Project controls are visible only to the configured owner.</p><WalletActionButton /></div></div></AppShell>;
  if (!authorized) return <AppShell><div className="section-shell page-body"><div className="connect-gate glass-panel error-gate"><span className="wallet-option-icon"><Icon name="lock" /></span><span className="eyebrow">Access denied</span><h1>This wallet cannot manage {token.name}</h1><p>Connected as {shortAddress(wallet.address ?? "")}. Switch to the project owner wallet to continue.</p><Link className="button button-outline" href={`/token/${token.address}`}>Return to token</Link></div></div></AppShell>;

  return <AppShell><div className="section-shell page-body manage-page"><div className="manage-breadcrumb"><Link href="/dashboard">Dashboard</Link><span>/</span><Link href={`/token/${token.address}`}>{token.name} ${token.ticker}</Link></div><section className="manage-identity"><div><span className="token-glyph token-glyph-large" style={{ "--token-color": token.color } as React.CSSProperties}>{token.ticker[0]}</span><div><h1>{token.name}</h1><span>${token.ticker}</span><StatusBadge status={token.status} /><div className="contract-line"><code>{shortAddress(token.address)}</code><CopyButton value={token.address} /></div></div></div><span className="admin-badge">Project admin</span></section><nav className="manage-tabs">{(["overview", "routing", "profile", "transactions"] as ManageTab[]).map((item) => <button className={tab === item ? "active" : ""} onClick={() => setTab(item)} key={item}>{item === "routing" ? "Fee Routing" : item === "profile" ? "Project Profile" : item[0].toUpperCase() + item.slice(1)}</button>)}</nav>{tab === "overview" ? <ManageOverview token={token} /> : tab === "routing" ? <ManageRouting token={token} /> : tab === "profile" ? <section className="profile-form glass-panel"><span className="eyebrow">Editable metadata</span><h2>Project profile</h2><p>Profile fields are offchain metadata. Fee routing remains immutable.</p><label>Description<textarea value={profile.description} onChange={(e) => setProfile({ ...profile, description: e.target.value })} /></label><label>Website<input value={profile.website} onChange={(e) => setProfile({ ...profile, website: e.target.value })} /></label><label>X / Twitter<input value={profile.twitter} onChange={(e) => setProfile({ ...profile, twitter: e.target.value })} /></label><button className="button button-primary" onClick={() => showToast("Project profile saved locally", "success")}>Save profile</button></section> : <section className="dashboard-section standalone"><div className="section-heading"><div><span className="eyebrow">Project activity</span><h2>Transactions</h2></div><a href={`${EXPLORER_URL}/address/${token.address}?tab=txs`} target="_blank" rel="noreferrer">View all <Icon name="external" /></a></div><div className="history-list">{ROUTING_HISTORY.map((row) => <div className="history-row" key={row.hash}><span className="history-icon"><Icon name="wallet" /></span><strong>{row.amount}</strong><span className="history-arrow">â†’</span><strong>{row.destination}</strong><small>{row.time}</small><a href={explorerTx(row.hash)} target="_blank" rel="noreferrer">View tx <Icon name="external" size={12} /></a></div>)}</div></section>}</div></AppShell>;
}

export function ManageProjectPage({ token, routingEvents = [] }: { token: Token; routingEvents?: ManageRouteEvent[] }) {
  const wallet = useWallet();
  const [tab, setTab] = useState<ManageTab>("routing");
  const authorized = wallet.status === "connected" && wallet.address?.toLowerCase() === token.owner.toLowerCase();
  if (wallet.status !== "connected") return <AppShell><div className="section-shell page-body"><div className="connect-gate glass-panel"><span className="wallet-option-icon"><Icon name="lock" /></span><span className="eyebrow">Creator controls</span><h1>{wallet.status === "wrong-network" ? `Switch to ${wallet.targetChainName}` : "Connect an authorized wallet"}</h1><p>Project access is verified against the indexed creator address.</p><WalletActionButton /></div></div></AppShell>;
  if (!authorized) return <AppShell><div className="section-shell page-body"><div className="connect-gate glass-panel error-gate"><span className="wallet-option-icon"><Icon name="lock" /></span><span className="eyebrow">Access denied</span><h1>This wallet cannot manage {token.name}</h1><p>Connected as {shortAddress(wallet.address ?? "")}. Switch to the project creator wallet to continue.</p><Link className="button button-outline" href={`/token/${token.address}`}>Return to token</Link></div></div></AppShell>;

  return <AppShell><div className="section-shell page-body manage-page"><div className="manage-breadcrumb"><Link href="/dashboard">Dashboard</Link><span>/</span><Link href={`/token/${token.address}`}>{token.name} ${token.ticker}</Link></div><section className="manage-identity"><div><span className="token-glyph token-glyph-large" style={{ "--token-color": token.color } as React.CSSProperties}>{token.ticker[0]}</span><div><h1>{token.name}</h1><span>${token.ticker}</span><StatusBadge status={token.status} /><div className="contract-line"><code>{shortAddress(token.address)}</code><CopyButton value={token.address} /></div></div></div><span className="admin-badge">Creator</span></section><nav className="manage-tabs">{(["overview", "routing", "profile", "transactions"] as ManageTab[]).map((item) => <button className={tab === item ? "active" : ""} onClick={() => setTab(item)} key={item}>{item === "routing" ? "Fee Routing" : item === "profile" ? "Project Profile" : item[0].toUpperCase() + item.slice(1)}</button>)}</nav>
    {tab === "overview" ? <section className="manage-overview-grid"><div className="stat-grid"><StatCard label="Market cap Â· indexed" value={token.marketCap} icon="chart" /><StatCard label="Volume Â· cached" value={token.volume} icon="bars" /><StatCard label="Fee allocations" value="Open fee analytics" icon="wallet" /><StatCard label="Holders Â· indexed" value={token.holders} icon="layers" /></div><div className="glass-panel manage-summary"><span className="eyebrow">Protocol state</span><h2>Split configuration is immutable.</h2><p>Swap fees accrue first. Anyone can permissionlessly process accrued fees into recipient claimable balances and the LiquidityVault. A recipient transfer failure affects only that recipientâ€™s separate claim.</p></div></section> : null}
    {tab === "routing" ? <div className="manage-routing-grid"><div><section className="routing-config glass-panel"><div className="form-section-head"><div><span className="eyebrow">Indexed onchain configuration</span><h2>LOCKED ONCHAIN</h2></div><span className="success-text"><span className="status-dot" />Immutable</span></div><FlowDiagram allocations={token.split} /><div className="routing-address-table"><div><span>Destination</span><span>Share</span><span>Address</span><span>Type</span></div>{token.split.map((item) => <div key={item.key}><span><i style={{ background: item.color }} />{item.label}</span><strong>{item.value}%</strong><span><code>{item.address ?? "Unavailable"}</code>{item.address ? <CopyButton value={item.address} /> : null}</span><span>{item.type}</span></div>)}</div></section><div className="locked-callout"><Icon name="lock" /><div><strong>Locked onchain</strong><p>No creator, protocol owner, or admin can edit these destinations or percentages.</p></div></div></div><aside className="glass-panel health-panel"><span className="eyebrow">Liquidity policy</span><h2>Creator cannot withdraw.</h2><p>Seeded LP position is owned by SPLITâ€™s LiquidityVault. Fee liquidity allocations remain reserved per project and currency.</p></aside></div> : null}
    {tab === "profile" ? <section className="profile-form glass-panel"><span className="eyebrow">Offchain metadata</span><h2>Project profile</h2><p>Metadata editing remains unavailable until wallet-signature authentication and its scoped Supabase write policy are deployed. No local save is presented as a published change.</p><label>Description<textarea value={token.description} readOnly /></label><label>Website<input value={token.website} readOnly /></label><label>X / Twitter<input value={token.twitter} readOnly /></label></section> : null}
    {tab === "transactions" ? <section className="dashboard-section standalone"><div className="section-heading"><div><span className="eyebrow">Canonical chain logs</span><h2>Routed fee legs</h2></div><a href={`${EXPLORER_URL}/address/${token.address}?tab=txs`} target="_blank" rel="noreferrer">View explorer <Icon name="external" /></a></div>{routingEvents.length ? <div className="history-list">{routingEvents.map((row) => <div className="history-row" key={row.id}><span className="history-icon"><Icon name="wallet" /></span><strong>{formatUnits(BigInt(row.raw_amount), row.token_decimals ?? 18)} {row.currency?.toLowerCase() === "0x0000000000000000000000000000000000000000" ? "ETH" : token.ticker}</strong><span className="history-arrow">â†’</span><strong>{row.destination_type}</strong><small>Block {row.block_number}</small><a href={explorerTx(row.tx_hash)} target="_blank" rel="noreferrer">View tx <Icon name="external" size={12} /></a></div>)}</div> : <div className="empty-state glass-panel"><p>No canonical routing records indexed for this project yet.</p></div>}</section> : null}
  </div></AppShell>;
}

function ManageOverview({ token }: { token: Token }) {
  return <div className="manage-overview-grid"><div className="stat-grid"><StatCard label="Market cap Â· indexed" value={token.marketCap} icon="chart" /><StatCard label="Volume Â· indexed" value={token.volume} icon="bars" /><StatCard label="Fee allocations" value="Open fee analytics" icon="wallet" /><StatCard label="Holders Â· indexed" value={token.holders} icon="layers" /></div><div className="glass-panel manage-summary"><span className="eyebrow">Protocol state</span><h2>Allocation and claims are separate.</h2><p>Processed fees become pull-claim balances for configured recipients. Liquidity allocations remain reserved in the SPLIT vault.</p><span className="success-text"><span className="status-dot" />Immutable split configuration</span></div></div>;
}

function ManageRouting({ token }: { token: Token }) {
  return <div className="manage-routing-grid"><div><section className="routing-config glass-panel"><div className="form-section-head"><div><span className="eyebrow">Immutable configuration</span><h2>Current split</h2></div><span className="success-text"><span className="status-dot" />Indexed onchain</span></div><FlowDiagram allocations={token.split} /><div className="routing-address-table"><div><span>Destination</span><span>Share</span><span>Address</span><span>Type</span></div>{token.split.map((item) => <div key={item.key}><span><i style={{ background: item.color }} />{item.label}</span><strong>{item.value}%</strong><span><code>{item.address}</code><CopyButton value={item.address ?? ""} /></span><span>{item.type}</span></div>)}</div></section><div className="locked-callout"><Icon name="lock" /><div><strong>Locked onchain</strong><p>The fee routing configuration for this token is immutable and cannot be modified. This was set at deployment.</p></div></div></div><aside className="glass-panel health-panel"><span className="eyebrow">Payout design</span><h2>Recipients claim<br />independently.</h2><p>Allocation never transfers directly to a recipient. Each recipient claim is isolated, and the liquidity share stays reserved in the vault.</p><span className="success-text"><span className="status-dot" />Immutable split configuration</span></aside></div>;
}

export function SettingsPage() {
  const wallet = useWallet();
  const { showToast } = useToast();
  const [reducedMotion, setReducedMotion] = useState(() => typeof document !== "undefined" && document.documentElement.dataset.motion === "reduced");
  const toggleMotion = () => { const next = !reducedMotion; setReducedMotion(next); document.documentElement.dataset.motion = next ? "reduced" : "full"; showToast(next ? "Motion reduced" : "Full motion restored", "success"); };
  return <AppShell><div className="section-shell page-body settings-page"><span className="eyebrow">Preferences</span><h1>Settings</h1><p>Manage your local SPLIT experience. These settings do not change wallet or onchain state.</p><div className="settings-grid"><section className="glass-panel"><Icon name="wallet" /><div><h2>Wallet</h2><p>{wallet.address ? shortAddress(wallet.address, 8, 6) : "No wallet connected"}</p></div>{wallet.status === "connected" ? <button className="button button-outline" onClick={() => void wallet.disconnect()}>Disconnect</button> : wallet.status === "wrong-network" ? <><WalletActionButton connectLabel="Connect" /><button className="button button-outline" onClick={() => void wallet.disconnect()}>Disconnect</button></> : <WalletActionButton connectLabel="Connect" />}</section><section className="glass-panel"><Icon name="chart" /><div><h2>Motion</h2><p>Reduce scroll reveals, route streams, and ambient effects.</p></div><button className={`toggle ${reducedMotion ? "active" : ""}`} onClick={toggleMotion} aria-pressed={reducedMotion}><span /></button></section><section className="glass-panel"><Icon name="globe" /><div><h2>Network</h2><p>{wallet.targetChainName} Â· Chain ID {targetChainId}</p></div><a className="button button-outline" href="https://docs.robinhood.com/chain/connecting/" target="_blank" rel="noreferrer">Network details <Icon name="external" /></a></section></div><Erc20BalanceLookup /></div></AppShell>;
}
