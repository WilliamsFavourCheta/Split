-- SPLIT V1.1.1 Round 2: exact public reads and trusted indexer reorg checkpoints.
-- Forward-only additive migration. Do not apply until reviewed/approved.

-- Prevent anon/authenticated users from reading numeric(78,0) directly through
-- PostgREST, while preserving indexer/service-role access and exact-string reads.
revoke select on table public.protocol_launch_fee_claim_events from anon, authenticated;
grant select, insert, update, delete on table public.protocol_launch_fee_claim_events to service_role;

-- Use the view owner's table access, but explicitly constrain the view to
-- canonical rows because the owner may bypass the base-table RLS policy.
create or replace view public.protocol_launch_fee_claim_events_exact
  with (security_invoker = false) as
select id, chain_id, recipient_address, tx_hash, log_index, block_number, block_hash,
  block_timestamp, raw_amount::text as raw_amount, canonical, created_at
from public.protocol_launch_fee_claim_events
where canonical = true;

grant select on table public.protocol_launch_fee_claim_events_exact to anon, authenticated, service_role;

-- Store sparse, service-role-only hashes from the previously indexed branch.
-- These are required to prove an automatic common ancestor after deep reorgs.
create table public.indexer_block_checkpoints (
  chain_id bigint not null,
  contract_address text not null check (contract_address = lower(contract_address)),
  block_number bigint not null check (block_number >= 0),
  block_hash text not null check (block_hash ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (chain_id, contract_address, block_number)
);

create index indexer_block_checkpoints_lookup_idx
  on public.indexer_block_checkpoints(chain_id, contract_address, block_number desc);

alter table public.indexer_block_checkpoints enable row level security;
grant select, insert, update, delete on table public.indexer_block_checkpoints to service_role;

-- Preserve the current checkpoint as the starting trusted record. If it is
-- already orphaned, automatic verification will skip it and search older rows;
-- if no earlier row exists, indexing fails safely before financial rollback.
insert into public.indexer_block_checkpoints(chain_id, contract_address, block_number, block_hash)
select chain_id, lower(contract_address), last_processed_block, lower(last_processed_block_hash)
from public.indexer_state
where last_processed_block_hash is not null
on conflict (chain_id, contract_address, block_number) do nothing;

notify pgrst, 'reload schema';
