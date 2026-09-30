"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useConnection, usePublicClient, useWalletClient } from "wagmi";
import { decodeEventLog, formatEther, isAddress, isHash, parseEther, zeroHash } from "viem";
import { getSplitFactoryAddress, productionLaunchEnabled } from "../contracts/addresses";
import { splitFactoryAbi } from "../contracts/abis";
import { waitForSuccessfulReceipt } from "../contracts/interactions";
import { DEFAULT_SPLIT, type Allocation } from "../data/mock";
import { useLaunchDraft, useToast, useWallet } from "./providers";
import { AppShell } from "./shell";
import { Icon } from "./icons";
import { SplitStrip } from "./visuals";
import { robinhoodMainnet, targetChainId } from "../web3/chains";
import { getTransactionExplorerUrl } from "../web3/explorer";
import { toLaunchErrorMessage } from "../web3/errors";
import { uploadConfirmedProjectMetadata } from "../lib/projects/upload-metadata";
import { validateTokenIdentity } from "../lib/projects/token-identity";
import type { LaunchDraft } from "../lib/projects/launch-draft";
import { prepareLogo } from "../lib/projects/prepare-logo";

type TxState = "idle" | "awaiting-signature" | "pending" | "indexing" | "error";
const LAUNCH_FEE = parseEther("0.0005");
const LARGE_LIQUIDITY = parseEther("0.1");

function launchArguments(draft: LaunchDraft) {
  const identity = validateTokenIdentity(draft.name, draft.symbol);
  return [{
    name: identity.name,
    symbol: identity.symbol,
    tokenSeedAmount: parseEther(draft.tokenSeedAmount),
    seedQuoteAmount: parseEther(draft.initialLiquidity),
    creatorBps: BigInt(draft.allocations.creator * 100),
    liquidityBps: BigInt(draft.allocations.liquidity * 100),
    projectTreasuryBps: BigInt(draft.allocations.projectTreasury * 100),
    communityBps: BigInt(draft.allocations.community * 100),
    projectTreasury: draft.allocations.projectTreasury > 0 ? draft.projectTreasuryAddress as `0x${string}` : "0x0000000000000000000000000000000000000000",
    community: draft.communityAddress as `0x${string}`,
    salt: zeroHash,
  }] as const;
}

