# SPLIT Protocol v1 (implementation status)

This document describes the contracts currently in this repository. It is not a deployment approval or an audit. No SPLIT contracts have been broadcast to Robinhood Chain.

## Architecture

The pinned local dependency is Uniswap `v4-core` **1.0.2** (Solidity 0.8.26), installed from the package lock. No v4-periphery dependency is required by the current contracts. The implementation uses the pinned core `Hooks`, `PoolManager`, `Currency`, `PoolKey`, `PoolId`, and `BalanceDelta` code as its source of truth.

The V1.1 candidate stack consists of `SplitFactory`, fixed-supply `SplitToken`, `SplitHook`, `SplitFeeRouter`, and `SplitLiquidityVault`. The global Protocol Treasury is immutable in the factory/router; each pool's Project Treasury destination and its BPS share are immutable configuration. There is no owner or post-deployment admin role, pause, split setter, mint authority, or fund-rescue function.

V1 uses native ETH (`Currency.wrap(address(0))`) as the sole quote currency. The project token sorts as currency1. The factory creates a standard 1,000,000,000-token ERC-20 with no post-launch minting or transfer tax, initializes a 30-basis-point v4 pool, and seeds it with the creator's native ETH and token amounts. The launch supplies the initial ratio directly; there is no bonding curve or graduation process.

### Hook permissions and fee accounting

The hook requires address low bits `0x44` under mask `0x3fff`: `afterSwap` and `afterSwapReturnDelta`. All other callback permissions are disabled. It charges a fixed 100 bps SPLIT fee, separate from the pool's 30 bps LP fee.

For exact-input swaps, the fee currency is the output currency. For exact-output swaps, it is the input currency. In either direction, the hook reads the corresponding post-swap `BalanceDelta` amount, computes `floor(tradedAmount * 100 / 10_000)`, returns a positive hook delta in that currency, and asks PoolManager to `take` that amount to the hook. Under the pinned `Hooks.afterSwap` logic, the returned hook delta is subtracted from the swap caller's delta and booked as a debt of the hook; `take` settles that hook debt into the hook's balance during the PoolManager unlock. This is why the returned delta and `take` pair are both required; the event alone is not the accounting proof.

The fee remains accrued in `SplitHook` per `(PoolId, Currency)`. A later permissionless `flush(poolId, currency)` sends it to the router. Routing is deliberately not called from the swap callback. `SplitFeeRouter.PROTOCOL_SHARE_BPS = 1000` first reserves 10% of the gross collected SPLIT fee as global protocol revenue; the remaining 90% is allocated by the project's 10,000-BPS split. For example, a 100-unit fee routes 10 to Protocol Treasury; a 40/30/20/10 project split routes 36 to Creator, 27 to LiquidityVault, 18 to that project's Project Treasury, and 9 to Community. The global address comes from immutable `protocolTreasury`; each project's independent address comes from `LaunchParams.projectTreasury`. Neither is substituted for the other. Protocol revenue is pull-claimed only by the immutable global Protocol Treasury; allocations make no call to that treasury. Creator, Project Treasury, and Community amounts are separately pull-claimable. If vault credit fails, the flush reverts atomically and accrual remains available for retry. A failed recipient claim affects only that claim and preserves its balance for retry.

The router floors `gross * 1000 / 10000` for the protocol share; any fractional remainder stays in the project 90%. It then floors Creator, Project Treasury, and Community amounts independently from the project amount. All project-side residual units go to the irrevocable LiquidityVault allocation. Protocol claimable + three project recipient claims + liquidity credit sum exactly to gross fee. Project configuration is immutable per pool. Claims are scoped by pool and currency; project recipient claims also bind the caller address.

### Launch fee

`SplitFactory.LAUNCH_FEE` is fixed at `0.0005 ETH` and is separate from `LaunchParams.seedQuoteAmount`. `launch()` requires `msg.value >= LAUNCH_FEE + seedQuoteAmount`, credits the fee to the router's launch-fee ledger, and sends only the seed quote amount to the vault. The immutable Protocol Treasury later pulls the accumulated launch fees. No treasury callback occurs while launching. Any revert later in the launch transaction atomically rolls back the fee credit, token, pool state, and seed; excess `msg.value` and seed amount unused by liquidity are refunded to the creator, and a failed refund reverts the entire launch.

### Liquidity custody

The vault controls the initial full-range v4 position (`[-887220, 887220]`) and retains the position salt/liquidity record. The creator receives neither position custody nor a withdrawal/transfer/collect path. Fee liquidity allocations are held as pending balances isolated by pool and currency; v1 does not invent the missing pair asset, swap balances, or automatically alter a position. There is no admin escape hatch. The current implementation has no liquidity migration/emergency mechanism; any future mechanism needs a separate design that preserves project liquidity and cannot route it to the creator.

## Events and indexer

V1.1 adds `LaunchProtocolFeeCharged`, `ProtocolFeesClaimed`, `ProtocolLaunchFeeCredited`, and `ProtocolLaunchFeesClaimed`. `FeesAllocated` contains gross fee, protocol share, Creator, Project Treasury, Community, and Liquidity amounts. Allocation is not payment: global protocol swap revenue and project recipient amounts are pull-claimable; liquidity is credited to the non-withdrawable vault. Supabase is only an indexed/queryable copy; it does not authorize transactions or prove funds moved.

The app indexer stores `(chain_id, tx_hash, log_index)`, block number/hash, and canonical flags, processes finalized bounded ranges, replays an overlap, and marks orphaned rows noncanonical. `FeesAllocated` and `FeesClaimed` are stored separately; `LiquidityCredited` is also indexed. A `FeesClaimed` log identifies an address but not which project role it represents; the indexer records it as `project_recipient` rather than guessing Creator versus Project Treasury. Protocol swap claims retain their explicit protocol type. The protected POST endpoint at `/api/indexer` requires `SPLIT_INDEXER_CRON_SECRET`; a scheduler must be configured externally. The migration files must be applied in order before indexing. Indexing currently targets RH mainnet only and needs deployed SPLIT addresses and RPC/Supabase configuration. The dashboard treats accrued, allocated, and claimed totals as indexed history, but reads the hook's currently-unprocessed amount, recipient claimable balances (including protocol claims), and vault's pending liquidity directly from configured contracts.

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
