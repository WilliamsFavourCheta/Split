-- Review manually before applying. The exact two addresses below came from
-- supabase/seed.dev.sql and are not official SPLIT factory launches.
-- Preserve rows for auditability; remove them from canonical public reads.
update public.projects
set canonical = false, is_hidden = true
where chain_id = 4663
  and token_address in (
    '0x1111111111111111111111111111111111111111',
    '0x2222222222222222222222222222222222222222'
  )
  and launch_tx_hash is null
  and pool_id is null;
