"use client";

import { useConnect, useConnectedWallet, useDisconnect, useWallets, useWalletStatus } from "@solana/kit-plugin-wallet/react";
import { useClient } from "@solana/react";
import { useState } from "react";
import type { SplitSolanaClient } from "../../lib/solana/client";

export function SolanaWalletControl() {
  const client = useClient<SplitSolanaClient>();
  const status = useWalletStatus(client);
  const wallets = useWallets(client);
  const connected = useConnectedWallet(client);
  const connect = useConnect(client);
  const disconnect = useDisconnect(client);
  const [networkOpen, setNetworkOpen] = useState(false);
  const [selectedSolana, setSelectedSolana] = useState(false);

  if (connected) return <div className="solana-wallet-control"><span title={connected.account.address}>{connected.account.address.slice(0, 5)}…{connected.account.address.slice(-5)}</span><button type="button" className="button button-outline" disabled={disconnect.isRunning} onClick={() => disconnect.dispatch()}>Disconnect</button></div>;
  return <div className="solana-wallet-control">
    <button type="button" className="button button-primary" onClick={() => { setNetworkOpen(true); setSelectedSolana(false); }}>Connect Wallet</button>
    {networkOpen ? <div role="dialog" aria-modal="true" aria-label="Choose network" className="glass-panel solana-form-card solana-network-dialog">
      <h2>Choose network</h2>
      {!selectedSolana ? <>
        <button type="button" className="button button-primary" onClick={() => setSelectedSolana(true)}>Solana · V2 preview</button>
        <button type="button" className="button button-outline" disabled>Robinhood Chain · V1 live</button>
      </> : status === "pending" || status === "reconnecting" ? <span>Checking wallet…</span>
        : wallets.length ? wallets.map((wallet) => <button key={wallet.name} type="button" className="button button-primary"
          disabled={connect.isRunning} onClick={() => { connect.dispatch(wallet); setNetworkOpen(false); }}>Connect {wallet.name}</button>)
          : <span>Install a compatible Solana wallet to connect.</span>}
      <button type="button" className="button button-outline" onClick={() => setNetworkOpen(false)}>Close</button>
      {connect.error ? <small role="alert">{connect.error instanceof Error ? connect.error.message : String(connect.error)}</small> : null}
    </div> : null}
  </div>;
}
