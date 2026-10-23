-- Solana data is separate from the existing EVM tables: base58 keys and
-- signatures are case-sensitive and cannot use EVM's lowercase checks.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('solana-token-metadata', 'solana-token-metadata', true, 1048576,
        array['application/json', 'image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = excluded.public,
  file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
create policy "public Solana metadata reads" on storage.objects for select
  using (bucket_id = 'solana-token-metadata');

create table public.solana_projects (
  id uuid primary key default gen_random_uuid(),
  cluster text not null check (cluster in ('devnet', 'mainnet-beta')),
  mint_address text not null check (length(mint_address) between 32 and 44),
  pool_address text not null check (length(pool_address) between 32 and 44),
  creator_address text not null check (length(creator_address) between 32 and 44),
  platform_config_address text not null check (length(platform_config_address) between 32 and 44),
  project_treasury_address text not null check (length(project_treasury_address) between 32 and 44),
  community_address text not null check (length(community_address) between 32 and 44),
  name text not null check (char_length(name) between 1 and 32),
  symbol text not null check (char_length(symbol) between 2 and 10),
  decimals integer not null check (decimals between 0 and 9),
  description text,
  logo_url text,
  website_url text,
  x_url text,
  creator_bps integer not null check (creator_bps between 0 and 10000),
  liquidity_bps integer not null check (liquidity_bps between 0 and 10000),
  treasury_bps integer not null check (treasury_bps between 0 and 10000),
  community_bps integer not null check (community_bps between 0 and 10000),
  fee_model text not null default 'router' check (fee_model in ('router', 'operator_managed')),
  status text not null check (status in ('pending', 'curve', 'bonded', 'graduated', 'failed')),
  registration_signature text,
  launch_signature text,
  graduation_signature text,
  launch_slot bigint check (launch_slot >= 0),
  finalized boolean not null default false,
  is_hidden boolean not null default false,
  launched_at timestamptz,
  graduated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cluster, mint_address),
  unique (cluster, pool_address),
  check (creator_bps + liquidity_bps + treasury_bps + community_bps = 10000)
);
create index solana_projects_creator_idx on public.solana_projects (cluster, creator_address, launched_at desc);
create index solana_projects_status_idx on public.solana_projects (cluster, status, launched_at desc);
create trigger solana_projects_updated_at before update on public.solana_projects for each row execute function public.set_updated_at();

create table public.solana_trades (
  project_id uuid not null references public.solana_projects(id) on delete cascade,
  signature text not null,
  event_index integer not null check (event_index >= 0),
  slot bigint not null check (slot >= 0),
  traded_at timestamptz not null,
  side text not null check (side in ('buy', 'sell')),
  base_amount_raw numeric(20,0) not null check (base_amount_raw > 0),
  quote_amount_raw numeric(20,0) not null check (quote_amount_raw >= 0),
  price_sol numeric(40,20) not null check (price_sol >= 0),
  finalized boolean not null default false,
  primary key (project_id, signature, event_index)
);
create index solana_trades_project_time_idx on public.solana_trades (project_id, traded_at desc);
create index solana_trades_project_slot_idx on public.solana_trades (project_id, slot desc);

create table public.solana_fee_events (
  project_id uuid not null references public.solana_projects(id) on delete cascade,
  signature text not null,
  event_index integer not null check (event_index >= 0),
  slot bigint not null check (slot >= 0),
  event_type text not null check (event_type in ('allocated', 'claimed')),
  destination text not null check (destination in ('protocol', 'creator', 'liquidity', 'project_treasury', 'community')),
  gross_wsol_raw numeric(20,0) check (gross_wsol_raw >= 0),
  amount_wsol_raw numeric(20,0) not null check (amount_wsol_raw >= 0),
  recipient_address text,
  finalized boolean not null default false,
  recorded_at timestamptz not null,
  primary key (project_id, signature, event_index, destination)
);
create index solana_fee_events_project_time_idx on public.solana_fee_events (project_id, recorded_at desc);

create table public.solana_price_samples (
  project_id uuid not null references public.solana_projects(id) on delete cascade,
  slot bigint not null check (slot >= 0),
  sampled_at timestamptz not null,
  price_sol numeric(40,20) not null check (price_sol >= 0),
  sol_usd numeric(24,8) check (sol_usd >= 0),
  price_usd numeric(40,20) check (price_usd >= 0),
  market_cap_usd numeric(40,8) check (market_cap_usd >= 0),
  circulating_supply_raw numeric(30,0) not null check (circulating_supply_raw >= 0),
  finalized boolean not null default false,
  primary key (project_id, slot)
);
create index solana_price_samples_time_idx on public.solana_price_samples (project_id, sampled_at desc);

create table public.solana_indexer_state (
  cluster text not null check (cluster in ('devnet', 'mainnet-beta')),
  stream_name text not null,
  last_finalized_slot bigint not null check (last_finalized_slot >= 0),
  updated_at timestamptz not null default now(),
  primary key (cluster, stream_name)
);

alter table public.solana_projects enable row level security;
alter table public.solana_trades enable row level security;
alter table public.solana_fee_events enable row level security;
alter table public.solana_price_samples enable row level security;
alter table public.solana_indexer_state enable row level security;

create policy "public reads finalized Solana projects" on public.solana_projects
  for select using (finalized and not is_hidden);
create policy "public reads finalized Solana trades" on public.solana_trades
  for select using (finalized and exists (select 1 from public.solana_projects p where p.id = project_id and p.finalized and not p.is_hidden));
create policy "public reads finalized Solana fee events" on public.solana_fee_events
  for select using (finalized and exists (select 1 from public.solana_projects p where p.id = project_id and p.finalized and not p.is_hidden));
create policy "public reads finalized Solana prices" on public.solana_price_samples
  for select using (finalized and exists (select 1 from public.solana_projects p where p.id = project_id and p.finalized and not p.is_hidden));
-- No browser write policies. A verified finalized-slot indexer owns writes.
