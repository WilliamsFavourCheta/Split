-- SPLIT indexed data and metadata. Robinhood Chain remains the protocol source of truth.
create extension if not exists pgcrypto;

create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create table public.projects (
  id uuid primary key default gen_random_uuid(), chain_id bigint not null, token_address text not null check (token_address = lower(token_address)), creator_address text not null check (creator_address = lower(creator_address)),
  name text not null, symbol text not null, description text, logo_url text, website_url text, x_url text, telegram_url text, discord_url text,
  status text not null check (status in ('pending','live','graduated','failed')), launch_tx_hash text, launch_block_number bigint, launched_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), metadata_updated_at timestamptz, verified boolean not null default false, is_hidden boolean not null default false,
  unique (chain_id, token_address)
);
create index projects_creator_address_idx on public.projects (creator_address);
create index projects_status_idx on public.projects (status);
create index projects_launched_at_idx on public.projects (launched_at desc);
create index projects_symbol_idx on public.projects (symbol);
create index projects_name_idx on public.projects (name);

create table public.fee_configs (
  id uuid primary key default gen_random_uuid(), project_id uuid not null unique references public.projects(id) on delete cascade,
  creator_bps integer not null check (creator_bps >= 0), liquidity_bps integer not null check (liquidity_bps >= 0), treasury_bps integer not null check (treasury_bps >= 0), community_bps integer not null check (community_bps >= 0),
  creator_destination text check (creator_destination = lower(creator_destination)), treasury_destination text check (treasury_destination = lower(treasury_destination)), community_destination text check (community_destination = lower(community_destination)), liquidity_strategy_address text check (liquidity_strategy_address = lower(liquidity_strategy_address)),
  config_tx_hash text, block_number bigint, configured_at timestamptz, is_immutable boolean not null default true, created_at timestamptz not null default now(),
  check (creator_bps + liquidity_bps + treasury_bps + community_bps = 10000)
);

create table public.fee_routing_events (
  id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade, chain_id bigint not null,
  tx_hash text not null, log_index integer not null, block_number bigint not null, block_timestamp timestamptz,
  destination_type text not null check (destination_type in ('creator','liquidity','treasury','community')), destination_address text check (destination_address = lower(destination_address)), token_address text check (token_address = lower(token_address)), raw_amount numeric(78,0) not null check (raw_amount >= 0), token_decimals integer check (token_decimals between 0 and 255), created_at timestamptz not null default now(),
  unique (chain_id, tx_hash, log_index)
);
create index fee_routing_events_project_idx on public.fee_routing_events (project_id, block_timestamp desc);
create index fee_routing_events_block_idx on public.fee_routing_events (block_number);
create index fee_routing_events_destination_type_idx on public.fee_routing_events (destination_type);
create index fee_routing_events_destination_address_idx on public.fee_routing_events (destination_address);

