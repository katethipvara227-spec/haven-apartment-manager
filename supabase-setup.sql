create table if not exists public.haven_workspaces (
  user_id uuid primary key references auth.users (id) on delete cascade,
  workspace_data jsonb not null default '{"buildings":[],"tenants":[],"dailyBookings":[]}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint haven_workspace_data_shape check (
    jsonb_typeof(workspace_data) = 'object'
    and jsonb_typeof(workspace_data -> 'buildings') = 'array'
    and jsonb_typeof(workspace_data -> 'tenants') = 'array'
    and jsonb_typeof(workspace_data -> 'dailyBookings') = 'array'
  )
);

alter table public.haven_workspaces enable row level security;

revoke all on table public.haven_workspaces from anon, public;
grant select, insert, update on table public.haven_workspaces to authenticated;

drop policy if exists "Owners can access their Haven workspace" on public.haven_workspaces;
create policy "Owners can access their Haven workspace"
  on public.haven_workspaces
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists public.haven_public_availability (
  user_id uuid primary key references auth.users (id) on delete cascade,
  share_token uuid not null unique,
  listing_data jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  constraint haven_public_availability_data_shape check (
    jsonb_typeof(listing_data) = 'array'
  )
);

alter table public.haven_public_availability enable row level security;

revoke all on table public.haven_public_availability from anon, public;
grant select, insert, update, delete on table public.haven_public_availability to authenticated;

drop policy if exists "Owners can manage their public availability link" on public.haven_public_availability;
create policy "Owners can manage their public availability link"
  on public.haven_public_availability
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.get_haven_public_availability(p_share_token uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'buildings', listing_data,
    'updated_at', updated_at
  )
  from public.haven_public_availability
  where share_token = p_share_token;
$$;

revoke all on function public.get_haven_public_availability(uuid) from public;
grant execute on function public.get_haven_public_availability(uuid) to anon, authenticated;

create table if not exists public.haven_public_availability (
  user_id uuid primary key references auth.users (id) on delete cascade,
  share_token uuid not null unique,
  listing_data jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  constraint haven_public_availability_data_shape check (
    jsonb_typeof(listing_data) = 'array'
  )
);

alter table public.haven_public_availability enable row level security;

revoke all on table public.haven_public_availability from anon, public;
grant select, insert, update, delete on table public.haven_public_availability to authenticated;

drop policy if exists "Owners can manage their public availability link" on public.haven_public_availability;
create policy "Owners can manage their public availability link"
  on public.haven_public_availability
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.get_haven_public_availability(p_share_token uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'buildings', listing_data,
    'updated_at', updated_at
  )
  from public.haven_public_availability
  where share_token = p_share_token;
$$;

revoke all on function public.get_haven_public_availability(uuid) from public;
grant execute on function public.get_haven_public_availability(uuid) to anon, authenticated;
