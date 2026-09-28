# SPLIT v1 Mainnet Deployment Manifest — Dry Run Only

**Status: FAILED / DO NOT DEPLOY.** This is a preflight record, not an authorization or production manifest. No transaction was broadcast, no contract was deployed to mainnet, and no production configuration was written. All listed protocol addresses below are fork-test simulation addresses only.

## Frozen source and chain baseline

- Source commit: `dc2ba0225aefe3b8d8af98b9c3b6023792c01c19`
- Security tag: `split-v1-security-review`
- Annotated tag object: `225b12378541d1fb3e5ba9901d027730b2e5318e`
- Peeled tag commit: `dc2ba0225aefe3b8d8af98b9c3b6023792c01c19`
- Solidity working tree: clean; no contract diff from the tag.
- Robinhood Chain ID: `4663`
- Uniswap v4 PoolManager: `0x8366a39cc670b4001a1121b8f6a443a643e40951`
- SPLIT fork pin: block `73152779`, hash `0x7f624ae3099fd979b0479291cb80adf8a4daab2ea3be07a2e23a038b9aedea06`, timestamp `2026-09-26 14:25:44 UTC`
- PoolManager code hash at pin: `0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626`
- Legacy pin `72462030`: reproduced successfully. The earlier “no code” conclusion came from querying an incorrect hex block tag.
- Dependency/compiler: `@uniswap/v4-core 1.0.2`; Solidity `0.8.26`; Cancun; optimizer 200 runs; via-IR.

## Hook CREATE2 result — simulation only

The existing fork test deployed `SplitStackDeployer` at `0xF62849F9A0B5Bf2913b396098F7c7019b51A820a`. For that simulated deployer and PoolManager:

- Salt: `0x0000000000000000000000000000000000000000000000000000000000001f9e`
- SplitHook init-code hash: `0xa9a17b461f09776abdcb44f9b51bf30e8599e5c788d3c56e7a555b4a218a68ff`
- Predicted/observed test hook: `0x21b5a6342c77d4750341a26cA84594947c16C044`
- Low 14 bits: `0x44` — matches `REQUIRED_HOOK_MASK` and the `afterSwap | afterSwapReturnDelta` permissions.
- `SplitHook.getHookPermissions()` is not implemented in this frozen source. The programmatic check compared mined address bits with `0x44`; the existing permission-bit test and fork callback test passed.

This is not the production salt/address: the production `SplitStackDeployer` address depends on the real deployer address and nonce, neither of which is available.

## Simulated stack and constructor wiring

Order from the test deployment helper: deploy `SplitStackDeployer`, then `SplitLiquidityVault`, `SplitFeeRouter`, CREATE2 `SplitHook`, and `SplitFactory`. The router/vault/factory references are precomputed; there is no post-deploy configuration step.

| Component | Simulated address | Constructor arguments |
|---|---|---|
| `SplitStackDeployer` | `0xF62849F9A0B5Bf2913b396098F7c7019b51A820a` | none |
| `SplitLiquidityVault` (CREATE nonce 1) | `0x4f81992FCe2E1846dD528eC0102e6eE1f61ed3e2` | factory `0x5Fa39CD9DD20a3A77BA0CaD164bD5CF0d7bb3303`; router `0xCB6f5076b5bbae81D7643BfBf57897E8E3FB1db9`; PoolManager above |
| `SplitFeeRouter` (CREATE nonce 2) | `0xCB6f5076b5bbae81D7643BfBf57897E8E3FB1db9` | factory `0x5Fa39CD9DD20a3A77BA0CaD164bD5CF0d7bb3303`; hook `0x21b5a6342c77d4750341a26cA84594947c16C044`; vault above |
| `SplitHook` (CREATE2, salt above) | `0x21b5a6342c77d4750341a26cA84594947c16C044` | PoolManager; factory `0x5Fa39CD9DD20a3A77BA0CaD164bD5CF0d7bb3303`; router above |
| `SplitFactory` (CREATE nonce 4) | `0x5Fa39CD9DD20a3A77BA0CaD164bD5CF0d7bb3303` | PoolManager; hook; router; vault; simulated treasury `0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f` |

