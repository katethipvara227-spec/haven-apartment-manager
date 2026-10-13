create table if not exists public.haven_room_manager_access (
  user_id uuid primary key references auth.users (id) on delete cascade,
  access_token uuid not null unique,
  updated_at timestamptz not null default now()
);

alter table public.haven_room_manager_access enable row level security;

revoke all on table public.haven_room_manager_access from anon, public, authenticated;
grant select on table public.haven_room_manager_access to authenticated;

drop policy if exists "Owners can manage their room manager access" on public.haven_room_manager_access;
drop policy if exists "Owners can read their room manager access" on public.haven_room_manager_access;
create policy "Owners can read their room manager access"
  on public.haven_room_manager_access
  for select
  to authenticated
  using (auth.uid() = user_id);

create table if not exists public.haven_room_holds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  building_id text not null,
  unit_id text not null,
  start_date date not null,
  end_date date not null,
  created_at timestamptz not null default now(),
  constraint haven_room_hold_dates check (end_date > start_date)
);

create index if not exists haven_room_holds_user_room_dates
  on public.haven_room_holds (user_id, unit_id, start_date, end_date);

alter table public.haven_room_holds enable row level security;
revoke all on table public.haven_room_holds from anon, public, authenticated;
grant select on table public.haven_room_holds to authenticated;
drop policy if exists "Owners can read their room holds" on public.haven_room_holds;
create policy "Owners can read their room holds"
  on public.haven_room_holds
  for select
  to authenticated
  using (auth.uid() = user_id);

create table if not exists public.haven_room_manager_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  action text not null check (action in ('update_room', 'create_hold', 'cancel_hold')),
  building_id text not null,
  unit_id text not null,
  request_data jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz
);

create index if not exists haven_room_manager_requests_owner_pending
  on public.haven_room_manager_requests (user_id, status, requested_at);

alter table public.haven_room_manager_requests enable row level security;
revoke all on table public.haven_room_manager_requests from anon, public, authenticated;
grant select on table public.haven_room_manager_requests to authenticated;
drop policy if exists "Owners can read their room management requests" on public.haven_room_manager_requests;
create policy "Owners can read their room management requests"
  on public.haven_room_manager_requests
  for select
  to authenticated
  using (auth.uid() = user_id);

create or replace function public.rotate_haven_room_manager_access()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_access_token uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in to Haven to manage NATO room access.';
  end if;

  update public.haven_room_manager_requests
     set status = 'rejected', decided_at = pg_catalog.now()
   where user_id = auth.uid()
     and status = 'pending';

  v_access_token := gen_random_uuid();
  insert into public.haven_room_manager_access (user_id, access_token, updated_at)
  values (auth.uid(), v_access_token, pg_catalog.now())
  on conflict (user_id) do update
    set access_token = excluded.access_token,
        updated_at = excluded.updated_at;
  return v_access_token;
end;
$$;

create or replace function public.revoke_haven_room_manager_access()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to Haven to manage NATO room access.';
  end if;

  update public.haven_room_manager_requests
     set status = 'rejected', decided_at = pg_catalog.now()
   where user_id = auth.uid()
     and status = 'pending';
  delete from public.haven_room_manager_access
   where user_id = auth.uid();
  return true;
end;
$$;

