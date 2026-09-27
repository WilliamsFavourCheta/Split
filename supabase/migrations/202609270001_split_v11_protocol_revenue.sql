-- SPLIT V1.1 revenue model. Review and apply only through the approved migration workflow.
-- Raw chain amounts stay numeric(78,0) in storage and are exposed as text in *_exact views.

alter table public.fee_configs rename column treasury_bps to project_treasury_bps;
alter table public.fee_configs rename column treasury_destination to project_treasury_destination;
alter table public.fee_configs drop constraint if exists fee_configs_check;
alter table public.fee_configs add constraint fee_configs_v11_project_split_check
  check (creator_bps + liquidity_bps + project_treasury_bps + community_bps = 10000);

alter table public.fee_routing_events drop constraint if exists fee_routing_events_destination_type_check;
update public.fee_routing_events set destination_type = 'project_treasury' where destination_type = 'treasury';
alter table public.fee_routing_events add constraint fee_routing_events_destination_type_check
  check (destination_type in ('creator','liquidity','project_treasury','community','protocol_treasury','launch_protocol_fee'));

alter table public.fee_allocation_events drop constraint if exists fee_allocation_events_gross_amount_raw_check;
alter table public.fee_allocation_events drop constraint if exists fee_allocation_events_creator_allocation_raw_check;
alter table public.fee_allocation_events drop constraint if exists fee_allocation_events_treasury_allocation_raw_check;
alter table public.fee_allocation_events drop constraint if exists fee_allocation_events_community_allocation_raw_check;
alter table public.fee_allocation_events drop constraint if exists fee_allocation_events_liquidity_allocation_raw_check;
alter table public.fee_allocation_events drop constraint if exists fee_allocation_events_check;
alter table public.fee_allocation_events rename column treasury_allocation_raw to project_treasury_allocation_raw;
alter table public.fee_allocation_events add column protocol_allocation_raw numeric(78,0) not null default 0 check (protocol_allocation_raw >= 0);
alter table public.fee_allocation_events add constraint fee_allocation_events_conservation_check check (
  gross_amount_raw = protocol_allocation_raw + creator_allocation_raw + project_treasury_allocation_raw
    + community_allocation_raw + liquidity_allocation_raw
);

alter table public.fee_claim_events add column recipient_type text not null default 'project_recipient'
  check (recipient_type in ('creator','project_treasury','community','protocol_treasury','project_recipient'));

create table public.protocol_launch_fee_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  chain_id bigint not null,
  pool_id text not null,
  token_address text not null check (token_address = lower(token_address)),
  creator_address text not null check (creator_address = lower(creator_address)),
  tx_hash text not null,
  log_index integer not null,
  block_number bigint not null,
  block_hash text not null,
  block_timestamp timestamptz,
  raw_amount numeric(78,0) not null check (raw_amount > 0),
  canonical boolean not null default true,
  created_at timestamptz not null default now(),
  unique (chain_id, tx_hash, log_index)
);
create index protocol_launch_fee_events_project_idx on public.protocol_launch_fee_events(project_id, block_number desc);
alter table public.protocol_launch_fee_events enable row level security;
create policy "public protocol reads launch protocol fees" on public.protocol_launch_fee_events for select using (canonical);

alter table public.project_metrics add column protocol_swap_fees_raw numeric(78,0);
alter table public.project_metrics add column launch_protocol_fees_raw numeric(78,0);

create or replace function public.mark_chain_events_noncanonical(p_chain_id bigint, p_from_block bigint)
returns void language plpgsql security invoker as $$
begin
  update public.projects set canonical = false where chain_id = p_chain_id and launch_block_number >= p_from_block;
  update public.fee_configs set canonical = false where block_number >= p_from_block and project_id in (select id from public.projects where chain_id = p_chain_id);
  update public.launches set canonical = false where launch_block_number >= p_from_block and project_id in (select id from public.projects where chain_id = p_chain_id);
  update public.fee_routing_events set canonical = false where chain_id = p_chain_id and block_number >= p_from_block;
  update public.fee_accrual_events set canonical = false where chain_id = p_chain_id and block_number >= p_from_block;
  update public.liquidity_credit_events set canonical = false where chain_id = p_chain_id and block_number >= p_from_block;
  update public.fee_allocation_events set canonical = false where chain_id = p_chain_id and block_number >= p_from_block;
  update public.fee_claim_events set canonical = false where chain_id = p_chain_id and block_number >= p_from_block;
  update public.protocol_launch_fee_events set canonical = false where chain_id = p_chain_id and block_number >= p_from_block;