export function OnchainLaunchReview() {
  const { draft, updateDraft } = useLaunchDraft();
  const wallet = useWallet();
  const { connector } = useConnection();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: targetChainId });
  const router = useRouter();
  const { showToast } = useToast();
  const [txState, setTxState] = useState<TxState>("idle");
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const [txNotice, setTxNotice] = useState<string | null>(null);
  const [largeAmountConfirmation, setLargeAmountConfirmation] = useState("");
  const [gasEstimate, setGasEstimate] = useState<{ key: string; eth: string } | null>(null);
  const allocations: Allocation[] = DEFAULT_SPLIT.map((item) => ({ ...item, value: draft.allocations[item.key] }));
  let totalEthRequired = "Unavailable";
  let largeLiquidity = false;
  try {
    if (draft.initialLiquidityExplicit) {
      const liquidity = parseEther(draft.initialLiquidity);
      totalEthRequired = formatEther(liquidity + LAUNCH_FEE);
      largeLiquidity = liquidity >= LARGE_LIQUIDITY;
    }
  } catch { /* incomplete draft */ }
  const factoryAddress = getSplitFactoryAddress(wallet.chainId ?? targetChainId);
  const estimateKey = JSON.stringify([draft.name, draft.symbol, draft.initialLiquidity, draft.tokenSeedAmount, draft.allocations, draft.projectTreasuryAddress, draft.communityAddress, wallet.address, factoryAddress]);
  const estimatedGasEth = gasEstimate?.key === estimateKey ? gasEstimate.eth : null;
  const busy = txState === "awaiting-signature" || txState === "pending" || txState === "indexing"
    || wallet.status === "connecting" || wallet.status === "restoring" || wallet.status === "switching" || wallet.status === "disconnecting";

  useEffect(() => {
    if (!publicClient || !factoryAddress || !wallet.address || wallet.chainId !== 4663 || !draft.initialLiquidityExplicit) return;
    if (!validateTokenIdentity(draft.name, draft.symbol).valid || !isAddress(draft.communityAddress)
      || (draft.allocations.projectTreasury > 0 && !isAddress(draft.projectTreasuryAddress))) return;
    let cancelled = false;
    void (async () => {
      try {
        const value = parseEther(draft.initialLiquidity) + LAUNCH_FEE;
        const [gas, gasPrice] = await Promise.all([
          publicClient.estimateContractGas({ address: factoryAddress, abi: splitFactoryAbi, functionName: "launch", args: launchArguments(draft), value, account: wallet.address! }),
          publicClient.getGasPrice(),
        ]);
        if (!cancelled) setGasEstimate({ key: estimateKey, eth: formatEther(gas * gasPrice) });
      } catch {
        if (!cancelled) setGasEstimate({ key: estimateKey, eth: "Unavailable; wallet will show final network gas" });
      }
    })();
    return () => { cancelled = true; };
  }, [draft, estimateKey, factoryAddress, publicClient, wallet.address, wallet.chainId]);

  const deploy = async () => {
    setTxError(null);
    setTxNotice(null);
    if (draft.pendingLaunchTx && isHash(draft.pendingLaunchTx)) {
      router.push(`/launch/success?tx=${draft.pendingLaunchTx}`);
      return;
    }
    if (!productionLaunchEnabled) {
      setTxError("Production token launching is disabled in this pre-launch preview. No transaction was sent.");
      setTxState("error");
      return;
    }
    if (wallet.status === "wrong-network") {
      setTxNotice("Switching networks does not submit a launch. Once connected to Robinhood Chain, click Deploy token.");
      await wallet.switchNetwork();
      return;
    }
    if (wallet.status !== "connected" || !wallet.address) {
      setTxNotice("Connecting your wallet does not submit a launch. Once connected, click Deploy token to request the transaction.");
      await wallet.openWallet();
      return;
    }
    if (!factoryAddress) {
      setTxError("The verified SPLIT Factory is not configured for this network. No transaction was sent.");
      setTxState("error");
      return;
    }
    if (!walletClient || !connector) {
      setTxError("The wallet session is still initializing. Wait a moment or reconnect, then click Deploy token. No transaction was sent.");
      setTxState("error");
      return;
    }
    if (!publicClient) {
      setTxError("Robinhood Chain RPC is unavailable. No transaction was sent.");
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
    const identity = validateTokenIdentity(draft.name, draft.symbol);
    try {
      if (!identity.valid) throw new Error(`${identity.nameError || identity.symbolError} No transaction was sent.`);
      if (!draft.initialLiquidityExplicit) throw new Error("Enter the initial ETH liquidity amount yourself before launching. No transaction was sent.");
      quoteAmount = parseEther(draft.initialLiquidity);
      tokenSeedAmount = parseEther(draft.tokenSeedAmount);
      if (quoteAmount <= BigInt(0) || tokenSeedAmount <= BigInt(0) || tokenSeedAmount > BigInt(1_000_000_000) * BigInt(10) ** BigInt(18)) throw new Error("Enter positive seed amounts, with no more than 1 billion seed tokens. No transaction was sent.");
      if (!Object.values(draft.allocations).every((value) => Number.isInteger(value) && value >= 0 && value <= 100)
        || Object.values(draft.allocations).reduce((sum, value) => sum + value, 0) !== 100) throw new Error("Project allocation percentages must be whole numbers totaling 100%. No transaction was sent.");
      if (draft.quoteAsset !== "ETH") throw new Error("Only ETH is supported as the quote asset. No transaction was sent.");
      if (draft.allocations.projectTreasury > 0 && !isAddress(draft.projectTreasuryAddress)) throw new Error("Enter a valid project treasury address. No transaction was sent.");
      if (!isAddress(draft.communityAddress)) throw new Error("Enter a valid community address. No transaction was sent.");
      if (quoteAmount >= LARGE_LIQUIDITY && largeAmountConfirmation.trim() !== draft.initialLiquidity) throw new Error(`For this large launch, type ${draft.initialLiquidity} in the confirmation field. No transaction was sent.`);
    } catch (error) {
      setTxError(error instanceof Error ? error.message : "Check the launch fields before trying again. No transaction was sent.");
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
        args: launchArguments(draft),
        value: quoteAmount + LAUNCH_FEE,
        account: wallet.address,
      });
      updateDraft({ pendingLaunchTx: submittedHash });
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
      router.push(`/launch/success?tx=${submittedHash}`);
    } catch (error) {
      if (submittedHash) setTxHash(submittedHash);
      const message = chainConfirmed
        ? "Launch confirmed. Indexing is still catching up; inspect the transaction while it syncs."
        : submittedHash
          ? `A launch transaction was submitted, but confirmation failed. ${toLaunchErrorMessage(error)} Check its transaction link before retrying.`
          : `No launch transaction hash was returned. ${toLaunchErrorMessage(error)}`;
      setTxError(message);
      setTxState(chainConfirmed ? "indexing" : "error");
      showToast(message, chainConfirmed ? "default" : "error");
      if (chainConfirmed && submittedHash) router.push(`/launch/success?tx=${submittedHash}`);
    }
  };

  const actionLabel = draft.pendingLaunchTx ? "Resume launch completion"
    : !productionLaunchEnabled ? "Pre-launch preview"
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
      <ReviewSection title="Market" editHref="/launch/market"><dl>
        <div><dt>Initial ETH liquidity</dt><dd>{draft.initialLiquidityExplicit ? `${draft.initialLiquidity} ETH` : "Enter an amount"} (locked seed)</dd></div>
        <div><dt>Initial token liquidity</dt><dd>{draft.tokenSeedAmount} ${draft.symbol || "TOKEN"}</dd></div>
        <div><dt>Fixed SPLIT launch fee</dt><dd>0.0005 ETH (Protocol Treasury)</dd></div>
        <div><dt>Estimated network gas</dt><dd>{estimatedGasEth ? `${estimatedGasEth}${estimatedGasEth.startsWith("Unavailable") ? "" : " ETH"}` : "Calculating when wallet connects; wallet shows final gas"}</dd></div>
        <div className="review-total"><dt>TOTAL ETH TO SEND</dt><dd>{totalEthRequired === "Unavailable" ? totalEthRequired : `${totalEthRequired} ETH`}</dd></div>
        <div><dt>SPLIT trading fee</dt><dd>1% on official registered-pool swaps · 10% protocol · 90% programmable</dd></div><div><dt>Pool LP fee</dt><dd>0.30%</dd></div>
      </dl><p className="gas-disclaimer">Network gas is paid separately on top of the transaction value. The wallet displays its final gas estimate before signing.</p></ReviewSection>
      <ReviewSection title="Project fee split (100% of programmable 90%)" editHref="/launch/split"><SplitStrip allocations={allocations} /><div className="review-split">{allocations.map((item) => <span key={item.key}><i style={{ background: item.color }} />{item.label}<strong>{item.value}%</strong></span>)}</div><p>Protocol Treasury receives a separate, non-configurable 10% of every collected SPLIT swap fee. The four percentages below divide only the remaining 90%.</p><p>Creator recipient: <code>{wallet.address || "Connect wallet"}</code></p><p>Liquidity allocation: <strong>{draft.allocations.liquidity}%</strong> to the SPLIT LiquidityVault; the seeded LP position is vault-controlled.</p><p>Project Treasury recipient: <code>{draft.allocations.projectTreasury === 0 ? "Not allocated (0%)" : draft.projectTreasuryAddress || "Not set"}</code></p><p>Community recipient: <code>{draft.communityAddress || "Not set"}</code></p></ReviewSection>
    </section>
    <aside className="deploy-card glass-panel">
      <span className="eyebrow">Deployment</span>
      <h3>{!productionLaunchEnabled ? "Visual review only" : txState === "indexing" ? "Launch confirmed" : wallet.status === "connected" ? "Ready to deploy" : "Connect your wallet"}</h3>
      <p>{!productionLaunchEnabled ? "Contracts have not completed release approval or production deployment. You can review the launch flow, but no transaction can be submitted." : txState === "indexing" ? "The Robinhood Chain transaction is confirmed. We're waiting for the indexer to publish your project." : "Review the fee destinations and seed amounts. SPLIT fees accrue on swaps and are routed separately."}</p>
      <div className="deploy-cost"><span>Target network</span><strong>{wallet.targetChainName}</strong><span>Factory</span><strong>{factoryAddress ? `${factoryAddress.slice(0, 8)}...${factoryAddress.slice(-6)}` : "Not configured"}</strong><span>Fee configuration</span><strong>{factoryAddress ? "Onchain / immutable" : "Awaiting verified deployment"}</strong></div>
      <div className="launch-send-amount"><span>Exact wallet transaction value</span><strong>{totalEthRequired === "Unavailable" ? totalEthRequired : `${totalEthRequired} ETH`}</strong><small>{draft.initialLiquidityExplicit ? `${draft.initialLiquidity} ETH initial liquidity + 0.0005 ETH fixed launch fee. Network gas is separate.` : "Enter initial ETH liquidity on the Market step."}</small></div>
      {largeLiquidity ? <div className="high-liquidity-warning"><strong>Large initial liquidity: {draft.initialLiquidity} ETH</strong><p>The wallet will request {totalEthRequired} ETH plus gas. Type the exact liquidity amount below to confirm before deploying.</p><label>Confirm initial liquidity amount<input type="text" inputMode="decimal" value={largeAmountConfirmation} onChange={(event) => setLargeAmountConfirmation(event.target.value)} placeholder={`Type ${draft.initialLiquidity}`} autoComplete="off" /></label></div> : null}
      <button className="button button-primary deploy-button" disabled={(!productionLaunchEnabled && !draft.pendingLaunchTx) || busy || (!draft.pendingLaunchTx && !factoryAddress && wallet.status === "connected") || (!draft.pendingLaunchTx && wallet.status === "connected" && largeLiquidity && largeAmountConfirmation.trim() !== draft.initialLiquidity)} onClick={() => void deploy()}>{busy ? <><span className="spinner" />{actionLabel}</> : actionLabel} <Icon name={!productionLaunchEnabled && !draft.pendingLaunchTx ? "lock" : wallet.status === "wrong-network" ? "globe" : "arrow"} /></button>
      {txHash && transactionUrl ? <a className="deploy-disclaimer" href={transactionUrl} target="_blank" rel="noreferrer">View transaction {txHash.slice(0, 10)}...</a> : null}
      {txNotice ? <p className="deploy-disclaimer" role="status">{txNotice}</p> : null}
      {txError ? <p className="form-error" role="alert">{txError}</p> : null}
      <small className="deploy-disclaimer"><Icon name="lock" />No database write is treated as a launch. The confirmed chain event is the source of truth.</small>
    </aside>
  </div>;
}

