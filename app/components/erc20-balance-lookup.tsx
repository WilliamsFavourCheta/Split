"use client";

import { useState } from "react";
import { formatUnits, isAddress, type Address } from "viem";
import { useReadContract } from "wagmi";
import { erc20Abi } from "../contracts/abis";
import { targetChainId } from "../web3/chains";
import { toWalletErrorMessage } from "../web3/errors";
import { useWallet } from "./providers";

const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/** Live, read-only contract integration example. It only runs on the selected target chain. */
export function Erc20BalanceLookup() {
  const wallet = useWallet();
  const [tokenInput, setTokenInput] = useState("");
  const [tokenAddress, setTokenAddress] = useState<Address>();
  const [inputError, setInputError] = useState<string | null>(null);
  const canRead = Boolean(tokenAddress && wallet.status === "connected" && wallet.address);
  const decimalsQuery = useReadContract({
    address: tokenAddress ?? EMPTY_ADDRESS,
    abi: erc20Abi,
    functionName: "decimals",
    chainId: targetChainId,
    query: { enabled: canRead },
  });
  const balanceQuery = useReadContract({
    address: tokenAddress ?? EMPTY_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [wallet.address ?? EMPTY_ADDRESS],
    chainId: targetChainId,
    query: { enabled: canRead },
  });

  const readBalance = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (wallet.status !== "connected" || !wallet.address) {
      setInputError(wallet.status === "wrong-network" ? `Switch to ${wallet.targetChainName} before reading a balance.` : "Connect a wallet on the target network first.");
      return;
    }
    if (!isAddress(tokenInput.trim())) {
      setInputError("Enter a valid ERC-20 contract address.");
      return;
    }
    setInputError(null);
    setTokenAddress(tokenInput.trim() as Address);
  };

  const readError = decimalsQuery.error ?? balanceQuery.error;
  const balance = balanceQuery.data !== undefined && typeof decimalsQuery.data === "number"
    ? formatUnits(balanceQuery.data, decimalsQuery.data)
    : null;

  return (
    <section className="glass-panel balance-lookup">
      <span className="eyebrow">Live contract read</span>
      <h2>Read an ERC-20 balance</h2>
      <p>Read-only example using the connected account and Robinhood Chain target network. No transaction or approval is requested.</p>
      <form onSubmit={readBalance} noValidate>
        <label htmlFor="erc20-address">Token contract</label>
        <div className="balance-lookup-controls">
          <input id="erc20-address" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} aria-invalid={Boolean(inputError)} />
          <button className="button button-outline" type="submit" disabled={wallet.status === "connecting" || wallet.status === "restoring"}>Read Balance</button>
        </div>
      </form>
      {inputError ? <p className="form-error" role="alert">{inputError}</p> : null}
      {decimalsQuery.isFetching || balanceQuery.isFetching ? <p className="balance-result" aria-live="polite">Reading on {wallet.targetChainName}…</p> : null}
      {balance !== null && !readError ? <p className="balance-result" aria-live="polite">Balance: <strong>{balance}</strong> <small>· {wallet.address?.slice(0, 6)}…{wallet.address?.slice(-4)}</small></p> : null}
      {readError ? <p className="form-error" role="alert">{toWalletErrorMessage(readError)}</p> : null}
    </section>
  );
}
