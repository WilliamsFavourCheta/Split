"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { WagmiProvider, useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import type { Address } from "viem";
import { getChainName, isSupportedChainId, targetChain, targetChainId } from "../web3/chains";
import { wagmiConfig } from "../web3/config";
import { toWalletErrorMessage } from "../web3/errors";

type WalletStatus = "disconnected" | "connecting" | "restoring" | "connected" | "wrong-network" | "switching" | "disconnecting" | "rejected" | "unavailable";

type WalletContextValue = {
  status: WalletStatus;
  address: Address | null;
  chainId: number | undefined;
  chainName: string;
  targetChainName: string;
  isSupportedChain: boolean;
  error: string | null;
  openWallet: () => Promise<void>;
  disconnect: () => Promise<void>;
  switchNetwork: () => Promise<void>;
};

type LaunchDraft = {
  name: string;
  symbol: string;
  description: string;
  website: string;
  twitter: string;
  telegram: string;
  discord: string;
  logoName: string;
  supply: string;
  initialLiquidity: string;
  tokenSeedAmount: string;
  feeRate: string;
  quoteAsset: string;
  projectTreasuryAddress: string;
  communityAddress: string;
  allocations: { creator: number; liquidity: number; projectTreasury: number; community: number };
};

const DEFAULT_DRAFT: LaunchDraft = {
  name: "",
  symbol: "",
  description: "",
  website: "",
  twitter: "",
  telegram: "",
  discord: "",
  logoName: "",
  supply: "1000000000",
  initialLiquidity: "5",
  tokenSeedAmount: "1000000",
  feeRate: "1",
  quoteAsset: "ETH",
  projectTreasuryAddress: "",
  communityAddress: "",
  allocations: { creator: 40, liquidity: 30, projectTreasury: 20, community: 10 },
};

type LaunchContextValue = {
  draft: LaunchDraft;
  updateDraft: (patch: Partial<LaunchDraft>) => void;
  updateAllocation: (key: keyof LaunchDraft["allocations"], value: number) => void;
  resetDraft: () => void;
};

type ToastContextValue = { showToast: (message: string, tone?: "default" | "success" | "error") => void };

const WalletContext = createContext<WalletContextValue | null>(null);
const LaunchContext = createContext<LaunchContextValue | null>(null);
const ToastContext = createContext<ToastContextValue | null>(null);

