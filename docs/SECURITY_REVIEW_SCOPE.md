# SPLIT Protocol v1 — Independent Security Review Scope

**Review candidate:** `split-v1-security-review` (see the tag target for the exact frozen Git commit).
**Status:** frozen for independent review; this document is scope and test evidence, not an audit or deployment approval.

## What SPLIT does

SPLIT v1 is a token launchpad for Robinhood Chain using Uniswap v4. A token launch creates a fixed-supply token, one registered hooked pool, a vault-owned initial liquidity position, and an immutable allocation for that pool. The hook charges an additional fixed 1% SPLIT fee on swaps in that registered pool, in addition to the pool's 0.30% LP fee. Exact-input swaps pay the SPLIT fee in the output currency; exact-output swaps pay it in the input currency. The fee is floored to integer currency units. The hook accrues fees by `(PoolId, Currency)` and anyone may flush an accrual to the router. Creator, Treasury, and Community allocations are pull claims; the Liquidity allocation is credited to the non-withdrawable `SplitLiquidityVault`.

V1 accepts native ETH as its only quote asset. It has no bonding curve or graduation mechanism. Each launch has a fixed 1,000,000,000-token supply; all tokens are minted once in the token constructor, with the seed moved into the vault position and the remainder delivered to the creator during the launch transaction.

## Files and dependencies in scope

Review all security-critical SPLIT code, including its tests and deployment helpers:

- `contracts/src/SplitFactory.sol`
- `contracts/src/SplitToken.sol`
- `contracts/src/SplitHook.sol`
- `contracts/src/SplitFeeRouter.sol`
- `contracts/src/SplitLiquidityVault.sol`
- `contracts/script/DeploySplit.s.sol`
- `contracts/script/SplitStackDeployer.sol`
- `contracts/test/SplitProtocol.t.sol`
- `foundry.toml`, `package.json`, and `package-lock.json` (compiler, build settings, and pinned dependency records)

The Solidity import closure also includes the pinned Uniswap v4-core package and its transitively imported source. Direct v4-core imports include `interfaces/IPoolManager.sol`, `interfaces/IHooks.sol`, `interfaces/callback/IUnlockCallback.sol`, `types/Currency.sol`, `types/PoolKey.sol`, `types/PoolId.sol`, `types/BalanceDelta.sol`, `types/PoolOperation.sol`, and `libraries/TickMath.sol`, `FullMath.sol`, and `SafeCast.sol`.

Dependency pins recorded in this candidate:

- Uniswap `@uniswap/v4-core` **1.0.2**, pinned in `package-lock.json` to `https://registry.npmjs.org/@uniswap/v4-core/-/v4-core-1.0.2.tgz`, integrity `sha512-X15Tm2wWd+USAzEExMbo+g9naA6QN6mPgWm0MzDwRNlOfaNlepfUpSyt9RSrUfEODspwbyWbcLg6t5nwc/e7lg==`. This package release is the source pin; no Git commit is recorded by npm for this install.
- Uniswap v4-periphery: **not used / no dependency** in the current contract build.
- OpenZeppelin: **not used / no dependency** in the current contract import closure.
- Foundry Solidity dependency packages: none separately installed; v4-core is resolved from `node_modules` by `foundry.toml`. The checked-in npm Forge executable package is `@foundry-rs/forge-win32-amd64` **1.7.1**; the executed Forge reports commit `4072e48705af9d93e3c0f6e29e93b5e9a40caed8`. Solidity compiler is **0.8.26**.

## Accounting and hook mechanics

The Round 2 candidate hook is deployed at an address whose low 14 bits match `0x2044`, enabling `beforeInitialize`, `afterSwap`, and `afterSwapReturnDelta`. `beforeInitialize` accepts only the exact PoolId registered by the immutable factory, with the factory as the PoolManager's original initializer, and consumes a one-shot authorization. In `afterSwap`, SPLIT selects the input or output side from `amountSpecified` and `zeroForOne`, takes the absolute corresponding `BalanceDelta` amount, and calculates `floor(amount * 100 / 10_000)`. For nonzero fees it calls `PoolManager.take` to the hook and returns a positive hook delta in that currency. Under the pinned v4-core hook-delta accounting, the returned delta adjusts the swap caller's balance delta and creates the hook's corresponding obligation; `take` settles that obligation into the hook's balance during the manager's unlock/flash-accounting flow. Review both operations together, not as independent fee collection.

The hook does not call recipients during a swap. `flush(poolId, currency)` clears the stored accrual before routing; if routing fails, transaction atomicity reverts that clear and the accrual remains retryable. The router checks that the caller is the hook, verifies the one-time pool split, calculates Creator/Treasury/Community floors, and assigns all residual units to Liquidity. It credits recipient claims by `(PoolId, recipient, Currency)` and credits the vault. `claim(poolId, currency)` can only claim for `msg.sender`; it clears the balance before transfer under a reentrancy lock. A failed transfer reverts the claim and restores its accounting. The vault tracks liquidity by pool and currency and owns the initial full-range v4 position.

## Critical invariants

Review and test at least these properties:

