# SPLIT V1.1 Independent Security Review Scope

## Candidate

Review the exact source revision tagged `split-v1.1-security-review`. V1.1
introduces protocol revenue separation from the V1 project-configured fee split.
This scope document is review guidance, not an audit opinion or deployment
approval.

## Security-critical Solidity changes and invariants

- `SplitHook` charges a 1% gross SPLIT swap fee.
- Of fees collected, 10% is a guaranteed protocol share; the remaining 90% is
  distributed using each project's immutable programmable allocation.
- The programmable project destinations are Creator, Liquidity, Project
  Treasury, and Community. Their basis-point values total 100% of that 90%
  portion; Project Treasury may be configured to 0%.
- The Protocol Treasury is a global immutable SPLIT recipient. A launcher cannot
  disable or redirect its share. Project Treasury is a per-project destination
  and is distinct from the Protocol Treasury.
- Protocol swap-fee claims and project-recipient claims are pull-based. Review
  authorization, accounting-before-transfer, reentrancy protections, duplicate
  claim prevention, and the independence of claim paths.
- `LiquidityVault` accounts for the liquidity allocation and controls/custodies
  the initial v4 LP position. Verify project-isolated accounting, position
  ownership, and that no administrator/creator escape hatch can transfer or
  withdraw the position.
- Validate deterministic rounding and conservation: protocol allocation plus
  all four project allocations must equal each collected gross hook fee, with no
  dust stranded or over-allocated across boundary values.
- Successful launch charges a separate 0.0005 ETH protocol launch fee; it is
  not seed liquidity. Review launch-fee accrual, atomicity on all failed launch
  paths, excess ETH/refund handling, and behavior when a refund recipient
  reverts.
- Project fee configuration is immutable after launch. Test invalid basis-point
  sums, zero Project Treasury, identical or distinct recipients, and hostile
  destinations.
- Exercise exact-input and exact-output swaps in both token directions against
  Robinhood Chain's deployed Uniswap v4 implementation. Verify fee denomination,
  hook callback assumptions, PoolManager custody/accounting, and rounding for
  input- and output-side fees.
- Assess reentrancy and callback ordering across PoolManager, hook, router,
  factory, vault, tokens, and recipient contracts. A reverting recipient must
  not block unrelated pull claims; its own failed claim must remain safely
  retryable.
- Verify unauthorized claims, replay/double claims, malformed currencies,
  malicious/nonstandard tokens, zero values, overflow boundaries, and any
  emergency/administrative powers.
- Confirm Robinhood Chain chain ID, PoolManager address/runtime assumptions,
  hook permission bits, and v4 API/version compatibility; do not infer that a
  local fork proves deployed behavior beyond its pinned block.

## Frontend, indexer, and database assumptions

- Frontend launch configuration must present the four project destinations as
  shares of the programmable project portion and must not imply that Project
  Treasury controls the Protocol Treasury share.
- Raw financial amounts are `numeric(78,0)` in storage and must be read from
  exact views as decimal strings, then handled with `BigInt`; they must never
  pass through JavaScript `Number`, `parseInt`, or `parseFloat`.
- Indexer event decoding and persistence must distinguish protocol allocations,
  project allocations, project claims, protocol claims, and launch-fee events;
  replay/reorg handling must mark noncanonical rows consistently and summaries
  must exclude them.
- `project_metrics_raw_amounts_exact.treasury_fees_raw` is a compatibility
  alias for **Project Treasury fee metrics**. It is not protocol revenue.
  Protocol revenue has separate fields `protocol_swap_fees_raw` and
  `launch_protocol_fees_raw`. Routing/configuration/allocation records use
  explicit `project_treasury` and `protocol_treasury` names.
- Review RLS and `security_invoker` behavior for all exact views, public reads,
  indexer writes, canonical filtering, and consistency between the deployed
  Supabase schema and checked-in migration source. Never apply the already-run
  migrations as part of review setup.

## Required review evidence

The review should independently inspect source and bytecode/build settings,
reproduce unit/fuzz/invariant and pinned-fork tests, analyze arithmetic and
external-call paths, and document findings with severity, exploitability, and
remediation. This candidate has not received independent security approval and
must not be treated as authorization to deploy or enable public launches.