## Fork lifecycle and gas observations

The fork lifecycle test passed at block `73152779`. It created a synthetic fixed-supply token at `0xc45607982D1378961ddCc0B3c601C74867a578BE`, initialized a pool, seeded 1 ETH and `1e18` token units through the vault, and executed four swaps. The `ModifyLiquidity` trace identifies the vault as position owner. However, that fork test configures **100% creator / 0% liquidity / 0% treasury / 0% community**, and does not perform claims.

| Operation | Observed gas |
|---|---:|
| Deploy stacker contract (test-helper trace) | 4,326,416 |
| `SplitStackDeployer.deploy` (includes four child deployments) | 9,002,204 |
| Vault / router / hook / factory child CREATE traces | 1,243,409 / 746,347 / 519,371 / 1,299,845 |
| Synthetic launch total | 1,021,765 |
| PoolManager initialize | 29,163 |
| PoolManager seed `modifyLiquidity` call | 164,250 |
| Four PoolManager swaps (exact-in 0→1, exact-out 0→1, exact-in 1→0, exact-out 1→0) | 97,332 / 51,803 / 69,927 / 66,554 |
| Four `SplitHook.flush` calls | 101,756 / 83,391 / 37,591 / 34,056 |
| Individual claim example (local unit test, not fork) | 55,980 |

Estimated stack deployment gas is approximately `13,328,620` (stacker creation plus stack deployment call). At the sampled Robinhood `eth_gasPrice` of `28,016,000 wei`, that is approximately `0.00037341461792 ETH`; a 10× balance buffer is `0.0037341461792 ETH`. Recommended minimum working balance: `0.005 ETH`, excluding any launch seed assets. These are estimates from the test helper, not a successful guarded-script simulation.

## Security properties reviewed

- No proxy, proxy admin, protocol owner, upgrade authority, or privileged token mint found in v1 sources.
- Split configuration is factory-only and once per pool; recipients claim their own pool/currency balance.
- Creator, treasury, and community are pull-claim recipients; allocation does not call them. Failed claims revert without consuming that recipient's claimable amount.
- Liquidity position is keyed to and controlled by the vault; no vault removal, withdrawal, transfer, or rescue method exists. Liquidity-fee credits update `pendingLiquidity`; v1 does not automatically reinvest those credits.
- Local unit tests for 40/30/20/10 routing, pull-claim isolation/reentrancy/reverting recipients, rounding, and vault position control passed. These are not a substitute for a fork test of the complete 40/30/20/10 claim lifecycle.

## Credential, gate, and next deployment configuration

- Deployer credential: **DEPLOYER CREDENTIAL REQUIRED**. No signing credential was configured; no key was requested or used; no deployer public address is available.
- Exact `DeploySplit.s.sol` fork dry-run: not completed successfully (pinned RPC historical sender-state error; latest attempt returned “No contract bytecode”). No `--broadcast` option was used.
- Fork tests use an internal test helper and are not the guarded script simulation. The requested on-fork 40/30/20/10 distribution plus independent claims remains untested.
- Public launching remains disabled: mainnet factory/hook/router/vault address settings are unset and the UI reports the factory as not configured. No production indexer was started; no Supabase values were written.
- After a real human-approved deployment, record chain ID `4663`, actual deployment block/hash, actual factory/hook/router/vault addresses, and verified PoolManager/code hash. Configure `NEXT_PUBLIC_SPLIT_FACTORY_MAINNET_ADDRESS`, `NEXT_PUBLIC_SPLIT_HOOK_MAINNET_ADDRESS`, `NEXT_PUBLIC_SPLIT_ROUTER_MAINNET_ADDRESS`, and `NEXT_PUBLIC_SPLIT_VAULT_MAINNET_ADDRESS` in the approved runtime environment. `app/contracts/addresses.ts` consumes these; `app/lib/indexer/evm-source.ts` consumes factory/hook. Start the indexer from the actual deployment block and keep financial reads on the `_exact` Supabase views. Do not use any addresses in this dry-run table for production.