function ReviewSection({ title, editHref, children }: { title: string; editHref: string; children: React.ReactNode }) {
  return <section className="review-section glass-panel"><div><h3>{title}</h3><Link href={editHref}>Edit {title} <Icon name="arrow" size={13} /></Link></div>{children}</section>;
}

export function OnchainLaunchSuccessPage() {
  const { draft, draftHydrated, updateDraft, resetDraft } = useLaunchDraft();
  const { showToast } = useToast();
  const wallet = useWallet();
  const router = useRouter();
  const publicClient = usePublicClient({ chainId: 4663 });
  const { data: walletClient } = useWalletClient();
  const logoInputRef = useRef<HTMLInputElement>(null);
  const completionInFlight = useRef(false);
  const [confirmed, setConfirmed] = useState<{ token: `0x${string}`; hash: `0x${string}`; creator: `0x${string}`; name: string; symbol: string } | null>(null);
  const [verification, setVerification] = useState("Checking the Robinhood Chain launch transaction...");
  const [receiptReverted, setReceiptReverted] = useState(false);
  const [phase, setPhase] = useState<"checking" | "indexing" | "ready" | "saving" | "complete" | "error">("checking");
  const [readinessAttempt, setReadinessAttempt] = useState(0);
  const [completionError, setCompletionError] = useState("");
  const [logoError, setLogoError] = useState("");
  const [recoveryDraft, setRecoveryDraft] = useState({ logoName: "", logoDataUrl: "", description: "", website: "", twitter: "", telegram: "", discord: "" });
  const draftMatchesLaunch = Boolean(draftHydrated && confirmed
    && draft.name.trim() === confirmed.name && draft.symbol.trim() === confirmed.symbol
    && (!draft.pendingLaunchTx || draft.pendingLaunchTx.toLowerCase() === confirmed.hash.toLowerCase()));
  const metadataDraft = draftMatchesLaunch ? draft : recoveryDraft;

  const copyTokenAddress = async () => {
    if (!confirmed) return;
    try {
      await navigator.clipboard.writeText(confirmed.token);
      showToast("Token contract address copied", "success");
    } catch {
      showToast("Clipboard permission was blocked", "error");
    }
  };

  useEffect(() => {
    const hash = new URLSearchParams(window.location.search).get("tx");
    const factory = getSplitFactoryAddress(4663);
    if (!hash || !isHash(hash) || !factory || !publicClient) {
      queueMicrotask(() => setVerification("No verifiable SPLIT launch receipt was provided."));
      return;
    }
    let cancelled = false;
    void publicClient.waitForTransactionReceipt({ hash }).then((receipt) => {
      if (cancelled) return;
      if (receipt.status !== "success") {
        setReceiptReverted(true);
        throw new Error("The launch transaction reverted. Your draft is still saved.");
      }
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== factory.toLowerCase()) continue;
        try {
          const event = decodeEventLog({ abi: splitFactoryAbi, eventName: "TokenLaunched", data: log.data, topics: log.topics });
          setConfirmed({ token: event.args.token, hash, creator: event.args.creator, name: event.args.name, symbol: event.args.symbol });
          setVerification("");
          return;
        } catch { /* Other factory logs are allowed in the receipt. */ }
      }
      throw new Error("No SPLIT TokenLaunched event was found in the confirmed factory receipt.");
    }).catch((error) => { if (!cancelled) setVerification(error instanceof Error ? error.message : "The launch receipt could not be verified."); });
    return () => { cancelled = true; };
  }, [publicClient]);

  useEffect(() => {
    if (!confirmed) return;
    let cancelled = false;
    let timer: number | undefined;
    void fetch(`/api/projects/metadata?token=${encodeURIComponent(confirmed.token)}`, { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json() as { saved?: boolean; error?: string };
        if (cancelled) return;
        if (response.status === 409) {
          setPhase("indexing");
          timer = window.setTimeout(() => setReadinessAttempt((value) => value + 1), 3000);
          return;
        }
        if (!response.ok) throw new Error(result.error || "Project readiness could not be checked.");
        setCompletionError("");
        setPhase(result.saved ? "complete" : "ready");
      })
      .catch((error) => {
        if (!cancelled) {
          setPhase("error");
          setCompletionError(error instanceof Error ? error.message : "Project readiness could not be checked.");
        }
      });
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [confirmed, readinessAttempt]);

  useEffect(() => {
    if (phase !== "complete" || !confirmed || !draftMatchesLaunch) return;
    resetDraft();
    router.refresh();
  }, [phase, confirmed, draftMatchesLaunch, resetDraft, router]);

  const selectLogo = async (file?: File) => {
    if (!file) return;
    setLogoError("");
    try {
      const logoDataUrl = await prepareLogo(file);
      if (draftMatchesLaunch) updateDraft({ logoName: file.name, logoDataUrl });
      else setRecoveryDraft((current) => ({ ...current, logoName: file.name, logoDataUrl }));
    } catch (error) {
      setLogoError(error instanceof Error ? error.message : "The logo could not be prepared.");
    }
  };

  const completeLaunch = async () => {
    if (!confirmed || phase !== "ready" || !draftHydrated || completionInFlight.current) return;
    if (!walletClient || !wallet.address || wallet.status !== "connected" || wallet.address.toLowerCase() !== confirmed.creator.toLowerCase()) {
      setCompletionError("Connect the original creator wallet on Robinhood Chain to complete this launch.");
      return;
    }
    completionInFlight.current = true;
    setPhase("saving");
    setCompletionError("");
    try {
      await uploadConfirmedProjectMetadata({ token: confirmed.token, account: wallet.address, walletClient, draft: metadataDraft });
      setPhase("complete");
      showToast("Launch complete", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Project setup could not be completed.";
      setCompletionError(message);
      setPhase("ready");
      showToast(message, "error");
    } finally {
      completionInFlight.current = false;
    }
  };

  const completionAction = async () => {
    if (wallet.status === "wrong-network") { await wallet.switchNetwork(); return; }
    if (wallet.status !== "connected") { await wallet.openWallet(); return; }
    await completeLaunch();
  };

  return <AppShell footer={false}><div className="success-page section-shell">
    <div className="success-orbit"><span><Icon name="lock" size={34} /></span><i /><i /></div>
    <span className="eyebrow">SPLIT launch workflow</span>
    <h1>{phase === "complete" ? <>LAUNCH<br /><span>COMPLETE</span></> : confirmed ? <>Complete<br /><span>your launch.</span></> : receiptReverted ? <>Launch<br /><span>failed.</span></> : <>Checking<br /><span>launch status.</span></>}</h1>
    <p>{phase === "complete" ? "Your token and project profile are ready." : confirmed ? phase === "indexing" || phase === "checking" ? "Token deployed on Robinhood Chain. Waiting for the indexer before completing its project profile." : "Token deployed on Robinhood Chain. Complete the required creator signature to publish its project profile." : verification}</p>
    {confirmed && phase === "complete" ? <><div className="success-contract glass-panel"><span className="eyebrow">Token contract address (CA)</span><code>{confirmed.token}</code><div className="success-contract-actions"><button className="button button-primary" onClick={() => void copyTokenAddress()}><Icon name="copy" size={15} /> Copy CA</button><a className="button button-outline" href={`${robinhoodMainnet.blockExplorers.default.url}/address/${confirmed.token}`} target="_blank" rel="noreferrer">View contract <Icon name="external" size={15} /></a></div></div><div className="success-actions"><Link className="button button-primary" href={`/token/${confirmed.token}`}>View token</Link></div></> : null}
    {confirmed && phase !== "complete" ? <section className="success-metadata glass-panel" aria-label="Complete launch">
      <span className="eyebrow">Final step</span>
      <h2>{phase === "saving" ? "Saving project profile..." : phase === "indexing" || phase === "checking" ? "Indexing launch..." : "Complete launch"}</h2>
      <p>Onchain token: <code>{confirmed.token}</code>. <a href={getTransactionExplorerUrl(confirmed.hash, 4663)} target="_blank" rel="noreferrer">View confirmed transaction</a></p>
      {draftMatchesLaunch ? <p>Your original launch draft is ready, including {draft.logoDataUrl ? `the selected logo (${draft.logoName || "image"})` : "the profile fields"}. It stays saved until this step succeeds.</p> : <p>The original draft is unavailable in this browser. Recover this already deployed token here; no second launch transaction is needed. Re-enter any missing profile fields and choose the original logo if you still have it.</p>}
      {!draftMatchesLaunch ? <div className="form-grid"><label>Description<textarea maxLength={360} value={recoveryDraft.description} onChange={(event) => setRecoveryDraft((current) => ({ ...current, description: event.target.value }))} /></label>{(["website", "twitter", "telegram", "discord"] as const).map((field) => <label key={field}>{field}<input type="url" value={recoveryDraft[field]} onChange={(event) => setRecoveryDraft((current) => ({ ...current, [field]: event.target.value }))} placeholder="https://" /></label>)}</div> : null}
      {!metadataDraft.logoDataUrl ? <><input ref={logoInputRef} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { void selectLogo(event.target.files?.[0]); event.currentTarget.value = ""; }} /><div className="success-metadata-actions"><button className="button button-outline" type="button" onClick={() => logoInputRef.current?.click()}>Choose logo</button><span>PNG, JPG or WebP, up to 512 KiB</span></div></> : <div className="success-metadata-actions"><Image src={metadataDraft.logoDataUrl} width={48} height={48} unoptimized alt="Launch logo preview" /><span>{metadataDraft.logoName || "Selected logo ready"}</span></div>}
      {phase === "ready" ? <button className="button button-primary" type="button" disabled={!draftHydrated} onClick={() => void completionAction()}>{wallet.status === "wrong-network" ? "Switch to Robinhood Chain" : wallet.status !== "connected" ? "Connect creator wallet" : "Complete launch"}</button> : phase === "saving" ? <button className="button button-primary" disabled><span className="spinner" />Confirm creator signature in wallet</button> : phase === "error" ? <button className="button button-outline" type="button" onClick={() => { setPhase("checking"); setReadinessAttempt((value) => value + 1); }}>Retry readiness check</button> : <p role="status">Waiting for the canonical project record. This page will continue automatically.</p>}
      {logoError ? <p className="form-error" role="alert">{logoError}</p> : null}
      {completionError ? <p className="form-error" role="alert">{completionError}</p> : null}
      <small>The creator signature is required by the existing security policy. It does not send another chain transaction. Do not clear this draft before completion.</small>
    </section> : null}
    {receiptReverted ? <button className="button button-outline" onClick={() => { if (draft.pendingLaunchTx) updateDraft({ pendingLaunchTx: "" }); router.push("/launch/review"); }}>Return to launch review</button> : null}
  </div></AppShell>;
}
