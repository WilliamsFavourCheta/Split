# SPLIT v1 pull-claim security change

Status: V1.1 economics implemented in the working tree; not deployed and not an independent audit.

## Payout architecture

Permissionless `SplitHook.flush(poolId, currency)` consumes one accrued balance and invokes the hook-authorized router. The router first allocates 10% of gross fee to global Protocol Treasury claimable balance, then divides the remaining 90% across immutable Creator, Project Treasury, Community, and Liquidity BPS. The global Protocol Treasury is constructor-configured and independent of each launch's `projectTreasury` address. Processing makes no external call to any recipient. Project-allocation rounding dust goes to the vault. The 1% swap fee, token supply, quote asset, pool setup, allocation immutability, and liquidity custody are unchanged.

## Claims, failures, and reentrancy

`claim(poolId, currency)` uses `msg.sender` as the sole recipient selector; callers cannot name a different wallet. It checks a nonzero caller balance, sets the global router lock, clears that caller's pool/currency claimable amount and increments the claimed counter before transfer, then sends native currency or the ERC-20. The lock is held through the callback boundary. A failed transfer reverts the entire claim, restoring the balance and counters; no other recipient or pool is affected. There is no admin rescue or recipient-redirection path. A recipient whose contract permanently rejects payment must make that same recipient address capable of accepting a retry; nobody else can claim or redirect it.

`totalRecipientAllocated` / `totalRecipientClaimed` and `totalProtocolAllocated` / `totalProtocolClaimed` are tracked per pool/currency. Protocol swap fees are claimable only by the immutable Protocol Treasury. Tests enforce:

`total accrued = project recipient allocation + protocol allocation + liquidity credit + unprocessed accrual`

`recipient allocation = successfully claimed + currently claimable`

Liquidity remains separately accounted for in the non-withdrawable vault and cannot be claimed by any recipient or admin.

## Events and indexed data

- `FeesAccrued`: swap fee taken by the hook.
- `FeesAllocated`: one router event with gross fee plus Protocol, Creator, Project Treasury, Community, and Liquidity amounts.
- `ProtocolFeesClaimed`: successful Protocol Treasury swap-fee withdrawal.
- `LaunchProtocolFeeCharged`: successful launch's fixed 0.0005 ETH protocol fee.
- `ProtocolLaunchFeesClaimed`: successful Protocol Treasury launch-fee withdrawal.
- `FeesClaimed`: emitted only after a successful transfer; includes pool, recipient, currency, and amount.
- `LiquidityCredited`: emitted by the vault when its per-pool/currency ledger is incremented.

The indexer now parses allocations and successful claims independently. The new `202609270001_split_v11_protocol_revenue.sql` migration renames the project treasury fields, adds protocol allocations and successful launch-fee events, and updates exact string-valued views. `FeesClaimed` lacks a role field, so project claims are indexed generically as `project_recipient`; protocol claims have their explicit `protocol_treasury` role. Supabase is an indexed copy, not financial authority. The V1.1 migration has not been applied to any Supabase project.

## Frontend

Dashboard claim targets come from the index; the router's immutable `splits`, global `protocolTreasury`, and live claimable reads determine which configured roles match the connected wallet. Project recipients use `claim`; the global treasury uses `claimProtocolFees` per pool/currency and `claimProtocolLaunchFees` for accumulated fixed launch fees. The UI shows pending/confirmed state. The dashboard separately labels accrued, allocated, claimed, and liquidity-reserved amounts. No Supabase update is treated as proof of payment.

## Verification

| Check | Result |
|---|---|
| `forge fmt --check` | PASS |
| `forge lint` | PASS |
| `forge build` | PASS |
| `forge fmt --check` | PASS |
| `forge test --no-match-test RHMainnet` | PASS: 31 unit tests, 0 failed; opt-in RH fork excluded |
| Fuzz | PASS: 512 runs for fee conservation fuzz test |
| Invariants | PASS: 5 properties, 128 runs/property, 8,192 handler calls/property |
| `npm run lint` | PASS |
| `npm run build` | PASS, including TypeScript checks and static page generation |
| Gas report | PASS locally; includes test-environment deployment/routing data, not RH mainnet gas pricing or a before/after benchmark |
| RH mainnet fork | NOT RUN in this review pass |
| Deployment / Supabase migration | NOT RUN, as required |

Adversarial coverage includes rejecting Protocol Treasury, Creator, Project Treasury, and Community claim paths; continued allocation and vault credit; retry-preserving failed claims; double/unauthorized claims; reentrant claims; pool/currency isolation; repeated process/claim cycles; exact-input and exact-output swaps in both directions; and value-conservation fuzz/invariants. A dedicated regression configures two different project treasuries and proves neither is forced to equal the global Protocol Treasury.

## BLOCKERS BEFORE INDEPENDENT REVIEW

1. This code change still needs independent contract security review; successful tests are not an audit.
2. No SPLIT stack is deployed. The claim UI remains unavailable until independently reviewed contract addresses are deployed/configured and verified.
3. The new Supabase migration is unapplied and has not been executed against a live Supabase project; review it and apply only through the normal migration workflow before running the updated indexer against production.
4. A permanently rejecting recipient can leave only its own funds unclaimed indefinitely. That is an intentional consequence of immutable destinations and the prohibition on admin redirection; it does not block other fee processing or claims.
5. Robinhood Chain testnet has no verified official compatible Uniswap v4 PoolManager in the current architecture; local tests and the pinned mainnet fork are verification environments, not testnet deployment approval.
