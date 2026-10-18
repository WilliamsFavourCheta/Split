# SPLIT Solana migration

Status: implementation in progress on `feature/solana-launchpad`. The existing Robinhood Chain deployment and its tokens remain live on their original chain. The `/solana` routes are a development preview; they do not submit launch transactions.

## User flow to complete

1. Connect a Solana Wallet Standard wallet and select the intended cluster.
2. Enter token metadata, the four immutable shares, recipient wallets, and a supported graduation target. Validate all values against Raydium's current `GlobalConfig` and SPLIT's `PlatformConfig` on-chain.
3. Generate a fresh mint signer in the browser. Register the split with the creator, mint, and SPLIT platform authority signatures before the Raydium pool can trade. Publish metadata to durable storage. Initialize a Raydium LaunchLab CPMM-migration curve. Show the transaction sequence, estimated rent/fees, simulation results, and confirmed signatures. Auto-save the project only after finalized on-chain verification.
4. Index LaunchLab pool state, trades, fee claims, graduation, and the CPMM pool. Show a live price chart with USD and market-cap modes and explicit freshness/error states. Route the creator from launch success to its token page and creator dashboard.
5. Claim each pool's LaunchLab platform fee through a SPLIT program CPI signed by its platform fee wallet PDA. Place the received WSOL in the registered project's vault and allocate it atomically. SPLIT receives 1% of swap input where its platform fee applies. Of that collected fee, 10% goes to the protocol; the remaining 90% is divided by the immutable project percentages. Creator, project treasury, and community pull-claim their WSOL. The liquidity allocation stays in the vault without a withdrawal instruction. Claims must display available amounts and transaction results for the connected eligible wallet.
6. After graduation, account for Raydium CPMM and locked-LP fee behavior separately. Do not describe ordinary Raydium LP/protocol fees as SPLIT revenue. If post-graduation SPLIT fees are promised, integrate and verify the appropriate CPMM creator fee or locked LP Fee Key claim path before enabling that promise.

## On-chain work in this branch

`solana-program/programs/split_fee_router` establishes immutable per-mint recipients and splits, a dedicated WSOL vault, exact integer allocation, and recipient claims. Registration is restricted to the program's upgrade-authority-initialized platform authority and the creator plus fresh mint signer. The protocol treasury is set once by the upgrade authority. Rounding dust belongs to liquidity, matching the Robinhood Chain router. Tokens sent into the vault can be allocated, but a direct vault transfer is not proof that a Raydium fee was claimed. The Raydium claim CPI and authenticated pool binding are required before any launch or fee reporting goes live.

The `declare_id!` value and Anchor.toml program address are development placeholders. Deploy a unique, controlled program ID and sync them before any cluster deployment. No mainnet program or platform configuration has been deployed by this branch.

## Launch gates

- Confirm Raydium program IDs and current `GlobalConfig`, PlatformConfig fee rate, quote mint, migration type, target range, and supported curve parameters against the target cluster. Do not hardcode a target that the selected configuration rejects.
- Implement and test atomic Raydium claims, pool-to-project binding, account-owner checks, idempotent indexing, and post-graduation fee handling. Audit the upgrade, treasury, fee wallet, and Fee Key controls.
- Run program unit and local validator integration tests, devnet end-to-end wallet tests through launch, swap, graduation, claim, dashboard, and chart. Verify transaction simulation and error paths.
- Review dependency audit findings and use Node 22.12+ with a current Solana toolchain for deployment builds. Local Rust unit tests use `cargo +stable test --manifest-path solana-program/Cargo.toml`.
- The current production dependency audit reports advisories in the pinned Next.js release and in Raydium's legacy Solana dependencies. Review patched versions and SDK compatibility before deployment; do not apply a broad automatic dependency rewrite.
- Only then configure mainnet RPC, Supabase migrations/indexer, durable metadata storage, program IDs, Raydium PlatformConfig, platform signer arrangement, monitoring, and production deployment.

## Current references

- [Solana React integration](https://solana.com/docs/frontend/react-hooks)
- [Raydium LaunchLab code demos](https://github.com/raydium-io/raydium-docs-v1/blob/main/products/launchlab/code-demos.mdx)
- [Raydium PlatformConfig](https://github.com/raydium-io/raydium-docs-v1/blob/main/products/launchlab/platform-config.mdx)
- [Raydium LaunchLab IDL](https://github.com/raydium-io/raydium-idl/blob/master/raydium_launchpad/raydium_launchpad.json)
