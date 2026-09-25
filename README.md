# SPLIT

## Supabase and protocol setup

1. Set the public Supabase URL and anon key in the existing `.env` file; keep all server-only credentials there as well.
2. Apply `supabase/migrations/202609250001_initial_schema.sql` followed by `supabase/migrations/202609250002_protocol_v1_indexing.sql` using the Supabase CLI or SQL editor.
3. For local-only visual testing, run `supabase/seed.dev.sql` explicitly. It is not part of the production migration path.
4. Set `SUPABASE_SERVICE_ROLE_KEY` only in the indexer/server environment. Never expose it through `NEXT_PUBLIC_*` variables.

`projects`, fee configuration, events, launches, and metrics are indexed/cache records. Robinhood Chain contracts remain the authoritative source for protocol state. Public RLS policies are read-only; all indexer writes go through the server-only service-role client.

The repository layer is in `app/lib/projects/repository.ts`; chain event interfaces and idempotent persistence are in `app/lib/indexer/`. Offchain metadata writes are deliberately blocked pending cryptographic wallet-signature authentication (`app/lib/auth/wallet-auth.ts`).

## EVM wallet setup

Wallet configuration uses Wagmi, Viem, and TanStack Query. Configure the existing `.env` file directly; choose `NEXT_PUBLIC_TARGET_CHAIN_ID=46630` for Robinhood Chain Testnet or `4663` for mainnet. Public RPC URLs can be overridden with `NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC_URL` and `NEXT_PUBLIC_ROBINHOOD_MAINNET_RPC_URL`. These public variables are inlined during `next build`, so rebuild after changing them. Leave the factory address variables blank until deployment.

Run `npm run dev`, click **Connect Wallet**, and approve the account request in MetaMask. A previously authorized SPLIT connection is restored silently after refresh; clicking Disconnect clears SPLIT's saved connection (it does not revoke the site's permission inside MetaMask). If the wallet is on another chain, click **Switch Network** and approve switching/adding Robinhood Chain. Verify account changes and chain changes by switching them from the wallet. The Settings page's ERC-20 balance reader is read-only and uses the selected target chain.

No SPLIT factory is deployed/configured yet. RH testnet v4 is disabled because no official compatible PoolManager has been verified. The launch review intentionally blocks contract writes until a verified stack address is configured. Do not enter private keys or seed phrases in this app or in any `NEXT_PUBLIC_*` variable.

## Protocol implementation and verification

See [docs/protocol-v1.md](docs/protocol-v1.md) for the implemented economics, v4 hook accounting, LiquidityVault custody, event/indexer behavior, deployment guards, known limitations, and release gates. The local Foundry package is pinned to `@uniswap/v4-core` 1.0.2. Use `npm run contracts:build` and `npm run contracts:test` for local protocol verification. No deployment command has been broadcast. Fork testing requires a configured read-only Robinhood mainnet RPC and a pinned block.

The indexer endpoint `/api/indexer` is designed for an external scheduler. Configure `SPLIT_INDEXER_CRON_SECRET`, `SPLIT_INDEXER_START_BLOCK`, `SPLIT_INDEXER_FINALITY_BLOCKS`, `SPLIT_INDEXER_REORG_WINDOW`, `SPLIT_INDEXER_BATCH_BLOCKS`, the four `NEXT_PUBLIC_SPLIT_*_MAINNET_ADDRESS` variables, and mainnet RPC/Supabase server credentials in the server environment. `SUPABASE_SERVICE_ROLE_KEY` must remain server-only.
