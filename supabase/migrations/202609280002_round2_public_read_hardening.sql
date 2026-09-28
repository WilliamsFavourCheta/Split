-- SPLIT V1.1.1 Round 2 follow-up: harden the public exact claim view and
-- make table-level access explicit. Apply AFTER 202609280001.
-- This migration changes privileges/view options only; it does not alter data.

-- The exact view intentionally exposes only canonical claim rows as decimal
-- text. It is owner-executed because anon/authenticated must not receive direct
-- SELECT on the numeric(78,0) base column. Make the canonical predicate a
-- security barrier so caller-supplied filters cannot be pushed ahead of it.
alter view public.protocol_launch_fee_claim_events_exact
  set (security_invoker = false, security_barrier = true);

-- Remove any inherited/default grants, including grants to PUBLIC. The
-- indexer service role retains the DML privileges required for exact writes
-- and canonical rollback; public API roles can read only through the view.
revoke all privileges on table public.protocol_launch_fee_claim_events
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.protocol_launch_fee_claim_events to service_role;

revoke all privileges on table public.protocol_launch_fee_claim_events_exact
  from public, anon, authenticated, service_role;
grant select on table public.protocol_launch_fee_claim_events_exact
  to anon, authenticated, service_role;

-- Checkpoint history is private indexer state. RLS remains enabled and there
-- are deliberately no anon/authenticated policies; these revokes also remove
-- any explicit/default table grants those roles might otherwise have.
alter table public.indexer_block_checkpoints enable row level security;
revoke all privileges on table public.indexer_block_checkpoints
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.indexer_block_checkpoints to service_role;

notify pgrst, 'reload schema';
