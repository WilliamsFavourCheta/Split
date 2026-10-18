# SPLIT Solana migration

Status: implementation in progress on `feature/solana-launchpad`. The existing Robinhood Chain deployment and its tokens remain live on their original chain. The `/solana` routes are a development preview; they do not submit launch transactions.

## User flow to complete

1. Connect a Solana Wallet Standard wallet and select the intended cluster.
2. Enter token metadata, the four immutable shares, recipient wallets, and a supported graduation target. Validate all values against Raydium's current `GlobalConfig` and SPLIT's `PlatformConfig` on-chain.
3. Generate a fresh mint signer in the browser. Register the split with the creator and mint signatures while both mint and Raydium pool are still uninitialized. Publish metadata to durable storage. Initialize a Raydium LaunchLab CPMM-migration curve. Show the transaction sequence, estimated rent/fees, simulation results, and confirmed signatures. Auto-save the project only after finalized on-chain verification.
4. Index LaunchLab pool state, trades, fee claims, graduation, and the CPMM pool. Show a live price chart with USD and market-cap modes and explicit freshness/error states. Route the creator from launch success to its token page and creator dashboard.
5. Claim each pool's LaunchLab platform fee through a SPLIT program CPI signed by its platform fee wallet PDA. Place the received WSOL in the registered project's vault and allocate it atomically. SPLIT receives 1% of swap input where its platform fee applies. Of that collected fee, 10% goes to the protocol; the remaining 90% is divided by the immutable project percentages. Creator, project treasury, and community pull-claim their WSOL. The liquidity allocation stays in the vault without a withdrawal instruction. Claims must display available amounts and transaction results for the connected eligible wallet.
6. After graduation, account for Raydium CPMM and locked-LP fee behavior separately. Do not describe ordinary Raydium LP/protocol fees as SPLIT revenue. If post-graduation SPLIT fees are promised, integrate and verify the appropriate CPMM creator fee or locked LP Fee Key claim path before enabling that promise.

## On-chain work in this branch

`solana-program/programs/split_fee_router` establishes immutable per-mint recipients and splits, a dedicated WSOL vault, exact integer allocation, and recipient claims. Registration requires the creator and fresh mint signer and rejects an existing mint or Raydium pool. The protocol treasury, Raydium program, and platform config are set once by the upgrade authority. Rounding dust belongs to liquidity, matching the Robinhood Chain router. The claim instruction derives the project's Raydium pool PDA, invokes Raydium's per-pool `ClaimPlatformFee` with SPLIT's fee-wallet PDA, transfers only the WSOL received in that CPI to the project's vault, and allocates it atomically. Direct vault transfers are ignored. This CPI needs local validator tests against the actual Raydium deployment before launch or fee reporting goes live. The fee-wallet WSOL associated token account must exist before the first claim.

The `declare_id!` value and Anchor.toml program address are development placeholders. Deploy a unique, controlled program ID and sync them before any cluster deployment. No mainnet program or platform configuration has been deployed by this branch.

Proposed public deployment addresses supplied by the project owner: Raydium PlatformConfig admin `9FAqrQLSbX8Sz6wu1u3QovunR3jFgWa2RfvQpJXFAUBu`; 10% protocol treasury `HSrCeMpFh5VnApPRPHJvDPTxUEdM7hQi5DhAMqWDcasn`. Both decode to 32-byte Solana public keys. Ownership/control and the ability of the treasury to hold and claim WSOL still require a signed devnet verification. These addresses do not authorize a transaction by themselves.

The read-only `verifySolanaLaunch` gate derives the Raydium PlatformConfig PDA from the supplied admin and checks the SPLIT protocol treasury against the supplied 10% wallet. At one finalized RPC context it checks the registered project, Raydium pool, protocol, and PlatformConfig owners and discriminators, mint and creator binding, immutable share total, CPMM migration type, 1% platform fee rate, zero separate creator fee, and SPLIT's fee-wallet PDA. It does not persist a project row yet. Raydium's admin can update its PlatformConfig after launch; the indexer and claim UI must continue to detect changes, not assume this initial verification remains true forever.

`supabase/migrations/202610180001_solana_launchpad.sql` defines separate case-sensitive Solana project, trade, fee, price, and cursor tables. It has not been applied to the hosted Supabase project. The indexer must use finalized slots and write with the service role; browser users have read-only access to finalized public records.

`/solana/explore` and `/solana/token/[mint]` read those tables and show a finalized trade list plus a USD price/market-cap chart. The indexer must derive each historical USD sample using the SOL/USD rate and circulating supply valid at that sample's slot. These pages show an unavailable/empty state until the migration and indexer are active. They do not manufacture chart motion from a clock or current SOL/USD price. The on-chain claim UI and trading controls remain to be built.

Raydium's current migration description subtracts the accrued `platform_fee` from the quote amount moved to CPMM, leaving that fee in the LaunchLab quote vault. Its per-pool `ClaimPlatformFee` drains the pool's recorded `platform_fee`. This suggests the per-project claim path can still collect pre-graduation accrual after migration, but the branch has not validated it with a live Raydium program and must not count CPMM trading fees as continuing SPLIT revenue. See the [Raydium launch instructions](https://github.com/raydium-io/raydium-docs-v1/blob/main/products/launchlab/instructions.mdx).

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
