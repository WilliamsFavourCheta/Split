# SPLIT Protocol v1 (implementation status)

This document describes the contracts currently in this repository. It is not a deployment approval or an audit. No SPLIT contracts have been broadcast to Robinhood Chain.

## Architecture

The pinned local dependency is Uniswap `v4-core` **1.0.2** (Solidity 0.8.26), installed from the package lock. No v4-periphery dependency is required by the current contracts. The implementation uses the pinned core `Hooks`, `PoolManager`, `Currency`, `PoolKey`, `PoolId`, and `BalanceDelta` code as its source of truth.

The stack consists of `SplitFactory`, fixed-supply `SplitToken`, `SplitHook`, `SplitFeeRouter`, and `SplitLiquidityVault`. `SplitFactory` is the only launch/configuration authority; its treasury is immutable. There is no owner or post-deployment admin role, pause, split setter, mint authority, or fund-rescue function.

V1 uses native ETH (`Currency.wrap(address(0))`) as the sole quote currency. The project token sorts as currency1. The factory creates a standard 1,000,000,000-token ERC-20 with no post-launch minting or transfer tax, initializes a 30-basis-point v4 pool, and seeds it with the creator's native ETH and token amounts. The launch supplies the initial ratio directly; there is no bonding curve or graduation process.

### Hook permissions and fee accounting

The hook requires address low bits `0x44` under mask `0x3fff`: `afterSwap` and `afterSwapReturnDelta`. All other callback permissions are disabled. It charges a fixed 100 bps SPLIT fee, separate from the pool's 30 bps LP fee.

For exact-input swaps, the fee currency is the output currency. For exact-output swaps, it is the input currency. In either direction, the hook reads the corresponding post-swap `BalanceDelta` amount, computes `floor(tradedAmount * 100 / 10_000)`, returns a positive hook delta in that currency, and asks PoolManager to `take` that amount to the hook. Under the pinned `Hooks.afterSwap` logic, the returned hook delta is subtracted from the swap caller's delta and booked as a debt of the hook; `take` settles that hook debt into the hook's balance during the PoolManager unlock. This is why the returned delta and `take` pair are both required; the event alone is not the accounting proof.

The fee remains accrued in `SplitHook` per `(PoolId, Currency)`. A later permissionless `flush(poolId, currency)` sends it to the router. Routing is deliberately not called from the swap callback. Creator, Treasury, and Community amounts are accounted as pull claims without calling those recipients. If vault credit fails, the flush reverts atomically and accrual remains available for retry. A failed recipient claim affects only the claimant: the reverted transaction preserves that recipient's balance for retry, and other fees continue processing.

The router floors creator, treasury, and community allocations independently. All residual units, including rounding dust, are assigned to the vault. The three recipient claims plus liquidity credit sum exactly to gross fee. Configuration is immutable per pool. Claims are scoped to `(PoolId, recipient, Currency)`; recipients cannot claim another wallet's funds or another project's balance.

### Liquidity custody

The vault controls the initial full-range v4 position (`[-887220, 887220]`) and retains the position salt/liquidity record. The creator receives neither position custody nor a withdrawal/transfer/collect path. Fee liquidity allocations are held as pending balances isolated by pool and currency; v1 does not invent the missing pair asset, swap balances, or automatically alter a position. There is no admin escape hatch. The current implementation has no liquidity migration/emergency mechanism; any future mechanism needs a separate design that preserves project liquidity and cannot route it to the creator.

## Events and indexer

Canonical contract events include `TokenLaunched`, `SplitConfigured`, `FeesAccrued`, `FeesAllocated` (gross plus all four allocation amounts), `FeesClaimed` (successful recipient transfer only), `LiquidityCredited`, `PoolRegistered`, `FeesFlushed`, and `SeedPositionCreated`. Allocation is not payment: Creator, Treasury, and Community shares are separately claimable per pool and currency, while liquidity is credited to the non-withdrawable vault. Supabase is only an indexed/queryable copy; it does not authorize transactions or prove funds moved.

The app indexer stores `(chain_id, tx_hash, log_index)`, block number/hash, and canonical flags, processes finalized bounded ranges, replays an overlap, and marks orphaned rows noncanonical. `FeesAllocated` and `FeesClaimed` are stored separately; `LiquidityCredited` is also indexed. The protected POST endpoint at `/api/indexer` requires `SPLIT_INDEXER_CRON_SECRET`; a scheduler must be configured externally. The migration files must be applied in order before indexing. Indexing currently targets RH mainnet only and needs deployed SPLIT addresses and RPC/Supabase configuration. The dashboard treats accrued, allocated, and claimed totals as indexed history, but reads the hook's currently-unprocessed amount, recipient claimable balances, and vault's pending liquidity directly from configured contracts.

## Hook deployment

`contracts/script/DeploySplit.s.sol` checks the manager has code, rejects RH testnet (46630), verifies the exact official RH mainnet PoolManager address (`0x8366a39cc670b4001a1121b8f6a443a643e40951`), and additionally requires `ALLOW_RH_MAINNET_DEPLOYMENT=true` on chain 4663. Local Anvil chains 31337/1337 are accepted for deployment simulations. It predicts the mutually-referencing stack, searches for a CREATE2 salt in the Forge script simulation, and passes that salt to the on-chain deployer, which verifies `0x44` permissions. The script has not been run against a live chain.

The official-compatible RH testnet v4 PoolManager is not verified, so the frontend factory address remains unset there. Use pinned local v4 tests/Anvil now; run an RH mainnet fork test only after providing a pinned block and RPC. Do not substitute an unofficial manager.

## Application integration and limitations

The launch flow submits a factory transaction only when a verified factory address is configured for the connected chain. The frontend waits for the receipt and launch event, then polls indexed project data; it does not create a Supabase-only launch. Explore, token, account, and manage pages consume indexed chain data and show empty/not-indexed states rather than presenting demo launches as real state. Offchain metadata writes remain disabled pending wallet-signature authentication.

V1 limitations:

- Only pools registered by this factory are charged; trading the same token through unrelated pools bypasses SPLIT.
- One quote currency (native ETH), one static LP fee tier, fixed supply, immutable splits.
- No bonding curve, graduation, auto-rebalancing, auto-swaps, or deployment of subsequent liquidity credits.
- Small swaps may calculate a zero fee due to integer rounding; integer dust in routing goes to liquidity.
- RH testnet is disabled until an official compatible v4 deployment is verified.
- No mainnet deployment has been made; contracts are unaudited and not production-ready.

## Local verification and release gates

Run `npm run contracts:build` and `npm run contracts:test` for compilation, local PoolManager lifecycle/swap tests, fuzz cases, and invariants. `testRHMainnetPinnedForkLaunchSeedSwapAndFeeSettlement` is an opt-in fork lifecycle check and skips unless both `RH_MAINNET_FORK_RPC_URL` (read-only) and `RH_MAINNET_FORK_BLOCK` (pinned) are provided. It was skipped in this environment. Fork simulations never broadcast. For UI checks use `npm run lint` and `npm run build` (the latter includes TypeScript checking). Before any deployment: obtain an independent Solidity security review, run the pinned-block fork test, review gas/DoS/rounding/recipient behavior, apply Supabase migrations, configure/operate the indexer, verify artifact/source reproducibility and manager bytecode, set all deployment env vars, and obtain explicit user approval. Never pass a funded production key to an unattended script.