end;
$$;

-- The prior exact allocation view is intentionally replaced to rename treasury and add protocol share.
drop view if exists public.project_fee_distribution_summary;
drop view if exists public.fee_allocation_events_exact;
drop view if exists public.project_metrics_raw_amounts_exact;
create view public.fee_allocation_events_exact with (security_invoker = true) as
select id, project_id, chain_id, pool_id, currency, tx_hash, log_index, block_number,
  block_hash, block_timestamp, gross_amount_raw::text as gross_amount_raw,
  protocol_allocation_raw::text as protocol_allocation_raw,
  creator_allocation_raw::text as creator_allocation_raw,
  project_treasury_allocation_raw::text as project_treasury_allocation_raw,
  community_allocation_raw::text as community_allocation_raw,
  liquidity_allocation_raw::text as liquidity_allocation_raw, canonical, created_at
from public.fee_allocation_events;

create view public.protocol_launch_fee_events_exact with (security_invoker = true) as
select id, project_id, chain_id, pool_id, token_address, creator_address, tx_hash, log_index,
  block_number, block_hash, block_timestamp, raw_amount::text as raw_amount, canonical, created_at
from public.protocol_launch_fee_events;

create or replace view public.fee_claim_events_exact with (security_invoker = true) as
select id, project_id, chain_id, pool_id, currency, recipient_address, tx_hash,
  log_index, block_number, block_hash, block_timestamp, raw_amount::text as raw_amount, canonical, created_at,
  recipient_type
from public.fee_claim_events;

create view public.project_metrics_raw_amounts_exact with (security_invoker = true) as
select id, project_id, total_fees_raw::text as total_fees_raw,
  creator_fees_raw::text as creator_fees_raw, liquidity_fees_raw::text as liquidity_fees_raw,
  -- Preserve the already-deployed PostgREST API alias for compatibility.
  -- This legacy metric is project treasury fees, not protocol treasury revenue.
  treasury_fees_raw::text as treasury_fees_raw, community_fees_raw::text as community_fees_raw,
  protocol_swap_fees_raw::text as protocol_swap_fees_raw,
  launch_protocol_fees_raw::text as launch_protocol_fees_raw
from public.project_metrics;

create or replace view public.fee_routing_events_exact with (security_invoker = true) as
select id, project_id, chain_id, tx_hash, log_index, block_number, block_timestamp,
  destination_type, destination_address, token_address, raw_amount::text as raw_amount,
  token_decimals, pool_id, currency, gross_amount_raw::text as gross_amount_raw,
  block_hash, canonical, created_at
from public.fee_routing_events;

create view public.project_fee_distribution_summary with (security_invoker = true) as
select p.id as project_id,
  coalesce(sum(e.protocol_allocation_raw) filter (where e.canonical), 0)::text as protocol_raw,
  coalesce(sum(e.creator_allocation_raw) filter (where e.canonical), 0)::text as creator_raw,
  coalesce(sum(e.liquidity_allocation_raw) filter (where e.canonical), 0)::text as liquidity_raw,
  coalesce(sum(e.project_treasury_allocation_raw) filter (where e.canonical), 0)::text as project_treasury_raw,
  coalesce(sum(e.community_allocation_raw) filter (where e.canonical), 0)::text as community_raw
from public.projects p left join public.fee_allocation_events e on e.project_id = p.id group by p.id;

grant select on public.protocol_launch_fee_events, public.protocol_launch_fee_events_exact to anon, authenticated, service_role;
grant select on public.fee_allocation_events_exact, public.fee_claim_events_exact,
  public.fee_routing_events_exact, public.project_metrics_raw_amounts_exact,
  public.project_fee_distribution_summary to anon, authenticated, service_role;
notify pgrst, 'reload schema';
