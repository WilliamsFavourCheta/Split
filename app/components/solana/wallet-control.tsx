"use client";

import { useConnect, useConnectedWallet, useDisconnect, useWallets, useWalletStatus } from "@solana/kit-plugin-wallet/react";
import { useClient } from "@solana/react";
import type { SplitSolanaClient } from "../../lib/solana/client";

export function SolanaWalletControl() {
  const client = useClient<SplitSolanaClient>();
  const status = useWalletStatus(client);
  const wallets = useWallets(client);
  const connected = useConnectedWallet(client);
  const connect = useConnect(client);
  const disconnect = useDisconnect(client);

  if (connected) return <div className="solana-wallet-control"><span title={connected.account.address}>{connected.account.address.slice(0, 5)}…{connected.account.address.slice(-5)}</span><button type="button" className="button button-outline" disabled={disconnect.isRunning} onClick={() => disconnect.dispatch()}>Disconnect</button></div>;
  return <div className="solana-wallet-control">{status === "pending" || status === "reconnecting" ? <span>Checking wallet…</span> : wallets.length ? wallets.map((wallet) => <button key={wallet.name} type="button" className="button button-primary" disabled={connect.isRunning} onClick={() => connect.dispatch(wallet)}>Connect {wallet.name}</button>) : <span>Install a Solana wallet to connect</span>}{connect.error ? <small role="alert">{connect.error instanceof Error ? connect.error.message : String(connect.error)}</small> : null}</div>;
}
