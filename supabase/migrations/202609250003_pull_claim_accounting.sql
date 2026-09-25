-- Pull-claim accounting/indexing for SPLIT v1. Blockchain remains financial truth.
-- Apply only through the reviewed migration workflow; this file has not been applied.

create table public.fee_allocation_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  chain_id bigint not null,
  pool_id text not null,
  currency text not null check (currency = lower(currency)),
  tx_hash text not null,
  log_index integer not null,
  block_number bigint not null,
  block_hash text not null,
  block_timestamp timestamptz,
  gross_amount_raw numeric(78,0) not null check (gross_amount_raw > 0),
  creator_allocation_raw numeric(78,0) not null check (creator_allocation_raw >= 0),
  treasury_allocation_raw numeric(78,0) not null check (treasury_allocation_raw >= 0),
  community_allocation_raw numeric(78,0) not null check (community_allocation_raw >= 0),
  liquidity_allocation_raw numeric(78,0) not null check (liquidity_allocation_raw >= 0),
  canonical boolean not null default true,
  created_at timestamptz not null default now(),
  unique (chain_id, tx_hash, log_index),
  check (gross_amount_raw = creator_allocation_raw + treasury_allocation_raw + community_allocation_raw + liquidity_allocation_raw)
);
create index fee_allocation_events_project_block_idx on public.fee_allocation_events (project_id, block_number desc);
create index fee_allocation_events_pool_idx on public.fee_allocation_events (chain_id, pool_id, currency, block_number desc);
alter table public.fee_allocation_events enable row level security;
create policy "public protocol reads fee allocations" on public.fee_allocation_events for select using (canonical);

create table public.fee_claim_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  chain_id bigint not null,
  pool_id text not null,
  currency text not null check (currency = lower(currency)),
  recipient_address text not null check (recipient_address = lower(recipient_address)),
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
create index fee_claim_events_project_block_idx on public.fee_claim_events (project_id, block_number desc);
create index fee_claim_events_recipient_idx on public.fee_claim_events (chain_id, recipient_address, block_number desc);
alter table public.fee_claim_events enable row level security;
create policy "public protocol reads fee claims" on public.fee_claim_events for select using (canonical);

create or replace view public.project_fee_distribution_summary with (security_invoker = true) as
select p.id as project_id,
  coalesce(sum(e.creator_allocation_raw) filter (where e.canonical), 0) as creator_raw,
  coalesce(sum(e.liquidity_allocation_raw) filter (where e.canonical), 0) as liquidity_raw,
  coalesce(sum(e.treasury_allocation_raw) filter (where e.canonical), 0) as treasury_raw,
  coalesce(sum(e.community_allocation_raw) filter (where e.canonical), 0) as community_raw
from public.projects p
left join public.fee_allocation_events e on e.project_id = p.id
group by p.id;

create or replace function public.mark_chain_events_noncanonical(
  p_chain_id bigint,
  p_from_block bigint
) returns void language plpgsql security invoker as $$
begin
  update public.projects set canonical = false where chain_id = p_chain_id and launch_block_number >= p_from_block;
  update public.fee_configs set canonical = false where block_number >= p_from_block and project_id in (select id from public.projects where chain_id = p_chain_id);
  update public.launches set canonical = false where launch_block_number >= p_from_block and project_id in (select id from public.projects where chain_id = p_chain_id);
  update public.fee_routing_events set canonical = false where chain_id = p_chain_id and block_number >= p_from_block;
  update public.fee_accrual_events set canonical = false where chain_id = p_chain_id and block_number >= p_from_block;
  update public.liquidity_credit_events set canonical = false where chain_id = p_chain_id and block_number >= p_from_block;
  update public.fee_allocation_events set canonical = false where chain_id = p_chain_id and block_number >= p_from_block;
  update public.fee_claim_events set canonical = false where chain_id = p_chain_id and block_number >= p_from_block;
end;
$$;