- Allocation always totals 10,000 BPS.
- A pool split and its destinations cannot change after launch.
- A fee cannot be allocated twice; a claim cannot succeed twice.
- A caller cannot claim another recipient's balance.
- A failed claim preserves that recipient's claimable balance.
- A malicious recipient cannot block other allocations or claims.
- Project balances remain isolated by pool; currency balances remain isolated by currency.
- Accounting creates no value and loses no accounted value across accrual, allocation, claim, and vault credit.
- Neither creator nor admin can withdraw the seeded LP position.
- Ongoing liquidity allocations cannot be claimed.
- The project token cannot mint after launch.

## Trust and privilege model

SPLIT contracts expose no post-deployment owner/admin role, upgrade authority, pause authority, rescue authority, mint authority, split modification authority, destination modification authority, or LP withdrawal/removal/transfer/collect function. The token's fixed supply is created in its constructor. The factory has immutable references/configuration and permits launches; it is not an upgrade or administrative proxy. The factory can configure a split once and register a launch pool during launch. The router, hook, and vault enforce their respective factory/hook/PoolManager caller checks. The vault has no creator redirection or admin escape hatch. A permanently rejecting claim recipient has no rescue or redirect path.

Do **not** characterize the system as trustless: `PoolManager` is an external Uniswap v4 dependency. Its governance and protocol-fee controls are outside SPLIT, and a reviewer should establish the effects of that governance on the exact manager deployment selected for any future deployment. No SPLIT deployment address exists in this candidate.

## Known design limitations

- The SPLIT fee applies only to the pool registered by the SPLIT factory. Alternate pools and OTC transfers can bypass it.
- Initial LP custody is intentionally irreversible through SPLIT. No LP migration, withdrawal, or recovery path currently exists.
- Ongoing liquidity allocations remain isolated as pending balances and are not automatically reinvested.
- A permanently rejecting recipient can strand only its own claim; no administrator can rescue or redirect it.
- Very small swaps can round the SPLIT fee to zero.
- Uniswap protocol-fee governance is external to SPLIT.
- V1 supports one quote asset: native ETH.
- There is no bonding curve or graduation mechanic.
- Token supply is fixed at launch.

## Attack surfaces to prioritize

Please focus especially on Uniswap v4 hook-delta semantics; exact-input and exact-output accounting in both `zeroForOne` and `oneForZero` directions; native ETH and ERC-20 settlement; flash accounting; `PoolManager.unlock` and callback behavior; hook permission bits; CREATE2 hook-address mining and prediction; fee rounding and conservation; cross-project and cross-currency isolation; claim reentrancy and failed claims; malicious recipient contracts; initial LP custody and LiquidityVault isolation; factory initialization; front-running around launch and pool initialization; and external Uniswap protocol-fee behavior.

## Verification evidence and reproduction

On this candidate, `forge fmt --check`, `forge lint`, and `forge build` passed. The local suite reported **26 passed, 0 failed, 1 skipped** (the opt-in fork test); the five invariant properties each passed with **128 runs and 8,192 handler calls**. The fee-conservation fuzz test passed with 512 runs. This is internal test evidence only; it is **not** an independent security audit.

Run from the repository root with Foundry and the locked dependencies available:

```sh
forge fmt --check
forge lint
forge build
forge test
```

The fork test is `testRHMainnetPinnedForkLaunchSeedSwapAndFeeSettlement`. It requires a read-only Robinhood Chain mainnet RPC and pinned block 72462030. POSIX shell example:

```sh
RH_MAINNET_FORK_RPC_URL='<read-only Robinhood Chain mainnet RPC URL>' \
RH_MAINNET_FORK_BLOCK=72462030 \
forge test --match-test testRHMainnetPinnedForkLaunchSeedSwapAndFeeSettlement -vv
```

PowerShell example:

```powershell
$env:RH_MAINNET_FORK_RPC_URL = '<read-only Robinhood Chain mainnet RPC URL>'
$env:RH_MAINNET_FORK_BLOCK = '72462030'
forge test --match-test testRHMainnetPinnedForkLaunchSeedSwapAndFeeSettlement -vv
```

The repository's prior verification record reports that fork lifecycle test passed at block `72462030`. It was **skipped in the candidate's current local rerun** because the two fork environment variables were not set; the independent reviewer should rerun it against an approved read-only RPC. The fork test checks chain ID `4663` and performs no broadcast.

## Deployment state and release boundary

> **NO SPLIT V1 CONTRACT HAS BEEN DEPLOYED.**
>
> **NO PRODUCTION CONTRACT ADDRESS EXISTS.**
>
> **NO PRODUCTION SUPABASE MIGRATION HAS BEEN APPLIED.**
>
> **THE FRONTEND MUST REMAIN LAUNCH-DISABLED.**

The frontend factory addresses are unset in the checked-in configuration and local `.env`; Robinhood Chain testnet launch is explicitly disabled. The independent review applies to the exact Git commit referenced by tag `split-v1-security-review`. Findings and any post-review code changes must refer back to that commit. No Solidity change, deployment, or Supabase migration is authorized by this review-scope document.