## Required before preflight can pass

1. Provide/configure a deployer credential securely outside chat and derive its public address without exposing the key.
2. Successfully simulate the exact guarded deployment script on the pinned fork with production-equivalent sender/nonce and without broadcasting.
3. Run the fork launch using the reviewed 40/30/20/10 split; verify actual fee allocations, exact conservation/rounding, independent claims, failed/reverting claims, and liquidity credit after the full remote fork round trip.
4. Measure claim gas on the fork and recheck funding against a conservative current fee assumption.

**Do not deploy. Do not broadcast. Do not enable public launching.**

## Final blocker follow-up — 2026-09-26

**Status remains FAILED / DO NOT DEPLOY.** This follow-up used no signing key and no `--broadcast`. The production Solidity source and `split-v1-security-review` tag remain unchanged.

### Guarded production script dry-run

The earlier pinned invocation failed before script execution because the Robinhood RPC returned `historical state 9a3ea578476622d984e6e500dfefdd11e16b1d01a336309a2f015b149ea24efe is not available`. This is an RPC historical-state/pruning failure, not evidence of a bad sender nonce. The provider returns block headers but rejects account-state reads at the pinned root.

The earlier `No contract bytecode` failure was reproduced and diagnosed: the cached `artifacts/forge/DeploySplit.s.sol/DeploySplit.json` artifact contained the `run()` ABI but zero creation/runtime bytecode, while Forge reported “No files changed, compilation skipped.” A forced full rebuild regenerated 52,594 hex characters of creation bytecode and 52,542 of runtime bytecode. The exact same production script then completed successfully in dry-run mode. No deployment script source change was needed; this was a stale/incomplete Foundry artifact/cache condition.

Successful simulation used chain `4663`, fixed block `73169569`, hash `0xb40389306d7e265396add54d7e2af747569b39a581540c9cf05666a4a6bc9d8d`, timestamp `2026-09-26 14:53:51 UTC`, deterministic simulated sender `0x000000000000000000000000000000000000dEaD`, and no private key. `DeploySplit.run()` passed its chain, PoolManager code/address, approval-flag, and constructor deployment checks. Estimated dry-run gas: `11,901,888`; estimated amount: `0.000664553830269888 ETH` at the RPC-sampled `0.055836001 gwei`.

All following addresses are **SIMULATION ONLY — NOT PRODUCTION**:

| Component | Simulated address |
|---|---|
| `SplitStackDeployer` | `0x9B137463d4E7986D7f535f9B79e28b4EF1938E9b` |
| `SplitLiquidityVault` | `0x8D51b916fcd05492Ae152fF28B826885A665106c` |
| `SplitFeeRouter` | `0x95Cd795c6dF13D87876C8b0909e7D309c9330175` |
| `SplitHook` | `0x00f7C2D99F42E0B622b02F8F566187b89aB0C044` |
| `SplitFactory` | `0x86766C3f390b47d62141C7e2e9D7f19eDEfE4614` |

The production script mined CREATE2 salt `0x00000000000000000000000000000000000000000000000000000000000028ff`; the simulated hook's low 14 bits are `0x44` (`afterSwap | afterSwapReturnDelta`). Stack deployment succeeded against the real forked PoolManager address `0x8366a39cc670b4001a1121b8f6a443a643e40951`. Foundry's dry-run output explicitly ended `SIMULATION COMPLETE`; it wrote only local dry-run artifacts under ignored `broadcast/` and `cache/` directories. Nothing was sent to Robinhood.

### Lifecycle test tooling and remaining RPC blocker

