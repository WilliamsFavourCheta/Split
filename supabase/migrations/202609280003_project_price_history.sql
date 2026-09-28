-- SPLIT token-detail charts: canonical post-swap prices from official v4 pools.
-- Apply this migration to Supabase before enabling price-history reads/writes.

create table public.project_price_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  chain_id bigint not null,
  pool_id text not null check (pool_id = lower(pool_id) and pool_id ~ '^0x[0-9a-f]{64}$'),
  tx_hash text not null check (tx_hash = lower(tx_hash)),
  log_index integer not null check (log_index >= 0),
  block_number bigint not null check (block_number >= 0),
  block_hash text not null check (block_hash = lower(block_hash) and block_hash ~ '^0x[0-9a-f]{64}$'),
  block_timestamp timestamptz not null,
  sqrt_price_x96 numeric(78,0) not null check (sqrt_price_x96 > 0),
  source text not null check (source in ('launch', 'swap')),
  canonical boolean not null default true,
  created_at timestamptz not null default now(),
  unique (chain_id, tx_hash, log_index)
);

create index project_price_events_chart_idx
  on public.project_price_events(project_id, block_number desc, log_index desc)
  where canonical;

alter table public.project_price_events enable row level security;
revoke all privileges on table public.project_price_events from public, anon, authenticated;
grant select, insert, update, delete on table public.project_price_events to service_role;

-- Raw sqrtPriceX96 is numeric(78,0); only expose a canonical decimal string.
create or replace view public.project_price_events_exact
  with (security_invoker = false, security_barrier = true) as
select id, project_id, chain_id, pool_id, tx_hash, log_index, block_number,
  block_hash, block_timestamp, sqrt_price_x96::text as sqrt_price_x96, source, created_at
from public.project_price_events
where canonical = true;

revoke all privileges on table public.project_price_events_exact from public, anon, authenticated, service_role;
grant select on table public.project_price_events_exact to anon, authenticated, service_role;

-- Keep chart rows on the same canonical branch as launches and fee accounting.
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
  update public.protocol_launch_fee_claim_events set canonical = false where chain_id = p_chain_id and block_number >= p_from_block;
  update public.project_price_events set canonical = false where chain_id = p_chain_id and block_number >= p_from_block;
end;
$$;

notify pgrst, 'reload schema';
