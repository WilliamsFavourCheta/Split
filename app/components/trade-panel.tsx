"use client";

import { useEffect, useState } from "react";
import { useConnection, usePublicClient, useWalletClient } from "wagmi";
import { formatEther, isAddress, parseEther, zeroAddress, type Address, type Hash } from "viem";
import type { Token } from "../data/mock";
import { getSplitFactoryAddress, productionTradingEnabled, splitHookAddresses, splitSwapExecutorAddress } from "../contracts/addresses";
import { splitFactoryAbi, erc20Abi } from "../contracts/abis";
import { RH_V4_QUOTER, splitSwapExecutorAbi, v4QuoterAbi } from "../contracts/trade-abis";
import { ensureErc20Allowance, waitForSuccessfulReceipt } from "../contracts/interactions";
import { getTransactionExplorerUrl } from "../web3/explorer";
import { toWalletErrorMessage } from "../web3/errors";
import { useWallet } from "./providers";

type Direction = "buy" | "sell";
type Quote = { amountIn: bigint; amountOut: bigint; direction: Direction; text: string };
const MAX_INPUT = (BigInt(1) << BigInt(127)) - BigInt(1);

export function TradePanel({ token }: { token: Token }) {
  const wallet = useWallet();
  const { connector } = useConnection();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: 4663 });
  const [direction, setDirection] = useState<Direction>("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(100);
  const [poolReady, setPoolReady] = useState(false);
  const [poolError, setPoolError] = useState("Checking the official SPLIT pool...");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [balance, setBalance] = useState<bigint | null>(null);
  const [pending, setPending] = useState(false);
  const [step, setStep] = useState("");
  const [tradeError, setTradeError] = useState("");
  const [confirmedHash, setConfirmedHash] = useState<Hash | null>(null);
  const factory = getSplitFactoryAddress(4663);
  const hook = splitHookAddresses[4663];
  const executor = splitSwapExecutorAddress;
  const tokenAddress = isAddress(token.address) ? token.address as Address : null;

  useEffect(() => {
    let cancelled = false;
    async function validate() {
      if (!productionTradingEnabled || !publicClient || !factory || !hook || !executor || !tokenAddress || !token.poolId || !/^0x[0-9a-fA-F]{64}$/.test(token.poolId)) {
        if (!cancelled) { setPoolReady(false); setPoolError("Trading awaits a verified SPLIT swap executor and canonical official pool."); }
        return;
      }
      try {
        const [registered, onchainPool] = await Promise.all([
          publicClient.readContract({ address: factory, abi: splitFactoryAbi, functionName: "poolForToken", args: [tokenAddress] }),
          publicClient.readContract({ address: executor, abi: splitSwapExecutorAbi, functionName: "officialPool", args: [tokenAddress] }),
        ]);
        const [key, executorPoolId] = onchainPool;
        if (registered.toLowerCase() !== token.poolId.toLowerCase() || executorPoolId.toLowerCase() !== token.poolId.toLowerCase()
          || key.currency0 !== zeroAddress || key.currency1.toLowerCase() !== tokenAddress.toLowerCase()
          || key.hooks.toLowerCase() !== hook.toLowerCase() || key.fee !== 3000 || key.tickSpacing !== 60) {
          throw new Error("The indexed pool does not match the official onchain SPLIT pool.");
        }
        if (!cancelled) { setPoolReady(true); setPoolError(""); }
      } catch (error) {
        if (!cancelled) { setPoolReady(false); setPoolError(error instanceof Error ? error.message : "Official pool verification failed."); }
      }
    }
    void validate();
    return () => { cancelled = true; };
  }, [publicClient, factory, hook, executor, tokenAddress, token.poolId]);

  useEffect(() => {
    let cancelled = false;
    async function readBalance() {
      if (!publicClient || !tokenAddress || !wallet.address) { if (!cancelled) setBalance(null); return; }
      try {
        const next = direction === "buy"
          ? await publicClient.getBalance({ address: wallet.address })
          : await publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [wallet.address] });
        if (!cancelled) setBalance(next);
      } catch { if (!cancelled) setBalance(null); }
    }
    void readBalance();
    return () => { cancelled = true; };
  }, [publicClient, tokenAddress, wallet.address, direction, confirmedHash]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      if (!poolReady || !publicClient || !tokenAddress || !hook || !amount.trim()) {
        if (!cancelled) { setQuote(null); setQuoteError(""); }
        return;
      }
      try {
        const amountIn = parseEther(amount);
        if (amountIn <= BigInt(0) || amountIn > MAX_INPUT) throw new Error("Enter a positive amount within the pool's swap limit.");
        const text = `${direction}:${amount}:${token.poolId}`;
        const { result } = await publicClient.simulateContract({
          address: RH_V4_QUOTER,
          abi: v4QuoterAbi,
          functionName: "quoteExactInputSingle",
          args: [{
            poolKey: { currency0: zeroAddress, currency1: tokenAddress, fee: 3000, tickSpacing: 60, hooks: hook },
            zeroForOne: direction === "buy",
            exactAmount: amountIn,
            hookData: "0x",
          }],
        });
        if (result[0] <= BigInt(0)) throw new Error("The official pool has insufficient liquidity for this amount.");
        if (!cancelled) { setQuote({ amountIn, amountOut: result[0], direction, text }); setQuoteError(""); }
      } catch (error) {
        if (!cancelled) { setQuote(null); setQuoteError(error instanceof Error ? error.message : "The official pool quote is unavailable."); }
      }
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [amount, direction, poolReady, publicClient, tokenAddress, hook, token.poolId]);

  const submit = async () => {
    if (pending) return;
    if (!poolReady || !quote || quote.text !== `${direction}:${amount}:${token.poolId}` || !publicClient || !executor || !tokenAddress) {
      setTradeError("The official pool quote is not ready. Wait for a fresh quote, then try again.");
      return;
    }
    if (!wallet.address || wallet.status !== "connected" || wallet.chainId !== 4663 || !walletClient || !connector) {
      setTradeError("Connect your wallet on Robinhood Chain and wait for it to finish loading before trading.");
      return;
    }
    if (balance === null || balance < quote.amountIn || (direction === "buy" && balance === quote.amountIn)) {
      setTradeError("Insufficient balance for this trade and network gas.");
      return;
    }
    const minOut = quote.amountOut * BigInt(10_000 - slippageBps) / BigInt(10_000);
    if (minOut <= BigInt(0)) { setTradeError("The quoted output is too small after slippage."); return; }
    setPending(true);
    setTradeError("");
    setConfirmedHash(null);
    try {
      if (direction === "sell") {
        await ensureErc20Allowance({
          publicClient, walletClient,
          getLiveChainId: () => connector.getChainId(),
          getLiveAccount: async () => (await connector.getAccounts())[0],
          targetChainId: 4663, token: tokenAddress, owner: wallet.address, spender: executor,
          amount, decimals: 18, onStep: setStep,
        });
      }
      const [liveChainId, accounts] = await Promise.all([connector.getChainId(), connector.getAccounts()]);
      if (liveChainId !== 4663 || accounts[0]?.toLowerCase() !== wallet.address.toLowerCase()) {
        throw new Error("The wallet account or network changed. Review the trade again.");
      }
      setStep("Confirm trade in wallet");
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const hash = direction === "buy"
        ? await walletClient.writeContract({ address: executor, abi: splitSwapExecutorAbi, functionName: "buy", args: [tokenAddress, minOut, deadline], value: quote.amountIn, account: wallet.address, chain: walletClient.chain })
        : await walletClient.writeContract({ address: executor, abi: splitSwapExecutorAbi, functionName: "sell", args: [tokenAddress, quote.amountIn, minOut, deadline], account: wallet.address, chain: walletClient.chain });
      setStep("Waiting for confirmation");
      await waitForSuccessfulReceipt(publicClient, hash);
      setConfirmedHash(hash);
      setStep("Trade confirmed");
      setAmount("");
      setQuote(null);
    } catch (error) {
      setTradeError(toWalletErrorMessage(error));
      setStep("");
    } finally {
      setPending(false);
    }
  };

  const expected = quote && quote.text === `${direction}:${amount}:${token.poolId}` ? quote : null;
  const minOut = expected ? expected.amountOut * BigInt(10_000 - slippageBps) / BigInt(10_000) : null;
  return <div className="trade-panel">
    <div className="filter-tabs" role="tablist" aria-label="Trade direction"><button role="tab" aria-selected={direction === "buy"} className={direction === "buy" ? "active" : ""} onClick={() => { setDirection("buy"); setAmount(""); setQuote(null); }}>Buy</button><button role="tab" aria-selected={direction === "sell"} className={direction === "sell" ? "active" : ""} onClick={() => { setDirection("sell"); setAmount(""); setQuote(null); }}>Sell</button></div>
    <p>Trades execute only through the registered official SPLIT pool. The 1% SPLIT hook fee and separate 0.30% pool fee are reflected in the live quote.</p>
    <label>Amount in ({direction === "buy" ? "ETH" : token.ticker})<input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.0" disabled={pending} /></label>
    <small>Wallet balance: {balance === null ? "Unavailable" : `${formatEther(balance)} ${direction === "buy" ? "ETH" : token.ticker}`}</small>
    <label>Maximum slippage<select value={slippageBps} onChange={(event) => setSlippageBps(Number(event.target.value))} disabled={pending}><option value={50}>0.5%</option><option value={100}>1%</option><option value={200}>2%</option><option value={500}>5%</option></select></label>
    <p>Estimated output: <strong>{expected ? `${formatEther(expected.amountOut)} ${direction === "buy" ? token.ticker : "ETH"}` : "—"}</strong></p>
    <p>Minimum output: <strong>{minOut ? `${formatEther(minOut)} ${direction === "buy" ? token.ticker : "ETH"}` : "—"}</strong></p>
    {!poolReady ? <p className="form-error" role="status">{poolError}</p> : quoteError ? <p className="form-error" role="status">{quoteError}</p> : null}
    {wallet.status === "wrong-network" ? <button className="button button-outline" onClick={() => void wallet.switchNetwork()}>Switch to Robinhood Chain</button> : wallet.status !== "connected" ? <button className="button button-outline" onClick={() => void wallet.openWallet()}>Connect wallet</button> : <button className="button button-primary" disabled={!expected || !minOut || minOut <= BigInt(0) || !poolReady || pending} onClick={() => void submit()}>{pending ? step : `${direction === "buy" ? "Buy" : "Sell"} ${token.ticker}`}</button>}
    {tradeError ? <p className="form-error" role="alert">{tradeError}</p> : null}
    {confirmedHash ? <p role="status">Trade confirmed. <a href={getTransactionExplorerUrl(confirmedHash, 4663)} target="_blank" rel="noreferrer">View transaction</a></p> : null}
  </div>;
}
