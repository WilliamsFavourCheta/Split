# Solana V1: Raydium collection and operator-managed payments

This is the low-cost Solana path. `NEXT_PUBLIC_SOLANA_ROUTER_BACKED=true` enables the preserved router adapter on **devnet only**. The default path uses Raydium LaunchLab directly; no SPLIT SBF deployment is required. Robinhood Chain and the router program remain separate future work.

## Mainnet configuration

- `NEXT_PUBLIC_SOLANA_CLUSTER=mainnet-beta`
- `NEXT_PUBLIC_SOLANA_RPC_URL`: a mainnet RPC with finalized reads
- `NEXT_PUBLIC_SPLIT_SOLANA_PLATFORM_CONFIG`: the Raydium PDA derived from the configured SPLIT platform administrator
- `NEXT_PUBLIC_SPLIT_SOLANA_FEE_WALLET`: an ordinary wallet controlled by SPLIT, distinct from creators' wallets
- `NEXT_PUBLIC_SPLIT_SOLANA_CPMM_CONFIG`: optional on mainnet; defaults to Raydium CPMM config `D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2`
- Existing Supabase public and server service-role settings, with both Solana migrations applied

The mainnet platform administrator is currently fixed in `raydium-accounts.ts`. Control of its signing key must be demonstrated before creating the PlatformConfig. Never place a private key in any app variable, browser bundle, repository, or database. The unsigned PlatformConfig instruction uses a 1% fee, 0% LaunchLab creator fee, and burns the post-graduation LP allocation. Its fee wallet must equal the configured ordinary SPLIT wallet. Verify those fields and the CPMM config again before any signature.

`/api/solana/cost` produces a fresh RPC rent and fee estimate plus an **unsigned** PlatformConfig transaction when the account does not exist. It reserves the Raydium-documented 0.1 SOL launch charge. A token's exact SDK transaction cannot be constructed against SPLIT's PlatformConfig until that account exists. The creator wallet must inspect the final transaction and mainnet cost before signing. No cost quote is an authorization to submit it.

## Launch and verification

The creator signs a message binding the token mint, metadata content, offchain payout policy, logo hash, cluster, and expiry. SPLIT stores content-addressed metadata and its signed attestation. Raydium `InitializeV2` creates the SPL mint, vaults, curve pool, and Metaplex metadata. The app verifies finalized Raydium pool, mint, PlatformConfig, metadata ownership, and the creator signature against the pool creator before adding a token to public discovery. The policy is published with the metadata URI but is **not enforced by Raydium**. Mainnet token pages link to Raydium's LaunchLab trading page while the curve is active and to Raydium Swap after graduation; SPLIT does not yet have an in-app swap builder.

The 1% SPLIT fee accrues only on LaunchLab curve trades. Graduation creates a CPMM pool using curve reserves. The 1% LaunchLab platform fee does not continue on CPMM swaps. CPMM creator-fee and locked-LP rights are separate and are not counted as SPLIT revenue in this version.

## Fee accounting

Only the configured SPLIT fee wallet can prepare a per-pool `ClaimPlatformFee` through `/solana/admin/fees`. The server requires a fresh, one-use wallet-signed challenge before returning an unsigned transaction. The wallet reviews and signs separately. After finalization, the receipt route checks the Raydium instruction, exact pool, fee wallet, destination WSOL account, and inner token transfer from that pool's quote vault. A unique receipt is then recorded. Aggregate platform vault claims are deliberately unsupported because they cannot be attributed to individual projects without a verifiable ledger.

For each verified receipt, 10% is assigned to protocol and the remaining 90% follows the creator's stated shares. The default is 36% creator, 27% liquidity reserve, 18% project treasury, and 9% community of the gross SPLIT-collected fee. Rounding is conserved in raw WSOL units. SPLIT holds the funds and must make any outgoing payments; there are no direct creator claims. An administrator can record a finalized WSOL payout only after the server verifies its transfer to the expected recipient. The public token ledger shows receipt, calculated obligations, paid amounts, signatures, and outstanding balances. Liquidity reserve is a bookkeeping obligation held by SPLIT, not onchain locked liquidity.

## Remaining release gates

1. Verify control of the mainnet platform administrator and designated fee wallet, then review the exact unsigned PlatformConfig transaction.
2. Confirm the production Supabase migrations, metadata bucket, hosting and RPC capacity. These costs are outside the onchain budget and have not been verified as free.
3. Reconcile the 0.1 SOL documented LaunchLab charge against the actual first SDK transaction once PlatformConfig exists; require a fresh USD quote below the $20 cap.
4. Exercise a full devnet sequence with a Raydium fee claim, receipt recording, payout recording, and CPMM graduation before public mainnet use. This implementation has not submitted any chain transaction.
5. Add a persistent finalized-trade indexer and historical chart backfill if SPLIT will advertise trade history or analytics beyond live pool pricing.
6. Add rate limiting to the public admin challenge and metadata upload endpoints before a broad public launch. The admin signature still gates every fee operation, but unauthenticated users can request expiring challenges.

References: [Raydium PlatformConfig](https://github.com/raydium-io/raydium-docs-v1/blob/main/products/launchlab/platform-config.mdx), [LaunchLab instructions](https://github.com/raydium-io/raydium-docs-v1/blob/main/products/launchlab/instructions.mdx), [Raydium fee comparison](https://github.com/raydium-io/raydium-docs-v1/blob/main/reference/fee-comparison.mdx).
