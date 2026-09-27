-- Additive V1.1 indexing support for ProtocolLaunchFeesClaimed.
-- Apply only through the approved migration workflow. No existing migration or live DB is changed here.

create table public.protocol_launch_fee_claim_events (
  id uuid primary key default gen_random_uuid(),
  chain_id bigint not null,
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

create index protocol_launch_fee_claim_events_recipient_block_idx
  on public.protocol_launch_fee_claim_events(chain_id, recipient_address, block_number desc);

alter table public.protocol_launch_fee_claim_events enable row level security;
create policy "public protocol reads canonical protocol launch fee claims"
  on public.protocol_launch_fee_claim_events for select using (canonical);

create view public.protocol_launch_fee_claim_events_exact with (security_invoker = true) as
select id, chain_id, recipient_address, tx_hash, log_index, block_number, block_hash,
  block_timestamp, raw_amount::text as raw_amount, canonical, created_at
from public.protocol_launch_fee_claim_events;

grant select on public.protocol_launch_fee_claim_events,
  public.protocol_launch_fee_claim_events_exact to anon, authenticated, service_role;

-- Extend rollback to include the new global (non-project-scoped) event table.
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
end;
$$;

notify pgrst, 'reload schema';
