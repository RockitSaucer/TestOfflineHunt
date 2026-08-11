-- Multi-day map calendar events (Hunt / Reg shared Supabase project)
-- Safe: new tables only.

create table if not exists public.map_calendar_events (
  id uuid primary key default gen_random_uuid(),
  creator_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  color text default '#e59a18',
  start_date date not null,
  end_date date not null,
  map_scope text not null default 'personal', -- personal | all | shared
  shared_map_id uuid null references public.shared_maps(id) on delete set null,
  lat double precision null,
  lng double precision null,
  location_label text null,
  hunt_link jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint map_calendar_events_dates_ok check (end_date >= start_date)
);

create index if not exists map_calendar_events_creator_idx on public.map_calendar_events (creator_user_id);
create index if not exists map_calendar_events_start_idx on public.map_calendar_events (start_date);
create index if not exists map_calendar_events_shared_idx on public.map_calendar_events (shared_map_id);

create table if not exists public.map_calendar_event_hides (
  event_id uuid not null references public.map_calendar_events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

create index if not exists map_calendar_event_hides_user_idx on public.map_calendar_event_hides (user_id);

create table if not exists public.map_calendar_event_maps (
  event_id uuid not null references public.map_calendar_events(id) on delete cascade,
  shared_map_id uuid not null references public.shared_maps(id) on delete cascade,
  primary key (event_id, shared_map_id)
);

-- Helper: is member of shared map
create or replace function public.is_shared_map_member(p_map_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.shared_map_members m
    where m.map_id = p_map_id and m.user_id = auth.uid()
  )
  or exists (
    select 1 from public.shared_maps sm
    where sm.id = p_map_id and sm.owner_user_id = auth.uid()
  );
$$;

alter table public.map_calendar_events enable row level security;
alter table public.map_calendar_event_hides enable row level security;
alter table public.map_calendar_event_maps enable row level security;

drop policy if exists mce_select on public.map_calendar_events;
create policy mce_select on public.map_calendar_events
  for select to authenticated
  using (
    creator_user_id = auth.uid()
    or (
      map_scope = 'shared'
      and shared_map_id is not null
      and public.is_shared_map_member(shared_map_id)
    )
    or map_scope = 'all'
  );

drop policy if exists mce_insert on public.map_calendar_events;
create policy mce_insert on public.map_calendar_events
  for insert to authenticated
  with check (creator_user_id = auth.uid());

drop policy if exists mce_update on public.map_calendar_events;
create policy mce_update on public.map_calendar_events
  for update to authenticated
  using (creator_user_id = auth.uid())
  with check (creator_user_id = auth.uid());

drop policy if exists mce_delete on public.map_calendar_events;
create policy mce_delete on public.map_calendar_events
  for delete to authenticated
  using (creator_user_id = auth.uid());

drop policy if exists mce_hides_all on public.map_calendar_event_hides;
create policy mce_hides_all on public.map_calendar_event_hides
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists mce_maps_select on public.map_calendar_event_maps;
create policy mce_maps_select on public.map_calendar_event_maps
  for select to authenticated
  using (
    exists (
      select 1 from public.map_calendar_events e
      where e.id = event_id
        and (
          e.creator_user_id = auth.uid()
          or public.is_shared_map_member(shared_map_id)
        )
    )
  );

drop policy if exists mce_maps_write on public.map_calendar_event_maps;
create policy mce_maps_write on public.map_calendar_event_maps
  for all to authenticated
  using (
    exists (
      select 1 from public.map_calendar_events e
      where e.id = event_id and e.creator_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.map_calendar_events e
      where e.id = event_id and e.creator_user_id = auth.uid()
    )
  );

grant select, insert, update, delete on public.map_calendar_events to authenticated;
grant select, insert, update, delete on public.map_calendar_event_hides to authenticated;
grant select, insert, update, delete on public.map_calendar_event_maps to authenticated;
grant execute on function public.is_shared_map_member(uuid) to authenticated;
