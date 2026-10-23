-- Routerless fee receipts are attributable only to a verified per-pool Raydium claim.
create table public.solana_admin_challenges (
  nonce text primary key,
  cluster text not null check (cluster in ('devnet', 'mainnet-beta')),
  purpose text not null check (purpose in ('claim', 'receipt', 'payout')),
  mint_address text not null,
  expires_at timestamptz not null,
  used_at timestamptz
);
create index solana_admin_challenges_expiry_idx on public.solana_admin_challenges (expires_at);
alter table public.solana_admin_challenges enable row level security;

create or replace function public.consume_solana_admin_challenge(p_nonce text, p_cluster text, p_purpose text, p_mint text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.solana_admin_challenges set used_at = now()
  where nonce = p_nonce and cluster = p_cluster and purpose = p_purpose
    and mint_address = p_mint and used_at is null and expires_at > now();
  return found;
end;
$$;
revoke all on function public.consume_solana_admin_challenge(text,text,text,text) from public, anon, authenticated;
grant execute on function public.consume_solana_admin_challenge(text,text,text,text) to service_role;

create table public.solana_fee_receipts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.solana_projects(id),
  signature text not null,
  slot bigint not null check (slot >= 0),
  amount_wsol_raw numeric(20,0) not null check (amount_wsol_raw > 0),
  recipient_token_account text not null,
  finalized boolean not null default true,
  recorded_at timestamptz not null default now(),
  unique (project_id, signature)
);
create table public.solana_fee_allocations (
  receipt_id uuid not null references public.solana_fee_receipts(id),
  destination text not null check (destination in ('protocol', 'creator', 'liquidity', 'project_treasury', 'community')),
  recipient_address text,
  amount_wsol_raw numeric(20,0) not null check (amount_wsol_raw >= 0),
  primary key (receipt_id, destination)
);
create table public.solana_payouts (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.solana_fee_receipts(id),
  destination text not null check (destination in ('protocol', 'creator', 'project_treasury', 'community')),
  recipient_address text not null,
  amount_wsol_raw numeric(20,0) not null check (amount_wsol_raw > 0),
  signature text not null,
  instruction_index integer not null check (instruction_index >= 0),
  slot bigint not null check (slot >= 0),
  finalized boolean not null default true,
  recorded_at timestamptz not null default now(),
  unique (signature, instruction_index)
);
create index solana_fee_receipts_project_idx on public.solana_fee_receipts (project_id, slot desc);
create index solana_payouts_receipt_idx on public.solana_payouts (receipt_id);
alter table public.solana_fee_receipts enable row level security;
alter table public.solana_fee_allocations enable row level security;
alter table public.solana_payouts enable row level security;
create policy "public finalized routerless receipts" on public.solana_fee_receipts for select using (
  finalized and exists (select 1 from public.solana_projects p where p.id = project_id and p.finalized and not p.is_hidden));
create policy "public finalized routerless allocations" on public.solana_fee_allocations for select using (
  exists (select 1 from public.solana_fee_receipts r join public.solana_projects p on p.id = r.project_id
    where r.id = receipt_id and r.finalized and p.finalized and not p.is_hidden));
create policy "public finalized routerless payouts" on public.solana_payouts for select using (
  finalized and exists (select 1 from public.solana_fee_receipts r join public.solana_projects p on p.id = r.project_id
    where r.id = receipt_id and r.finalized and p.finalized and not p.is_hidden));

create or replace function public.record_solana_fee_receipt(
  p_project_id uuid, p_signature text, p_slot bigint, p_amount numeric,
  p_recipient_token_account text, p_allocations jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_receipt uuid;
begin
  if p_amount <= 0 or jsonb_array_length(p_allocations) <> 5
    or (select coalesce(sum((item->>'amount')::numeric),0) from jsonb_array_elements(p_allocations) item) <> p_amount
    or (select count(distinct item->>'destination') from jsonb_array_elements(p_allocations) item) <> 5 then
    raise exception 'Invalid receipt allocations';
  end if;
  insert into public.solana_fee_receipts(project_id,signature,slot,amount_wsol_raw,recipient_token_account)
  values(p_project_id,p_signature,p_slot,p_amount,p_recipient_token_account) returning id into v_receipt;
  insert into public.solana_fee_allocations(receipt_id,destination,recipient_address,amount_wsol_raw)
  select v_receipt,item->>'destination',item->>'recipient',(item->>'amount')::numeric
  from jsonb_array_elements(p_allocations) item;
  return v_receipt;
end;
$$;
revoke all on function public.record_solana_fee_receipt(uuid,text,bigint,numeric,text,jsonb) from public, anon, authenticated;
grant execute on function public.record_solana_fee_receipt(uuid,text,bigint,numeric,text,jsonb) to service_role;

create or replace function public.record_solana_payout(
  p_receipt_id uuid, p_destination text, p_recipient text, p_amount numeric,
  p_signature text, p_instruction_index integer, p_slot bigint)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_due numeric; v_paid numeric; v_id uuid;
begin
  select amount_wsol_raw into v_due from public.solana_fee_allocations
    where receipt_id = p_receipt_id and destination = p_destination and recipient_address = p_recipient
    for update;
  if v_due is null or p_amount <= 0 then raise exception 'Payout destination is not owed'; end if;
  select coalesce(sum(amount_wsol_raw),0) into v_paid from public.solana_payouts
    where receipt_id = p_receipt_id and destination = p_destination and finalized;
  if v_paid + p_amount > v_due then raise exception 'Payout exceeds outstanding allocation'; end if;
  insert into public.solana_payouts(receipt_id,destination,recipient_address,amount_wsol_raw,signature,instruction_index,slot)
  values(p_receipt_id,p_destination,p_recipient,p_amount,p_signature,p_instruction_index,p_slot) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.record_solana_payout(uuid,text,text,numeric,text,integer,bigint) from public, anon, authenticated;
grant execute on function public.record_solana_payout(uuid,text,text,numeric,text,integer,bigint) to service_role;