create table public.launches (
  id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade, creator_address text not null check (creator_address = lower(creator_address)), factory_address text check (factory_address = lower(factory_address)), token_address text check (token_address = lower(token_address)), pool_address text check (pool_address = lower(pool_address)), pair_token_address text check (pair_token_address = lower(pair_token_address)), launch_tx_hash text, launch_block_number bigint, launch_timestamp timestamptz, graduation_tx_hash text, graduated_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index launches_project_idx on public.launches (project_id);

create table public.project_metrics (
  id uuid primary key default gen_random_uuid(), project_id uuid not null unique references public.projects(id) on delete cascade,
  price_usd numeric, market_cap_usd numeric, volume_24h_usd numeric, liquidity_usd numeric, holder_count bigint,
  total_fees_raw numeric(78,0), creator_fees_raw numeric(78,0), liquidity_fees_raw numeric(78,0), treasury_fees_raw numeric(78,0), community_fees_raw numeric(78,0), last_indexed_block bigint, calculated_at timestamptz, updated_at timestamptz not null default now()
);

create table public.metric_snapshots (
  id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade,
  price_usd numeric, market_cap_usd numeric, volume_usd numeric, liquidity_usd numeric, holder_count bigint, total_fees_raw numeric(78,0), snapshot_at timestamptz not null, created_at timestamptz not null default now()
);
create index metric_snapshots_project_time_idx on public.metric_snapshots (project_id, snapshot_at desc);

create table public.project_metadata (
  id uuid primary key default gen_random_uuid(), project_id uuid not null unique references public.projects(id) on delete cascade, description text, logo_url text, banner_url text, website_url text, x_url text, telegram_url text, discord_url text, updated_by_wallet text check (updated_by_wallet = lower(updated_by_wallet)), updated_at timestamptz not null default now()
);
create table public.wallet_profiles (id uuid primary key default gen_random_uuid(), wallet_address text not null unique check (wallet_address = lower(wallet_address)), display_name text, avatar_url text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.user_preferences (id uuid primary key default gen_random_uuid(), wallet_address text not null unique check (wallet_address = lower(wallet_address)), theme text not null default 'dark', email_notifications boolean not null default false, browser_notifications boolean not null default false, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.project_watchlist (id uuid primary key default gen_random_uuid(), wallet_address text not null check (wallet_address = lower(wallet_address)), project_id uuid not null references public.projects(id) on delete cascade, created_at timestamptz not null default now(), unique(wallet_address, project_id));
create table public.indexer_state (id uuid primary key default gen_random_uuid(), chain_id bigint not null, contract_address text not null check (contract_address = lower(contract_address)), last_processed_block bigint not null, last_processed_block_hash text, updated_at timestamptz not null default now(), unique(chain_id, contract_address));

create or replace view public.project_fee_distribution_summary as
select p.id as project_id, coalesce(sum(e.raw_amount) filter (where e.destination_type = 'creator'), 0) as creator_raw, coalesce(sum(e.raw_amount) filter (where e.destination_type = 'liquidity'), 0) as liquidity_raw, coalesce(sum(e.raw_amount) filter (where e.destination_type = 'treasury'), 0) as treasury_raw, coalesce(sum(e.raw_amount) filter (where e.destination_type = 'community'), 0) as community_raw from public.projects p left join public.fee_routing_events e on e.project_id = p.id group by p.id;

create trigger projects_updated_at before update on public.projects for each row execute function public.set_updated_at();
create trigger launches_updated_at before update on public.launches for each row execute function public.set_updated_at();
create trigger metrics_updated_at before update on public.project_metrics for each row execute function public.set_updated_at();
create trigger wallet_profiles_updated_at before update on public.wallet_profiles for each row execute function public.set_updated_at();
create trigger user_preferences_updated_at before update on public.user_preferences for each row execute function public.set_updated_at();

alter table public.projects enable row level security; alter table public.fee_configs enable row level security; alter table public.fee_routing_events enable row level security; alter table public.launches enable row level security; alter table public.project_metrics enable row level security; alter table public.metric_snapshots enable row level security; alter table public.project_metadata enable row level security; alter table public.wallet_profiles enable row level security; alter table public.user_preferences enable row level security; alter table public.project_watchlist enable row level security; alter table public.indexer_state enable row level security;
create policy "public protocol reads projects" on public.projects for select using (not is_hidden);
create policy "public protocol reads fee configs" on public.fee_configs for select using (true);
create policy "public protocol reads routing events" on public.fee_routing_events for select using (true);
create policy "public protocol reads launches" on public.launches for select using (true);
create policy "public protocol reads metrics" on public.project_metrics for select using (true);
create policy "public protocol reads snapshots" on public.metric_snapshots for select using (true);
create policy "public protocol reads metadata" on public.project_metadata for select using (true);
-- No client write policies. Service-role indexers bypass RLS; wallet signature auth will add scoped metadata policies later.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('project-assets','project-assets',true,5242880,array['image/png','image/jpeg','image/webp']) on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
create policy "public project asset reads" on storage.objects for select using (bucket_id = 'project-assets');
