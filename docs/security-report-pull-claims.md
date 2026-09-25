# SPLIT v1 pull-claim security change

Status: implemented locally; not deployed and not an independent audit.

## Payout architecture

Permissionless `SplitHook.flush(poolId, currency)` still consumes one accrued balance and invokes the hook-authorized router. The router computes the same immutable split as before, credits Creator, Treasury, and Community balances under `(poolId, recipient, currency)`, and transfers/credits only the liquidity allocation to `SplitLiquidityVault`. Processing makes no external call to a recipient. Allocation rounding dust remains assigned to the vault. The 1% swap fee, token supply, quote asset, pool setup, allocation immutability, and liquidity custody are unchanged.

## Claims, failures, and reentrancy

`claim(poolId, currency)` uses `msg.sender` as the sole recipient selector; callers cannot name a different wallet. It checks a nonzero caller balance, sets the global router lock, clears that caller's pool/currency claimable amount and increments the claimed counter before transfer, then sends native currency or the ERC-20. The lock is held through the callback boundary. A failed transfer reverts the entire claim, restoring the balance and counters; no other recipient or pool is affected. There is no admin rescue or recipient-redirection path. A recipient whose contract permanently rejects payment must make that same recipient address capable of accepting a retry; nobody else can claim or redirect it.

`totalRecipientAllocated` and `totalRecipientClaimed` are tracked per pool/currency. Tests enforce:

`total accrued = recipient allocation + liquidity credit + unprocessed accrual`

`recipient allocation = successfully claimed + currently claimable`

Liquidity remains separately accounted for in the non-withdrawable vault and cannot be claimed by any recipient or admin.

## Events and indexed data

- `FeesAccrued`: swap fee taken by the hook.
- `FeesAllocated`: one router event with gross fee plus Creator, Treasury, Community, and Liquidity amounts.
- `FeesClaimed`: emitted only after a successful transfer; includes pool, recipient, currency, and amount.
- `LiquidityCredited`: emitted by the vault when its per-pool/currency ledger is incremented.

The indexer now parses allocations and successful claims independently. New `fee_allocation_events` and `fee_claim_events` tables and reorg handling are defined in `202609250003_pull_claim_accounting.sql`. Supabase is an indexed copy, not financial authority. This migration has not been applied to any Supabase project.

## Frontend

Dashboard claim targets come from the index; the router's immutable `splits` and live `claimable` reads determine which configured recipient roles match the connected wallet and how much can be claimed. The button submits the router's `claim` transaction, shows pending/confirmed state, and refreshes its onchain read after confirmation. The dashboard separately labels accrued, allocated, claimable, claimed, and liquidity-reserved amounts. No Supabase update is treated as proof of payment.

## Verification

| Check | Result |
|---|---|
| `forge fmt --check` | PASS |
| `forge lint` | PASS |
| `forge build` | PASS |
| `forge test` | PASS: 26 passed, 0 failed; environment-gated fork test skipped in this run |
| Fuzz | PASS: 512 runs for fee conservation fuzz test |
| Invariants | PASS: 5 properties, 128 runs/property, 8,192 handler calls/property |
| RH mainnet fork | PASS at pinned block `72462030`; read-only RPC, four swap modes |
| `npm run lint` | PASS |
| `npm run build` | PASS |
| Deployment / Supabase migration | NOT RUN, as required |

Adversarial coverage includes rejecting Community claims, continued Creator/Treasury allocation and vault credit, retry-preserving failed claims, double/unauthorized claims, reentrant claims, pool/currency isolation, repeated process/claim cycles, and value-conservation fuzz/invariants.

## BLOCKERS BEFORE INDEPENDENT REVIEW

1. This code change still needs independent contract security review; successful tests are not an audit.
2. No SPLIT stack is deployed. The claim UI remains unavailable until independently reviewed contract addresses are deployed/configured and verified.
3. The new Supabase migration is unapplied; deploy it only through the normal reviewed migration workflow before running the updated indexer against production.
4. A permanently rejecting recipient can leave only its own funds unclaimed indefinitely. That is an intentional consequence of immutable destinations and the prohibition on admin redirection; it does not block other fee processing or claims.
5. Robinhood Chain testnet has no verified official compatible Uniswap v4 PoolManager in the current architecture; local tests and the pinned mainnet fork are verification environments, not testnet deployment approval.
