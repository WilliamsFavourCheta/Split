"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useConnection, usePublicClient, useWalletClient } from "wagmi";
import { decodeEventLog, formatEther, isAddress, parseEther, zeroHash } from "viem";
import { getSplitFactoryAddress, productionLaunchEnabled } from "../contracts/addresses";
import { splitFactoryAbi } from "../contracts/abis";
import { waitForSuccessfulReceipt } from "../contracts/interactions";
import { createBrowserSupabaseClient, isSupabaseConfigured } from "../lib/supabase/client";
import { DEFAULT_SPLIT, type Allocation } from "../data/mock";
import { useLaunchDraft, useToast, useWallet } from "./providers";
import { AppShell } from "./shell";
import { Icon } from "./icons";
import { SplitStrip } from "./visuals";
import { targetChainId } from "../web3/chains";
import { getTransactionExplorerUrl } from "../web3/explorer";
import { toWalletErrorMessage } from "../web3/errors";

type TxState = "idle" | "awaiting-signature" | "pending" | "indexing" | "error";

export function OnchainLaunchReview() {
  const { draft } = useLaunchDraft();
  const wallet = useWallet();
  const { connector } = useConnection();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: targetChainId });
  const router = useRouter();
  const { showToast } = useToast();
  const [txState, setTxState] = useState<TxState>("idle");
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const allocations: Allocation[] = DEFAULT_SPLIT.map((item) => ({ ...item, value: draft.allocations[item.key] }));
  let totalEthRequired = "Unavailable";
  try { totalEthRequired = formatEther(parseEther(draft.initialLiquidity) + parseEther("0.0005")); } catch { /* incomplete draft */ }
  const factoryAddress = getSplitFactoryAddress(wallet.chainId ?? targetChainId);
  const busy = txState === "awaiting-signature" || txState === "pending" || txState === "indexing"
    || wallet.status === "connecting" || wallet.status === "restoring" || wallet.status === "switching" || wallet.status === "disconnecting";

  const deploy = async () => {
    if (!productionLaunchEnabled) {
      setTxError("Production token launching is disabled in this pre-launch preview. No transaction was sent.");
      setTxState("error");
      return;
    }
    if (wallet.status === "wrong-network") { await wallet.switchNetwork(); return; }
    if (wallet.status !== "connected" || !wallet.address) { await wallet.openWallet(); return; }
    if (!factoryAddress || !walletClient || !publicClient || !connector) {
      setTxError("No verified SPLIT factory is configured for this network yet. No transaction was sent.");
      setTxState("error");
      return;
    }
    if (!isAddress(draft.communityAddress)) {
      setTxError("Enter a valid community destination address before launching.");
      setTxState("error");
      return;
    }
    if (wallet.chainId !== 4663) {
      setTxError("SPLIT launches are disabled on RH testnet until an official compatible v4 PoolManager is verified.");
      setTxState("error");
      return;
    }

    let quoteAmount: bigint;
    let tokenSeedAmount: bigint;
    const launchFee = parseEther("0.0005");
    try {
      quoteAmount = parseEther(draft.initialLiquidity);
      tokenSeedAmount = parseEther(draft.tokenSeedAmount);
      if (quoteAmount <= BigInt(0) || tokenSeedAmount <= BigInt(0) || tokenSeedAmount > BigInt(1_000_000_000) * BigInt(10) ** BigInt(18)) throw new Error("invalid seed amounts");
      if (Object.values(draft.allocations).reduce((sum, value) => sum + value, 0) !== 100) throw new Error("invalid allocations");
      if (draft.quoteAsset !== "ETH") throw new Error("unsupported quote asset");
      if (draft.allocations.projectTreasury > 0 && !isAddress(draft.projectTreasuryAddress)) throw new Error("invalid project treasury");
      if (!isAddress(draft.communityAddress)) throw new Error("invalid community destination");
    } catch {
      setTxError("Check both seed amounts, the ETH quote asset, the project destinations, and the 100% project split before trying again.");
      setTxState("error");
      return;
    }

    setTxError(null);
    setTxHash(null);
    let submittedHash: `0x${string}` | undefined;
    let chainConfirmed = false;
    try {
      const liveChainId = await connector.getChainId();
      const liveAccounts = await connector.getAccounts();
      if (liveChainId !== 4663) throw new Error("Switch your wallet to Robinhood Chain before signing.");
      if (!liveAccounts[0] || liveAccounts[0].toLowerCase() !== wallet.address.toLowerCase()) {
        throw new Error("Your active wallet account changed. Reconnect and review it before signing.");
      }

      setTxState("awaiting-signature");
      submittedHash = await walletClient.writeContract({
        address: factoryAddress,
        abi: splitFactoryAbi,
        functionName: "launch",
        args: [{
          name: draft.name.trim(),
          symbol: draft.symbol.trim().toUpperCase(),
          tokenSeedAmount,
          seedQuoteAmount: quoteAmount,
          creatorBps: BigInt(draft.allocations.creator * 100),
          liquidityBps: BigInt(draft.allocations.liquidity * 100),
          projectTreasuryBps: BigInt(draft.allocations.projectTreasury * 100),
          communityBps: BigInt(draft.allocations.community * 100),
          projectTreasury: draft.allocations.projectTreasury > 0 ? draft.projectTreasuryAddress as `0x${string}` : "0x0000000000000000000000000000000000000000",
          community: draft.communityAddress as `0x${string}`,
          salt: zeroHash,
        }],
        value: quoteAmount + launchFee,
        account: wallet.address,
      });
      setTxHash(submittedHash);
      setTxState("pending");
      const receipt = await waitForSuccessfulReceipt(publicClient, submittedHash);
      chainConfirmed = true;

      let confirmedToken: `0x${string}` | undefined;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== factoryAddress.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({ abi: splitFactoryAbi, eventName: "TokenLaunched", data: log.data, topics: log.topics });
          confirmedToken = decoded.args.token;
          break;
        } catch { /* The same factory receipt may include non-launch events. */ }
      }
      if (!confirmedToken) throw new Error("Confirmed onchain, but the TokenLaunched event could not be read. Use the transaction link to verify it.");

      setTxState("indexing");
      let indexed = false;
      if (isSupabaseConfigured) {
        const supabase = createBrowserSupabaseClient();
        for (let attempt = 0; attempt < 15; attempt += 1) {
          const { data } = await supabase.from("projects").select("id").eq("chain_id", 4663).eq("token_address", confirmedToken.toLowerCase()).maybeSingle();
          if (data) { indexed = true; break; }
          await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        }
      }
      if (!indexed) showToast("Launch confirmed. Indexing your project...", "default");
      router.push(`/launch/success?token=${confirmedToken}&tx=${submittedHash}&indexed=${indexed ? "1" : "0"}`);
    } catch (error) {
      if (submittedHash) setTxHash(submittedHash);
      const message = chainConfirmed
        ? "Launch confirmed. Indexing is still catching up; inspect the transaction while it syncs."
        : error instanceof Error && /Switch your wallet|active wallet account changed/.test(error.message)
          ? error.message
          : toWalletErrorMessage(error);
      setTxError(message);
      setTxState(chainConfirmed ? "indexing" : "error");
      showToast(message, chainConfirmed ? "default" : "error");
      if (chainConfirmed && submittedHash) router.push(`/launch/success?tx=${submittedHash}&indexed=0`);
    }
  };

  const actionLabel = !productionLaunchEnabled ? "Pre-launch preview"
    : wallet.status === "wrong-network" ? "Switch Network"
    : wallet.status === "connecting" ? "Connecting Wallet"
      : wallet.status === "restoring" ? "Restoring Wallet"
        : wallet.status === "switching" ? "Switching Network"
          : wallet.status === "unavailable" ? "No Wallet Found"
            : wallet.status !== "connected" ? "Connect Wallet"
              : !factoryAddress ? "Factory not configured"
                : txState === "awaiting-signature" ? "Confirm in wallet"
                  : txState === "pending" ? "Transaction pending"
                    : txState === "indexing" ? "Indexing launch"
                      : txState === "error" ? "Try again" : "Deploy token";
  const transactionUrl = txHash ? getTransactionExplorerUrl(txHash, 4663) : undefined;

  return <div className="review-layout">
    <section>
      <span className="eyebrow">Step 04 / Review</span><h2 className="review-title">Review your<br /><span>launch.</span></h2>
      <p className="review-lede">A confirmed factory transaction creates the token, pool, vault-owned seed position, and immutable split in one atomic call.</p>
      <ReviewSection title="Token" editHref="/launch/details"><dl><div><dt>Name</dt><dd>{draft.name || "Not provided"}</dd></div><div><dt>Symbol</dt><dd>${draft.symbol || "-"}</dd></div><div><dt>Description</dt><dd>{draft.description || "No description"}</dd></div></dl></ReviewSection>
      <ReviewSection title="Market" editHref="/launch/market"><dl><div><dt>Fixed launch fee</dt><dd>0.0005 ETH (Protocol Treasury)</dd></div><div><dt>Initial quote liquidity</dt><dd>{draft.initialLiquidity} ETH (project seed)</dd></div><div><dt>Initial token liquidity</dt><dd>{draft.tokenSeedAmount} ${draft.symbol || "TOKEN"}</dd></div><div><dt>Total ETH required</dt><dd>{totalEthRequired} ETH + network gas</dd></div><div><dt>SPLIT trading fee</dt><dd>1% on official registered-pool swaps · 10% of collected fee to Protocol Treasury · 90% programmable</dd></div><div><dt>Pool LP fee</dt><dd>0.30%</dd></div></dl></ReviewSection>
      <ReviewSection title="Project fee split (100% of programmable 90%)" editHref="/launch/split"><SplitStrip allocations={allocations} /><div className="review-split">{allocations.map((item) => <span key={item.key}><i style={{ background: item.color }} />{item.label}<strong>{item.value}%</strong></span>)}</div><p>Protocol Treasury receives a separate, non-configurable 10% of every collected SPLIT swap fee. The four percentages below divide only the remaining 90%.</p><p>Creator recipient: <code>{wallet.address || "Connect wallet"}</code></p><p>Liquidity allocation: <strong>{draft.allocations.liquidity}%</strong> to the SPLIT LiquidityVault; the seeded LP position is vault-controlled.</p><p>Project Treasury recipient: <code>{draft.allocations.projectTreasury === 0 ? "Not allocated (0%)" : draft.projectTreasuryAddress || "Not set"}</code></p><p>Community recipient: <code>{draft.communityAddress || "Not set"}</code></p></ReviewSection>
    </section>
    <aside className="deploy-card glass-panel">
      <span className="eyebrow">Deployment</span>
      <h3>{!productionLaunchEnabled ? "Visual review only" : txState === "indexing" ? "Launch confirmed" : wallet.status === "connected" ? "Ready to deploy" : "Connect your wallet"}</h3>
      <p>{!productionLaunchEnabled ? "Contracts have not completed release approval or production deployment. You can review the launch flow, but no transaction can be submitted." : txState === "indexing" ? "The Robinhood Chain transaction is confirmed. We're waiting for the indexer to publish your project." : "Review the fee destinations and seed amounts. SPLIT fees accrue on swaps and are routed separately."}</p>
      <div className="deploy-cost"><span>Target network</span><strong>{wallet.targetChainName}</strong><span>Factory</span><strong>{factoryAddress ? `${factoryAddress.slice(0, 8)}...${factoryAddress.slice(-6)}` : "Not configured"}</strong><span>Fee configuration</span><strong>{factoryAddress ? "Onchain / immutable" : "Awaiting verified deployment"}</strong></div>
      <button className="button button-primary deploy-button" disabled={!productionLaunchEnabled || busy || (!factoryAddress && wallet.status === "connected")} onClick={() => void deploy()}>{busy ? <><span className="spinner" />{actionLabel}</> : actionLabel} <Icon name={!productionLaunchEnabled ? "lock" : wallet.status === "wrong-network" ? "globe" : wallet.status === "connected" ? "arrow" : "wallet"} /></button>
      {txHash && transactionUrl ? <a className="deploy-disclaimer" href={transactionUrl} target="_blank" rel="noreferrer">View transaction {txHash.slice(0, 10)}...</a> : null}
      {txError ? <p className="form-error" role="alert">{txError}</p> : null}
      <small className="deploy-disclaimer"><Icon name="lock" />No database write is treated as a launch. The confirmed chain event is the source of truth.</small>
    </aside>
  </div>;
}

function ReviewSection({ title, editHref, children }: { title: string; editHref: string; children: React.ReactNode }) {
  return <section className="review-section glass-panel"><div><h3>{title}</h3><Link href={editHref}>Edit {title} <Icon name="arrow" size={13} /></Link></div>{children}</section>;
}

export function OnchainLaunchSuccessPage() {
  const { resetDraft } = useLaunchDraft();
  const { showToast } = useToast();

  return <AppShell footer={false}><div className="success-page section-shell">
    <div className="success-orbit"><span><Icon name="lock" size={34} /></span><i /><i /></div>
    <span className="eyebrow">Pre-launch visual preview</span>
    <h1>Token launching<br /><span>is disabled.</span></h1>
    <p>SPLIT production contracts have not completed release approval or deployment. Query-string values are not treated as proof of a transaction. No launch was submitted from this preview.</p>
    <div className="success-actions"><button className="button button-outline" onClick={() => { resetDraft(); showToast("Launch draft cleared", "success"); }}>Clear draft</button></div>
  </div></AppShell>;
}