let browserQueryClient: QueryClient | undefined;
function getQueryClient() {
  if (typeof window === "undefined") return new QueryClient();
  browserQueryClient ??= new QueryClient({
    defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 } },
  });
  return browserQueryClient;
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [draft, setDraft] = useState<LaunchDraft>(DEFAULT_DRAFT);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: string } | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const savedDraft = window.localStorage.getItem("split.launch-draft");
      if (savedDraft) {
        try {
          setDraft({ ...DEFAULT_DRAFT, ...JSON.parse(savedDraft) });
        } catch {
          window.localStorage.removeItem("split.launch-draft");
        }
      }
      setDraftHydrated(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (draftHydrated) window.localStorage.setItem("split.launch-draft", JSON.stringify(draft));
  }, [draft, draftHydrated]);

  const showToast = useCallback((message: string, tone: "default" | "success" | "error" = "default") => {
    setToast({ message, tone });
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  const launchValue = useMemo<LaunchContextValue>(() => ({
    draft,
    updateDraft: (patch) => setDraft((current) => ({ ...current, ...patch })),
    updateAllocation: (key, value) => setDraft((current) => ({
      ...current,
      allocations: { ...current.allocations, [key]: Math.max(0, Math.min(100, value || 0)) },
    })),
    resetDraft: () => setDraft(DEFAULT_DRAFT),
  }), [draft]);

  return (
    <QueryClientProvider client={getQueryClient()}>
      <WagmiProvider config={wagmiConfig} reconnectOnMount>
        <ToastContext.Provider value={{ showToast }}>
          <LaunchContext.Provider value={launchValue}>
            <WalletBridge>{children}</WalletBridge>
            {toast ? <div className={`toast toast-${toast.tone}`} role="status" aria-live="polite"><span className="status-dot" />{toast.message}</div> : null}
          </LaunchContext.Provider>
        </ToastContext.Provider>
      </WagmiProvider>
    </QueryClientProvider>
  );
}

function WalletBridge({ children }: { children: React.ReactNode }) {
  const connection = useConnection();
  const connectors = useConnectors();
  const connectMutation = useConnect();
  const disconnectMutation = useDisconnect();
  const switchMutation = useSwitchChain();
  const { showToast } = useToast();
  const [lastError, setLastError] = useState<{ kind: "rejected" | "unavailable" | "error"; message: string } | null>(null);

  const openWallet = useCallback(async () => {
    if (connectMutation.isPending) return;
    setLastError(null);
    const connector = connectors.find((item) => item.id === "io.metamask" || item.rdns === "io.metamask")
      ?? connectors.find((item) => item.type === "injected");
    if (!connector) {
      const message = "No EVM wallet was detected. Install MetaMask or another EVM-compatible wallet, then refresh this page.";
      setLastError({ kind: "unavailable", message });
      showToast(message, "error");
      return;
    }

    try {
      // This runs only from an explicit click. Wagmi's injected connector requests wallet permissions,
      // which opens the wallet's account authorization flow instead of silently adopting a default account.
      const connected = await connectMutation.mutateAsync({ connector, chainId: targetChainId });
      if (connected.chainId === targetChainId) {
        showToast(`Wallet connected to ${targetChain.name}.`, "success");
      } else {
        showToast(`Wallet connected to ${getChainName(connected.chainId)}. Switch to ${targetChain.name} to continue.`, "error");
      }
    } catch (error) {
      const message = toWalletErrorMessage(error);
      const kind = /no evm wallet|no wallet was detected/i.test(message)
        ? "unavailable"
        : /rejected/i.test(message)
          ? "rejected"
          : "error";
      setLastError({ kind, message });
      showToast(message, "error");
    }
  }, [connectMutation, connectors, showToast]);

  const switchNetwork = useCallback(async () => {
    if (switchMutation.isPending) return;
    setLastError(null);
    try {
      const liveChainId = connection.connector ? await connection.connector.getChainId() : undefined;
      if (liveChainId === targetChainId) {
        showToast(`Wallet is already on ${targetChain.name}.`, "success");
        return;
      }
      // Wagmi handles wallet_switchEthereumChain and, on 4902, wallet_addEthereumChain
      // using the RPC, currency, and explorer data from the configured chain.
      await switchMutation.mutateAsync({ chainId: targetChainId });
      showToast(`Switched to ${targetChain.name}.`, "success");
    } catch (error) {
      const message = toWalletErrorMessage(error);
      setLastError({ kind: /rejected/i.test(message) ? "rejected" : "error", message });
      showToast(message, "error");
    }
  }, [connection.connector, showToast, switchMutation]);

  const disconnect = useCallback(async () => {
    if (disconnectMutation.isPending) return;
    if (!connection.connector) return;
    setLastError(null);
    try {
      await disconnectMutation.mutateAsync({ connector: connection.connector });
      showToast("Disconnected from SPLIT. Your wallet remains installed and authorized in its settings.");
    } catch (error) {
      const message = toWalletErrorMessage(error);
      setLastError({ kind: "error", message });
      showToast(message, "error");
    }
  }, [connection.connector, disconnectMutation, showToast]);

  let status: WalletStatus;
  if (disconnectMutation.isPending) status = "disconnecting";
  else if (switchMutation.isPending) status = "switching";
  else if (connectMutation.isPending || connection.status === "connecting") status = "connecting";
  else if (connection.status === "reconnecting") status = "restoring";
  else if (connection.isConnected) status = connection.chainId === targetChainId ? "connected" : "wrong-network";
  else if (lastError?.kind === "unavailable") status = "unavailable";
  else if (lastError?.kind === "rejected") status = "rejected";
  else status = "disconnected";

  const value = useMemo<WalletContextValue>(() => ({
    status,
    address: connection.status === "connected" ? connection.address : null,
    chainId: connection.status === "connected" ? connection.chainId : undefined,
    chainName: getChainName(connection.status === "connected" ? connection.chainId : undefined),
    targetChainName: targetChain.name,
    isSupportedChain: connection.status === "connected" ? isSupportedChainId(connection.chainId) : false,
    error: connection.isConnected ? null : lastError?.message ?? null,
    openWallet,
    disconnect,
    switchNetwork,
  }), [status, connection, lastError, openWallet, disconnect, switchNetwork]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet must be used inside AppProviders");
  return value;
}

export function useLaunchDraft() {
  const value = useContext(LaunchContext);
  if (!value) throw new Error("useLaunchDraft must be used inside AppProviders");
  return value;
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used inside AppProviders");
  return value;
}