create or replace function public.get_haven_room_manager(p_access_token uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_workspace jsonb;
  v_updated_at timestamptz;
  v_buildings jsonb;
  v_holds jsonb;
  v_requests jsonb;
begin
  select access.user_id
    into v_user_id
    from public.haven_room_manager_access as access
   where access.access_token = p_access_token;

  if v_user_id is null then
    return null;
  end if;

  select workspace.workspace_data, workspace.updated_at
    into v_workspace, v_updated_at
    from public.haven_workspaces as workspace
   where workspace.user_id = v_user_id;

  if v_workspace is null then
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', building.value ->> 'id',
    'name', building.value ->> 'name',
    'rooms', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', room.value ->> 'id',
        'number', room.value ->> 'number',
        'floor', coalesce(room.value ->> 'floor', ''),
        'rent', coalesce(room.value -> 'rent', '0'::jsonb),
        'cooling', coalesce(room.value ->> 'cooling', 'none'),
        'occupied', exists (
          select 1
            from jsonb_array_elements(coalesce(v_workspace -> 'tenants', '[]'::jsonb)) as tenant(value)
           where tenant.value ->> 'status' = 'current'
             and tenant.value ->> 'unitId' = room.value ->> 'id'
        ),
        'dailyBookedToday', exists (
          select 1
            from jsonb_array_elements(coalesce(v_workspace -> 'dailyBookings', '[]'::jsonb)) as booking(value)
           where booking.value ->> 'status' <> 'cancelled'
             and booking.value ->> 'unitId' = room.value ->> 'id'
             and (booking.value ->> 'checkIn')::date <= current_date
             and (booking.value ->> 'checkOut')::date > current_date
        )
      )), '[]'::jsonb)
        from jsonb_array_elements(coalesce(building.value -> 'units', '[]'::jsonb)) as room(value)
    )
  )), '[]'::jsonb)
    into v_buildings
    from jsonb_array_elements(coalesce(v_workspace -> 'buildings', '[]'::jsonb)) as building(value);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', hold.id,
    'buildingId', hold.building_id,
    'unitId', hold.unit_id,
    'startDate', hold.start_date,
    'endDate', hold.end_date
  ) order by hold.start_date), '[]'::jsonb)
    into v_holds
    from public.haven_room_holds as hold
   where hold.user_id = v_user_id
     and hold.end_date > current_date;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', request.id,
    'action', request.action,
    'buildingId', request.building_id,
    'unitId', request.unit_id,
    'requestData', request.request_data,
    'requestedAt', request.requested_at
  ) order by request.requested_at), '[]'::jsonb)
    into v_requests
    from public.haven_room_manager_requests as request
   where request.user_id = v_user_id
     and request.status = 'pending';

  return jsonb_build_object(
    'buildings', v_buildings,
    'holds', v_holds,
    'pendingRequests', v_requests,
    'updatedAt', v_updated_at
  );
end;
$$;

