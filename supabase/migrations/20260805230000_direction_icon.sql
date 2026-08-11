-- Custom directional icons for party members / own location
alter table public.party_member_prefs
  add column if not exists direction_icon_id text;

alter table public.profiles
  add column if not exists direction_icon_id text;

-- Return type gains direction_icon_id — must drop before recreate
drop function if exists public.list_shared_map_members(uuid);

-- Include profile direction icon in member list (shown unless viewer overrides in prefs)
create or replace function public.list_shared_map_members(p_map_id uuid)
returns table (
  user_id uuid,
  username text,
  display_name text,
  arrow_color text,
  direction_icon_id text,
  is_host boolean,
  joined_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select m.user_id,
         p.username,
         coalesce(p.display_name, p.username) as display_name,
         coalesce(p.arrow_color, '#e11d1d') as arrow_color,
         p.direction_icon_id,
         (s.host_user_id = m.user_id) as is_host,
         m.joined_at
  from public.shared_map_members m
  join public.profiles p on p.id = m.user_id
  join public.shared_maps s on s.id = m.map_id
  where m.map_id = p_map_id
    and public.is_shared_map_member(p_map_id)
  order by m.joined_at asc;
$$;

grant execute on function public.list_shared_map_members(uuid) to authenticated;
