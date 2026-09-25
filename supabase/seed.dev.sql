-- Development only: run explicitly with the local Supabase CLI. Never run against production.
insert into public.projects (chain_id,token_address,creator_address,name,symbol,status,launched_at) values
  (4663,'0x1111111111111111111111111111111111111111','0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','SPLIT Demo One','SD1','live',now() - interval '2 days'),
  (4663,'0x2222222222222222222222222222222222222222','0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','SPLIT Demo Two','SD2','graduated',now() - interval '9 days')
on conflict (chain_id,token_address) do nothing;