create or replace function public.request_haven_room_change(
  p_access_token uuid,
  p_action text,
  p_building_id text,
  p_unit_id text,
  p_request_data jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_workspace jsonb;
  v_building jsonb;
  v_unit_exists boolean;
  v_hold public.haven_room_holds%rowtype;
  v_request_id uuid;
  v_start_date date;
  v_end_date date;
begin
  select access.user_id
    into v_user_id
    from public.haven_room_manager_access as access
   where access.access_token = p_access_token;
  if v_user_id is null then
    raise exception 'Invalid room manager access link.';
  end if;
  if p_request_data is null or pg_catalog.jsonb_typeof(p_request_data) <> 'object' then
    raise exception 'The room-management request is not valid.';
  end if;

  select workspace.workspace_data
    into v_workspace
    from public.haven_workspaces as workspace
   where workspace.user_id = v_user_id;
  if v_workspace is null then
    raise exception 'The Haven workspace could not be found.';
  end if;

  select building.value
    into v_building
    from jsonb_array_elements(coalesce(v_workspace -> 'buildings', '[]'::jsonb)) as building(value)
   where building.value ->> 'id' = p_building_id;
  if v_building is null then
    raise exception 'The building could not be found.';
  end if;

  select exists (
    select 1
      from jsonb_array_elements(coalesce(v_building -> 'units', '[]'::jsonb)) as room(value)
     where room.value ->> 'id' = p_unit_id
  ) into v_unit_exists;
  if not v_unit_exists then
    raise exception 'The room could not be found.';
  end if;

  if p_action = 'update_room' then
    if pg_catalog.jsonb_object_length(p_request_data) <> 4
       or not (p_request_data ?& array['number', 'floor', 'rent', 'cooling'])
       or pg_catalog.jsonb_typeof(p_request_data -> 'number') <> 'string'
       or pg_catalog.jsonb_typeof(p_request_data -> 'floor') <> 'string'
       or pg_catalog.jsonb_typeof(p_request_data -> 'rent') <> 'number'
       or pg_catalog.jsonb_typeof(p_request_data -> 'cooling') <> 'string'
       or btrim(p_request_data ->> 'number') = ''
       or length(btrim(p_request_data ->> 'number')) > 30
       or btrim(p_request_data ->> 'floor') = ''
       or length(btrim(p_request_data ->> 'floor')) > 30
       or (p_request_data ->> 'rent')::numeric < 0
       or (p_request_data ->> 'rent')::numeric > 100000000
       or p_request_data ->> 'cooling' not in ('ac', 'fan', 'none') then
      raise exception 'Check the room number, floor, rent, and room type.';
    end if;
  elsif p_action = 'create_hold' then
    if pg_catalog.jsonb_object_length(p_request_data) <> 2
       or not (p_request_data ?& array['startDate', 'endDate'])
       or pg_catalog.jsonb_typeof(p_request_data -> 'startDate') <> 'string'
       or pg_catalog.jsonb_typeof(p_request_data -> 'endDate') <> 'string'
       or p_request_data ->> 'startDate' !~ '^\d{4}-\d{2}-\d{2}$'
       or p_request_data ->> 'endDate' !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'Enter a valid start and end date for the hold.';
    end if;
    v_start_date := (p_request_data ->> 'startDate')::date;
    v_end_date := (p_request_data ->> 'endDate')::date;
    if v_start_date < current_date or v_end_date <= v_start_date
       or v_end_date > v_start_date + 90 then
      raise exception 'Choose today or a future start date and an end date within 90 days.';
    end if;
  elsif p_action = 'cancel_hold' then
    if pg_catalog.jsonb_object_length(p_request_data) <> 1
       or not (p_request_data ? 'holdId')
       or pg_catalog.jsonb_typeof(p_request_data -> 'holdId') <> 'string' then
      raise exception 'The hold-removal request is not valid.';
    end if;
    select hold.*
      into v_hold
      from public.haven_room_holds as hold
     where hold.id = (p_request_data ->> 'holdId')::uuid
       and hold.user_id = v_user_id
       and hold.building_id = p_building_id
       and hold.unit_id = p_unit_id
       and hold.end_date > current_date;
    if v_hold.id is null then
      raise exception 'The active room hold could not be found.';
    end if;
  else
    raise exception 'This room-management action is not supported.';
  end if;

  if (
    select count(*)
      from public.haven_room_manager_requests as request
     where request.user_id = v_user_id
       and request.status = 'pending'
  ) >= 20 then
    raise exception 'There are already 20 pending room requests. Ask the Haven owner to review them before adding another.';
  end if;

  insert into public.haven_room_manager_requests (
    user_id, action, building_id, unit_id, request_data
  ) values (
    v_user_id, p_action, p_building_id, p_unit_id, p_request_data
  ) returning id into v_request_id;
  return v_request_id;
end;
$$;

create or replace function public.approve_haven_room_manager_request(p_request_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.haven_room_manager_requests%rowtype;
  v_workspace jsonb;
  v_building jsonb;
  v_building_index integer;
  v_unit_index integer;
  v_unit_id text;
  v_number text;
  v_floor text;
  v_rent numeric;
  v_cooling text;
  v_start_date date;
  v_end_date date;
  v_hold_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in to Haven to approve room-management requests.';
  end if;

  select request.*
    into v_request
    from public.haven_room_manager_requests as request
   where request.id = p_request_id
     and request.user_id = auth.uid()
     and request.status = 'pending'
   for update;
  if v_request.id is null then
    raise exception 'This pending room-management request could not be found.';
  end if;

  select workspace.workspace_data
    into v_workspace
    from public.haven_workspaces as workspace
   where workspace.user_id = v_request.user_id
   for update;
  if v_workspace is null then
    raise exception 'The Haven workspace could not be found.';
  end if;

  if v_request.action in ('update_room', 'create_hold') then
    select building.value
      into v_building
      from jsonb_array_elements(coalesce(v_workspace -> 'buildings', '[]'::jsonb)) as building(value)
     where building.value ->> 'id' = v_request.building_id;
    if v_building is null then
      raise exception 'The building no longer exists.';
    end if;
    select (room.ordinality - 1)::integer
      into v_unit_index
      from jsonb_array_elements(coalesce(v_building -> 'units', '[]'::jsonb)) with ordinality as room(value, ordinality)
     where room.value ->> 'id' = v_request.unit_id;
    if v_unit_index is null then
      raise exception 'The room no longer exists.';
    end if;
  end if;

  if v_request.action = 'update_room' then
    v_number := btrim(v_request.request_data ->> 'number');
    v_floor := btrim(v_request.request_data ->> 'floor');
    v_rent := (v_request.request_data ->> 'rent')::numeric;
    v_cooling := v_request.request_data ->> 'cooling';
    select (building.ordinality - 1)::integer
      into v_building_index
      from jsonb_array_elements(coalesce(v_workspace -> 'buildings', '[]'::jsonb)) with ordinality as building(value, ordinality)
     where building.value ->> 'id' = v_request.building_id;
    if exists (
      select 1
        from jsonb_array_elements(coalesce(v_building -> 'units', '[]'::jsonb)) as room(value)
       where room.value ->> 'id' <> v_request.unit_id
         and lower(room.value ->> 'number') = lower(v_number)
    ) then
      raise exception 'That room number is already used in this building.';
    end if;
    v_workspace := pg_catalog.jsonb_set(v_workspace,
      array['buildings', v_building_index::text, 'units', v_unit_index::text, 'number'],
      pg_catalog.to_jsonb(v_number), false);
    v_workspace := pg_catalog.jsonb_set(v_workspace,
      array['buildings', v_building_index::text, 'units', v_unit_index::text, 'floor'],
      pg_catalog.to_jsonb(v_floor), true);
    v_workspace := pg_catalog.jsonb_set(v_workspace,
      array['buildings', v_building_index::text, 'units', v_unit_index::text, 'rent'],
      pg_catalog.to_jsonb(v_rent), true);
    v_workspace := pg_catalog.jsonb_set(v_workspace,
      array['buildings', v_building_index::text, 'units', v_unit_index::text, 'cooling'],
      pg_catalog.to_jsonb(v_cooling), true);
    update public.haven_workspaces
       set workspace_data = v_workspace, updated_at = pg_catalog.now()
     where user_id = v_request.user_id;
  elsif v_request.action = 'create_hold' then
    v_start_date := (v_request.request_data ->> 'startDate')::date;
    v_end_date := (v_request.request_data ->> 'endDate')::date;
    if v_start_date < current_date or v_end_date <= v_start_date
       or v_end_date > v_start_date + 90 then
      raise exception 'The requested hold dates are no longer valid.';
    end if;
    if exists (
      select 1
        from jsonb_array_elements(coalesce(v_workspace -> 'tenants', '[]'::jsonb)) as tenant(value)
       where tenant.value ->> 'status' = 'current'
         and tenant.value ->> 'unitId' = v_request.unit_id
         and (tenant.value ->> 'startDate')::date < v_end_date
         and v_start_date < (tenant.value ->> 'endDate')::date
    ) then
      raise exception 'A current monthly tenancy now overlaps these dates.';
    end if;
    if exists (
      select 1
        from jsonb_array_elements(coalesce(v_workspace -> 'dailyBookings', '[]'::jsonb)) as booking(value)
       where booking.value ->> 'status' <> 'cancelled'
         and booking.value ->> 'unitId' = v_request.unit_id
         and (booking.value ->> 'checkIn')::date < v_end_date
         and v_start_date < (booking.value ->> 'checkOut')::date
    ) then
      raise exception 'A daily booking now overlaps these dates.';
    end if;
    if exists (
      select 1
        from public.haven_room_holds as hold
       where hold.user_id = v_request.user_id
         and hold.unit_id = v_request.unit_id
         and hold.end_date > v_start_date
         and v_end_date > hold.start_date
    ) then
      raise exception 'Another room hold now overlaps these dates.';
    end if;
    insert into public.haven_room_holds (user_id, building_id, unit_id, start_date, end_date)
    values (v_request.user_id, v_request.building_id, v_request.unit_id, v_start_date, v_end_date)
    returning id into v_hold_id;
  elsif v_request.action = 'cancel_hold' then
    delete from public.haven_room_holds
     where id = (v_request.request_data ->> 'holdId')::uuid
       and user_id = v_request.user_id
       and building_id = v_request.building_id
       and unit_id = v_request.unit_id;
    if not found then
      raise exception 'The room hold no longer exists.';
    end if;
  end if;

  update public.haven_room_manager_requests
     set status = 'approved', decided_at = pg_catalog.now()
   where id = v_request.id;
  return true;
end;
$$;

create or replace function public.reject_haven_room_manager_request(p_request_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to Haven to reject room-management requests.';
  end if;
  update public.haven_room_manager_requests
     set status = 'rejected', decided_at = pg_catalog.now()
   where id = p_request_id
     and user_id = auth.uid()
     and status = 'pending';
  if not found then
    raise exception 'This pending room-management request could not be found.';
  end if;
  return true;
end;
$$;

drop function if exists public.update_haven_room(uuid, text, text, text, text, numeric, text);
drop function if exists public.create_haven_room_hold(uuid, text, text, date, date);
drop function if exists public.cancel_haven_room_hold(uuid, uuid);
revoke all on function public.get_haven_room_manager(uuid) from public;
revoke all on function public.rotate_haven_room_manager_access() from public;
revoke all on function public.revoke_haven_room_manager_access() from public;
revoke all on function public.request_haven_room_change(uuid, text, text, text, jsonb) from public;
revoke all on function public.approve_haven_room_manager_request(uuid) from public;
revoke all on function public.reject_haven_room_manager_request(uuid) from public;
grant execute on function public.get_haven_room_manager(uuid) to anon, authenticated;
grant execute on function public.rotate_haven_room_manager_access() to authenticated;
grant execute on function public.revoke_haven_room_manager_access() to authenticated;
grant execute on function public.request_haven_room_change(uuid, text, text, text, jsonb) to anon, authenticated;
grant execute on function public.approve_haven_room_manager_request(uuid) to authenticated;
grant execute on function public.reject_haven_room_manager_request(uuid) to authenticated;
