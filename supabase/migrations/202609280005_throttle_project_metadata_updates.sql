-- One atomic claim per canonical project protects metadata writes across server instances.
-- Only the trusted server role may read or change this state or call these functions.
create table public.project_metadata_update_state (
  project_id uuid primary key references public.projects(id) on delete cascade,
  nonce bigint not null default 0 check (nonce between 0 and 9007199254740991),
  next_allowed_at timestamptz not null default '-infinity',
  claim_expires_at timestamptz
);

alter table public.project_metadata_update_state enable row level security;
revoke all on public.project_metadata_update_state from public, anon, authenticated;
grant select, insert, update on public.project_metadata_update_state to service_role;

create function public.claim_project_metadata_update(p_project_id uuid, p_expected_nonce bigint)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_nonce bigint;
begin
  if p_expected_nonce < 0 or p_expected_nonce >= 9007199254740991 then
    return null;
  end if;

  if p_expected_nonce = 0 then
    insert into public.project_metadata_update_state
      (project_id, nonce, next_allowed_at, claim_expires_at)
    values (p_project_id, 1, now() + interval '60 seconds', now() + interval '120 seconds')
    on conflict (project_id) do nothing
    returning nonce into v_nonce;
    if v_nonce is not null then
      return v_nonce;
    end if;
  end if;

  update public.project_metadata_update_state
    set nonce = nonce + 1,
        next_allowed_at = now() + interval '60 seconds',
        claim_expires_at = now() + interval '120 seconds'
    where project_id = p_project_id
      and nonce = p_expected_nonce
      and nonce < 9007199254740991
      and next_allowed_at <= now()
      and (claim_expires_at is null or claim_expires_at <= now())
    returning nonce into v_nonce;

  return v_nonce;
end;
$$;

create function public.complete_project_metadata_update(
  p_project_id uuid,
  p_claim_nonce bigint,
  p_logo_url text,
  p_description text,
  p_website_url text,
  p_x_url text,
  p_telegram_url text,
  p_discord_url text,
  p_updated_by_wallet text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.project_metadata_update_state
    set claim_expires_at = null
    where project_id = p_project_id
      and nonce = p_claim_nonce
      and claim_expires_at > now();
  if not found then
    return false;
  end if;

  insert into public.project_metadata
    (project_id, logo_url, description, website_url, x_url, telegram_url, discord_url, updated_by_wallet, updated_at)
  values
    (p_project_id, p_logo_url, p_description, p_website_url, p_x_url, p_telegram_url, p_discord_url, p_updated_by_wallet, now())
  on conflict (project_id) do update
    set logo_url = coalesce(excluded.logo_url, project_metadata.logo_url),
        description = excluded.description,
        website_url = excluded.website_url,
        x_url = excluded.x_url,
        telegram_url = excluded.telegram_url,
        discord_url = excluded.discord_url,
        updated_by_wallet = excluded.updated_by_wallet,
        updated_at = excluded.updated_at;

  return true;
end;
$$;

revoke execute on function public.claim_project_metadata_update(uuid, bigint) from public, anon, authenticated;
revoke execute on function public.complete_project_metadata_update(uuid, bigint, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_project_metadata_update(uuid, bigint) to service_role;
grant execute on function public.complete_project_metadata_update(uuid, bigint, text, text, text, text, text, text, text) to service_role;