The optional fork lifecycle regression in `contracts/test/SplitProtocol.t.sol` now uses the production `SplitStackDeployer` bytecode (not the duplicate test helper) and mines its hook salt with the same CREATE nonce assumptions as `DeploySplit.s.sol`. It exercises 40/30/20/10 allocations, all four swap modes, exact balance-delta checks, independent recipient claims and gas capture, an unauthorized claim, a rejecting native recipient, vault-owned PoolManager position inspection/removal attempts, and `pendingLiquidity` accounting. This tooling compiled successfully, but the actual fork test could not enter its body: the provider rejected account-state reads for both the pinned fork root and recent fixed block `73169569`. The original RPC only served those accounts at moving `latest`, not at the fixed block tag required for a reproducible fork.

Therefore these items remain **NOT TESTED on the Robinhood fork**: 40/30/20/10 lifecycle result, all four fork swap balance deltas, fork allocation/conservation, fork claim balances and gas, unauthorized claim, reverting-recipient isolation, and on-fork LP custody/removal. Prior values in this manifest are from the earlier 100%-creator fork test or local tests and must not be substituted for these required results. A provider with historical state/archive access is required to finish this phase. Do not treat the successful stack-only script dry-run as a complete protocol preflight.

### Regression and frozen-source verification

- `forge fmt --check`: passed.
- `forge lint`: passed.
- `forge build`: passed.
- `forge test`: passed; 31 tests passed, 0 failed, 1 optional fork test skipped because fork variables were not set. Five invariant suites each passed 128 runs / 8,192 calls (40,960 total invariant calls).
- Focused fork test: failed before test execution on unavailable historical account state; this is **not** a passing lifecycle result.
- `contracts/src` diff against frozen commit `dc2ba0225aefe3b8d8af98b9c3b6023792c01c19`: none. Frozen tag was not moved or recreated. Only test tooling and this manifest were changed for this follow-up.

No deployer credential was requested or used. No transaction was broadcast. No Supabase/indexer values were written, and public launching remains disabled.

## Final Robinhood fork preflight — 2026-09-27

This section supersedes the earlier “lifecycle not tested” status above. The archive RPC is now configured and was used for all fork reads. This remains a dry-run only; no mainnet transaction was sent.

### Baseline and actual production-script dry-run

