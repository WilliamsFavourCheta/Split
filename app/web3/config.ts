import { createConfig, http, injected } from "wagmi";
import { robinhoodMainnet, robinhoodTestnet } from "./chains";

/** This config is safe to import during SSR: transports are HTTP-only and injected access is deferred. */
export const wagmiConfig = createConfig({
  chains: [robinhoodMainnet, robinhoodTestnet],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [robinhoodMainnet.id]: http(process.env.NEXT_PUBLIC_ROBINHOOD_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"),
    [robinhoodTestnet.id]: http(process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC_URL || process.env.NEXT_PUBLIC_RH_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com"),
  },
  ssr: true,
});
