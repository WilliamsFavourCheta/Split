-- Keep numeric(78,0) as canonical storage, but never expose raw chain amounts
-- to PostgREST as JSON numbers. Consumers must read these text-cast views.

create or replace view public.fee_routing_events_exact
with (security_invoker = true) as
select id, project_id, chain_id, tx_hash, log_index, block_number, block_timestamp,
  destination_type, destination_address, token_address, raw_amount::text as raw_amount,
  token_decimals, pool_id, currency, gross_amount_raw::text as gross_amount_raw,
  block_hash, canonical, created_at
from public.fee_routing_events;

create or replace view public.fee_accrual_events_exact
with (security_invoker = true) as
select id, project_id, chain_id, pool_id, currency, tx_hash, log_index, block_number,
  block_hash, block_timestamp, swapper_address, raw_amount::text as raw_amount,
  canonical, created_at
from public.fee_accrual_events;

create or replace view public.fee_allocation_events_exact
with (security_invoker = true) as
select id, project_id, chain_id, pool_id, currency, tx_hash, log_index, block_number,
  block_hash, block_timestamp, gross_amount_raw::text as gross_amount_raw,
  creator_allocation_raw::text as creator_allocation_raw,
  treasury_allocation_raw::text as treasury_allocation_raw,
  community_allocation_raw::text as community_allocation_raw,
  liquidity_allocation_raw::text as liquidity_allocation_raw, canonical, created_at
from public.fee_allocation_events;

create or replace view public.fee_claim_events_exact
with (security_invoker = true) as
select id, project_id, chain_id, pool_id, currency, recipient_address, tx_hash,
  log_index, block_number, block_hash, block_timestamp, raw_amount::text as raw_amount,
  canonical, created_at
from public.fee_claim_events;

create or replace view public.liquidity_credit_events_exact
with (security_invoker = true) as
select id, project_id, chain_id, pool_id, currency, tx_hash, log_index, block_number,
  block_hash, block_timestamp, raw_amount::text as raw_amount, canonical, created_at
from public.liquidity_credit_events;

create or replace view public.projects_raw_amounts_exact
with (security_invoker = true) as
select id, total_supply_raw::text as total_supply_raw,
  seed_token_amount_raw::text as seed_token_amount_raw,
  seed_quote_amount_raw::text as seed_quote_amount_raw,
  sqrt_price_x96::text as sqrt_price_x96
from public.projects;

create or replace view public.project_metrics_raw_amounts_exact
with (security_invoker = true) as
select id, project_id, total_fees_raw::text as total_fees_raw,
  creator_fees_raw::text as creator_fees_raw,
  liquidity_fees_raw::text as liquidity_fees_raw,
  treasury_fees_raw::text as treasury_fees_raw,
  community_fees_raw::text as community_fees_raw
from public.project_metrics;

create or replace view public.metric_snapshots_raw_amounts_exact
with (security_invoker = true) as
select id, project_id, total_fees_raw::text as total_fees_raw
from public.metric_snapshots;

drop view public.project_fee_distribution_summary;
create view public.project_fee_distribution_summary
with (security_invoker = true) as
select p.id as project_id,
  coalesce(sum(e.creator_allocation_raw) filter (where e.canonical), 0)::text as creator_raw,
  coalesce(sum(e.liquidity_allocation_raw) filter (where e.canonical), 0)::text as liquidity_raw,
  coalesce(sum(e.treasury_allocation_raw) filter (where e.canonical), 0)::text as treasury_raw,
  coalesce(sum(e.community_allocation_raw) filter (where e.canonical), 0)::text as community_raw
from public.projects p
left join public.fee_allocation_events e on e.project_id = p.id
group by p.id;

grant select on public.fee_routing_events_exact,
  public.fee_accrual_events_exact,
  public.fee_allocation_events_exact,
  public.fee_claim_events_exact,
  public.liquidity_credit_events_exact,
  public.projects_raw_amounts_exact,
  public.project_metrics_raw_amounts_exact,
  public.metric_snapshots_raw_amounts_exact,
  public.project_fee_distribution_summary
to anon, authenticated, service_role;

notify pgrst, 'reload schema';