- `HEAD` and `split-v1-security-review^{commit}` both equal `dc2ba0225aefe3b8d8af98b9c3b6023792c01c19`; `contracts/src` diff against that commit is empty.
- Chain ID `4663`; pinned block `73152779`, hash `0x7f624ae3099fd979b0479291cb80adf8a4daab2ea3be07a2e23a038b9aedea06`.
- PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951` code is present at the pin; runtime hash `0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626`.
- Historical RPC capability checks passed for block retrieval/hash, balance, transaction count, code, storage, and `eth_call`.
- The guarded `DeploySplit.run()` completed with deterministic simulated sender `0x000000000000000000000000000000000000dEaD`, `ALLOW_RH_MAINNET_DEPLOYMENT=true` only for the local simulation, and no private key or `--broadcast`.
- Script gas trace: `SplitStackDeployer` creation `4,306,790`; `SplitStackDeployer.deploy()` `3,948,271`; total measured stack execution `8,255,061 gas`. Forge dry-run estimated transaction gas limit `11,901,888` (130% estimate multiplier); the script’s separate estimated required amount at its sampled gas price was `0.000482216906109888 ETH`.

Every SPLIT deployment/project/token/recipient address in this section is **SIMULATION ONLY — NOT PRODUCTION**. The PoolManager address above is the actual deployed Robinhood PoolManager.

| Component | Simulation-only address |
|---|---|
| `SplitStackDeployer` | `0x9B137463d4E7986D7f535f9B79e28b4EF1938E9b` |
| `SplitLiquidityVault` | `0x8D51b916fcd05492Ae152fF28B826885A665106c` |
| `SplitFeeRouter` | `0x95Cd795c6dF13D87876C8b0909e7D309c9330175` |
| `SplitHook` | `0x00f7C2D99F42E0B622b02F8F566187b89aB0C044` |
| `SplitFactory` | `0x86766C3f390b47d62141C7e2e9D7f19eDEfE4614` |
| First synthetic token | `0x109e120F17a7DD80c8e9DDf49e1aF1791f2df4D2` |
| Reverting-recipient synthetic token | `0x6F1997196733FB4b41EdC31ce9669A1B999bC7D5` |

CREATE2 verification for the production script’s deployer/nonce plan:

- Salt: `0x00000000000000000000000000000000000000000000000000000000000028ff`.
- SplitHook init-code hash: `0xfe71ca99285e35e27b1a5c9f7b6776c2dee94698adb2278a1f6356ca2d632958`.
- Predicted and simulated hook: `0x00f7C2D99F42E0B622b02F8F566187b89aB0C044`; predicted equals actual.
- Low 14 bits: `0x44`. This corresponds to `afterSwap` and `afterSwapReturnDelta` (`REQUIRED_HOOK_MASK`); the frozen source does not implement `getHookPermissions()`.
- The fork lifecycle test uses the same deterministic sender and asserts the production `SplitStackDeployer` address matches the script dry-run address. It does not use the duplicate test helper deployment.

### 40/30/20/10 lifecycle and swaps

The focused fork test passed against the real forked PoolManager: 1 passed, 0 failed, 0 skipped. It launched a fixed-supply `1,000,000,000 × 10^18` token with Creator/Treasury/Community as distinct recipients and immutable `4,000/3,000/2,000/1,000 BPS` routing. Reconfiguration (including a simulated factory caller) and post-launch mint attempts failed. The real PoolManager initialized the pool; `SplitLiquidityVault` seeded the full-range position. PoolManager position state keyed by the vault equaled the vault’s recorded `1 × 10^18` liquidity.

Actual balance-delta observations (currency amounts are raw units; native currency is wei):

| Swap | Trader input | Trader output | Fee currency | SPLIT fee / expected 1% |
|---|---:|---:|---|---:|
| Exact-input, zeroForOne | `1,000,000,000,000,000` native | `986,046,911,229,504` token | token | `9,960,069,810,399` / `9,960,069,810,399` |
| Exact-output, zeroForOne | `1,016,077,214,565,606` native | `1,000,000,000,000,000` token | native | `10,060,170,441,243` / `10,060,170,441,243` |
| Exact-input, oneForZero | `1,000,000,000,000,000` token | `989,993,068,993,159` native | native | `9,999,929,989,829` / `9,999,929,989,829` |
| Exact-output, oneForZero | `1,012,027,078,135,657` token | `1,000,000,000,000,000` native | token | `10,020,070,080,551` / `10,020,070,080,551` |

Each swap showed nonzero hook accrual in the correct fee currency; each flush then cleared that accrual. Allocation checks used exact integer values and balance changes, not only events. Per-currency totals after all four swaps:

| Fee currency | Gross | Creator | Treasury | Community | Liquidity/pendingLiquidity |
|---|---:|---:|---:|---:|---:|
| token | `19,980,139,890,950` | `7,992,055,956,379` | `3,996,027,978,189` | `1,998,013,989,094` | `5,994,041,967,288` |
| native | `20,060,100,431,072` | `8,024,040,172,428` | `4,012,020,086,213` | `2,006,010,043,106` | `6,018,030,129,325` |

For both currencies, `gross = creator + treasury + community + liquidity` exactly. Each individual share is floored; the residual goes to the irrevocable liquidity allocation. Against an exact 30% floor, the four swaps credited additional rounding dust of `3, 2, 3, 1` raw units respectively (9 raw units total). Direct router/vault state confirmed Creator, Treasury, and Community claimables; Liquidity was not recipient-claimable and was recorded only as `pendingLiquidity`. There was no automatic swap, pairing, or reinvestment.

### Claims, failure isolation, and custody

Successful first-project pull claims recorded exact balance delta, claimable-before/after, recipient-balance-before/after, and gas. All claimable balances became zero for the claimant; other recipients and the other currency remained unchanged.

| Recipient | Currency | Claimable before | Recipient balance before → after | Gas |
|---|---|---:|---:|---:|
| Treasury | native | `4,012,020,086,213` | `0` → `4,012,020,086,213` | `34,321` |
| Community | native | `2,006,010,043,106` | `0` → `2,006,010,043,106` | `12,590` |
| Creator | native | `8,024,040,172,428` | `1,999,973,915,854,427,553` → `1,999,981,939,894,599,981` | `11,648` |
| Treasury | token | `3,996,027,978,189` | `0` → `3,996,027,978,189` | `50,553` |
| Community | token | `1,998,013,989,094` | `0` → `1,998,013,989,094` | `28,653` |
| Creator | token | `7,992,055,956,379` | `999,999,998,999,974,019,833,093,847` → `999,999,998,999,982,011,889,050,226` | `7,979` |

The unrelated-address claim attempt failed with `NothingToClaim`; the rightful recipient’s claimable balance remained intact. `claim` has no caller-selected destination parameter, and actual recipient identity is `msg.sender`.

On a second synthetic pool, the rejecting Community recipient’s native claim reverted after fees were allocated. Its `1,004,013,040,121` claimable amount remained intact; Creator and Treasury claims succeeded independently and cleared their balances. The failed claim used `32,812 gas`; processing allocation was not blocked.

Actual custody checks found the seeded position under the vault’s PoolManager position key and re-read identical liquidity after attempts. Removal attempts from the creator contract, the simulated deployer, and an arbitrary attacker contract all failed; the deployer had no unlock callback. Tested vault selectors for `removeLiquidity`, `withdraw`, `transferPosition`, `approve`, and `rescueToken` were unavailable/reverted. Source review additionally found no v1 withdrawal, rescue, transfer, approval, or reclaim function. This is evidence for the tested paths, not a formal proof against every conceivable PoolManager attack.

### Gas and regression

Measured fork call gas: launch `1,021,765`; PoolManager initialize `29,163`; vault seed call `304,523` (including the PoolManager liquidity modification `164,250`); swaps exact-in 0→1 `97,332`, exact-out 0→1 `51,803`, exact-in 1→0 `69,927`, exact-out 1→0 `66,554`; flush/allocation `181,970`, `147,381`, `47,881`, `40,670`; Creator/Treasury/Community claim gas is shown above per currency.

The configured RPC’s current `eth_gasPrice` sample was `20,170,000 wei` (`0.02017 gwei`). At that sample, measured stack execution gas `8,255,061` costs approximately `0.00016650458037 ETH`; a 10× gas-price/usage buffer is `0.00166504580370 ETH`. Recommend at least `0.005 ETH` reserved for deployment gas and volatility, excluding project seed assets. The synthetic test seeded `1 ETH + 1 × 10^18` token units per project; seed assets are not included in gas funding. Forge’s script gas limit/required-amount estimate is also reported above and is not a mined transaction receipt.

- `forge fmt --check`: passed.
- `forge lint`: passed.
- `forge build`: passed.
- `forge test`: 32 passed, 0 failed, 0 skipped (27 unit/fuzz tests plus the pinned fork test; 512 fuzz runs).
- Five invariant suites passed, each with 128 runs and 8,192 calls, no reverts (40,960 total invariant calls).
- Focused real-Robinhood fork lifecycle: passed, 1 passed, 0 failed, 0 skipped.
- `contracts/src` remains byte-for-byte unchanged from frozen commit; tag remains peeled to that commit. Only `contracts/test/SplitProtocol.t.sol` test tooling and this manifest were changed for the final preflight.

This is technical preflight only. No broadcast, production deployment, real seed, production address configuration, Supabase write, indexer start, or public-launch enablement occurred. The security review remains an internal review, not an independent audit; final operational/deployer setup and a separate approval are still required before any real deployment.

## PRODUCTION DEPLOYMENT PREVIEW — NOT YET DEPLOYED

Read-only preview performed 2026-09-27 using the configured Robinhood mainnet RPC and the public deployer address supplied by the operator. No private key was requested or used. No transaction was signed or broadcast. The values below are predictions, **not deployed production addresses**.

### Chain, account, and source checks

- Public deployer: `0x3A00dbA68a48d82cD3fc9b1b9E932beF13633F9E`.
- `eth_chainId`: `0x1237` = `4663` (PASS).
- Latest-state deployer balance: `0x1329b9336f8f5d` wei = `5,393,899,966,140,253 wei` = `0.005393899966140253 ETH`.
- The balance exceeds the recommended `0.005 ETH` reserve by `0.000393899966140253 ETH` before deployment.
- Latest-state transaction count: `3`; predictions assume this remains the deployer's nonce and no earlier pending transaction consumes it.
- Frozen source check: `HEAD` and `split-v1-security-review^{commit}` both equal `dc2ba0225aefe3b8d8af98b9c3b6023792c01c19`; `contracts/src` has no diff against the commit or tag.
- No production addresses were written by this preview. Mainnet factory/hook/router/vault environment variables are empty; `app/contracts/addresses.ts` and `app/lib/indexer/evm-source.ts` continue to read those values from environment and contain no production address literals. A targeted read-only query of live Supabase `launches`, `fee_configs`, and `indexer_state` found zero rows referencing any of the five predicted addresses. No Supabase write or indexer start occurred.

### Deterministic address prediction and collision check

Using the public deployer's observed nonce `3`, the production script's CREATE sequence, frozen build artifacts, actual Robinhood PoolManager, and the production salt-mining rule:

| Component | Prediction (not deployed) | Derivation |
|---|---|---|
| `SplitStackDeployer` | `0x8cd940586beaf48e97903c1b54d856ee17e6ed80` | CREATE from public deployer at nonce 3 |
| `SplitLiquidityVault` | `0xf3605f8601b2cf0bdef94787b2d5f26f56922ce5` | CREATE from stack deployer at nonce 1 |
| `SplitFeeRouter` | `0xb6831489d1e531d0dc00da998d3a51059fa70478` | CREATE from stack deployer at nonce 2 |
| `SplitHook` | `0x2a4edd7ce70b99cd04d78a3d5415aaf8972f4044` | CREATE2 from stack deployer using salt below |
| `SplitFactory` | `0xbf4c8b7d67c32a878cd8916953c7899288871fee` | CREATE from stack deployer at nonce 4 (CREATE2 consumes nonce 3) |

- CREATE2 deployer: predicted `SplitStackDeployer`, `0x8cd940586beaf48e97903c1b54d856ee17e6ed80`.
- Hook salt: `0x00000000000000000000000000000000000000000000000000000000000018b8`.
- Hook init-code hash: `0x2aa2992c8dc18a11274e2a4c827893dcff105994cbd17c3bc3abfb4af7bbad8b`.
- Predicted hook low 14 bits: `0x44`; assertion `low14 == 0x44` passed.

## Round 2 security-remediation candidate — deployment data superseded

The preceding `0x44` hook permission records and every hook salt/address/init-code prediction above describe the prior V1.1.1 candidate only. They MUST NOT be reused for the Round 2 candidate. The candidate now enables `beforeInitialize` in addition to the two swap callbacks, requiring low 14 bits `0x2044`. Its init code and mined salt necessarily differ. No Round 2 production address, salt, or deployment transaction has been produced or broadcast; rerun the guarded preview from this candidate before any future deployment review.
- `eth_getCode` at latest block `0x469f98c` returned empty code for all five predicted addresses: collision check PASS.
- The stacker address depends on the deployer's nonce at inclusion. Any intervening transaction, nonce change, changed build/artifact, or changed constructor configuration invalidates some or all predictions; they cannot be guaranteed until deployment is actually included and verified.

### Gas and balance estimate

- Current `eth_gasPrice` sample: `20,264,000 wei` (`0.020264 gwei`).
- Using the previously measured guarded-script dry-run gas limit of `11,901,888` total gas (130% estimate multiplier), estimated deployment spend is `241,179,858,432,000 wei` = `0.000241179858432 ETH`.
- Conservative working gas reserve: `0.005 ETH` (about 20.7 times this sampled estimated spend). This is gas only; it excludes all project seed liquidity.
- Estimated balance after the sampled deployment spend: `5,152,720,107,708,253 wei` = `0.005152720107708253 ETH`, leaving about `0.000152720107708253 ETH` above the recommended reserve.
- These are planning estimates, not transaction quotes or mined gas receipts; gas price and actual inclusion cost can change.

### Planned transactions — unsigned and not submitted

The guarded `DeploySplit.run()` sequence would produce two EOA transactions:

1. **Deploy stack deployer:** sender `0x3A00dbA68a48d82cD3fc9b1b9E932beF13633F9E`, nonce 3, contract-creation target (no `to`), value `0`, `SplitStackDeployer` constructor has no inputs; creation bytecode from the frozen build. Expected resulting address: `0x8cd940586beaf48e97903c1b54d856ee17e6ed80`.
2. **Deploy the stack:** sender same, nonce 4, target `0x8cd940586beaf48e97903c1b54d856ee17e6ed80`, value `0`, call `deploy(IPoolManager manager, address treasury, bytes32 salt)` with manager `0x8366a39cc670b4001a1121b8f6a443a643e40951`, salt `0x00000000000000000000000000000000000000000000000000000000000018b8`, and the protocol treasury as the second argument. Expected internal CREATE/CREATE2 results are the vault, router, hook, and factory addresses in the table above.

**Blocking inputs:** `SPLIT_PROTOCOL_TREASURY` is absent/empty in the local environment, and no production treasury address was supplied. The simulated treasury from older dry-run records is not a production choice and was not reused. `SPLIT_POOL_MANAGER` and the explicit `ALLOW_RH_MAINNET_DEPLOYMENT` gate are also not configured in `.env`; the preview used the already verified canonical PoolManager address as a read-only prediction input, not as a persistent configuration change. Therefore the second transaction's treasury ABI word and final calldata cannot be responsibly finalized. The deployer-funding check passes, but this preview is **not ready for signing or deployment** until the operator provides/configures the intended treasury and required script inputs, then rechecks predictions against the then-current account nonce, gas price, and code state.

No transaction was signed or broadcast. No contract was deployed. No project seed liquidity was included. Public launch remains disabled. The internal security review is not an independent audit.

## V1.1 security-remediation candidate — deployment preview superseded

The preview above describes the pre-remediation no-argument `SplitStackDeployer` and is retained as a historical record only. Its helper init code, address, CREATE2 salt/init-code hash, child predictions, gas trace, calldata, and two-transaction call shape are **not valid for the remediation candidate**. The current helper binds the authorized deployer, expected PoolManager, and Protocol Treasury in its constructor, permits only that deployer to call `deploy(bytes32 salt)`, and is one-shot. Re-run the complete pinned fork preflight and regenerate all production predictions/gas from the new artifact before any later deployment review. No production deployment was performed by this remediation.

Before a future mainnet script run, a human operator must confirm the intended treasury address against the approved manifest; verify controller/signer authority to call both protocol swap-fee and launch-fee claims; and validate native-ETH receipt on a controlled environment. Multisig contract treasuries remain valid. Set `SPLIT_PROTOCOL_TREASURY_OPERATIONALLY_VERIFIED=true` only after completing and recording these checks; the script flag is an attestation, not proof. Do not add an EOA-only/code-length restriction.
