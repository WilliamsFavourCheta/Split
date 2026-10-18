import { createClient } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { walletSigner } from "@solana/kit-plugin-wallet";

export const solanaCluster = process.env.NEXT_PUBLIC_SOLANA_CLUSTER === "mainnet-beta" ? "mainnet-beta" : "devnet";
export const solanaRpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL
  || (solanaCluster === "mainnet-beta" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");

export const solanaClient = createClient()
  .use(walletSigner({ chain: solanaCluster === "mainnet-beta" ? "solana:mainnet" : "solana:devnet" }))
  .use(solanaRpc({ rpcUrl: solanaRpcUrl }));

export type SplitSolanaClient = Awaited<typeof solanaClient>;
