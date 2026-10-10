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
