-- SPLIT Protocol v1 chain-derived fields and idempotent canonical event ingestion.
-- Apply after 202609250001_initial_schema.sql through the normal Supabase migration workflow.

alter table public.projects
  add column pool_id text,
  add column quote_asset text check (quote_asset is null or quote_asset = lower(quote_asset)),
  add column total_supply_raw numeric(78,0),
  add column seed_token_amount_raw numeric(78,0),
  add column seed_quote_amount_raw numeric(78,0),
  add column sqrt_price_x96 numeric(78,0),
  add column lp_fee integer check (lp_fee is null or lp_fee between 0 and 1000000),
  add column launch_block_hash text,
  add column canonical boolean not null default true;

alter table public.fee_configs add column canonical boolean not null default true;
alter table public.launches add column canonical boolean not null default true, add column pool_id text, add column quote_asset text;
create unique index launches_project_id_uq on public.launches (project_id);

drop policy if exists "public protocol reads projects" on public.projects;
create policy "public protocol reads projects" on public.projects for select using (not is_hidden and canonical);
drop policy if exists "public protocol reads fee configs" on public.fee_configs;
create policy "public protocol reads fee configs" on public.fee_configs for select using (canonical);
drop policy if exists "public protocol reads launches" on public.launches;
create policy "public protocol reads launches" on public.launches for select using (canonical);

create unique index projects_chain_pool_id_uq on public.projects (chain_id, pool_id) where pool_id is not null;

alter table public.fee_routing_events
  add column pool_id text,
  add column currency text check (currency is null or currency = lower(currency)),
  add column gross_amount_raw numeric(78,0),
  add column block_hash text,
  add column canonical boolean not null default true;

create table public.fee_accrual_events (
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
  swapper_address text not null check (swapper_address = lower(swapper_address)),
  raw_amount numeric(78,0) not null check (raw_amount > 0),
  canonical boolean not null default true,
  created_at timestamptz not null default now(),
  unique (chain_id, tx_hash, log_index)
);
create index fee_accrual_events_project_block_idx on public.fee_accrual_events (project_id, block_number desc);
alter table public.fee_accrual_events enable row level security;
create policy "public protocol reads fee accruals" on public.fee_accrual_events for select using (canonical);

create table public.liquidity_credit_events (
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
  raw_amount numeric(78,0) not null check (raw_amount > 0),
  canonical boolean not null default true,
  created_at timestamptz not null default now(),
  unique (chain_id, tx_hash, log_index)
);
create index liquidity_credit_events_project_block_idx on public.liquidity_credit_events (project_id, block_number desc);
alter table public.liquidity_credit_events enable row level security;
create policy "public protocol reads liquidity credits" on public.liquidity_credit_events for select using (canonical);

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
end;
$$;

create or replace view public.project_fee_distribution_summary with (security_invoker = true) as
select p.id as project_id,
  coalesce(sum(e.raw_amount) filter (where e.destination_type = 'creator' and e.canonical), 0) as creator_raw,
  coalesce(sum(e.raw_amount) filter (where e.destination_type = 'liquidity' and e.canonical), 0) as liquidity_raw,
  coalesce(sum(e.raw_amount) filter (where e.destination_type = 'treasury' and e.canonical), 0) as treasury_raw,
  coalesce(sum(e.raw_amount) filter (where e.destination_type = 'community' and e.canonical), 0) as community_raw
from public.projects p
left join public.fee_routing_events e on e.project_id = p.id
group by p.id;

create index fee_routing_events_pool_idx on public.fee_routing_events (chain_id, pool_id, block_number desc);
create index fee_routing_events_canonical_idx on public.fee_routing_events (chain_id, canonical, block_number);

-- Reorg handling marks affected log rows non-canonical; unique keys are retained so
-- replay is idempotent. Indexers should upsert those same rows back to canonical=true.
