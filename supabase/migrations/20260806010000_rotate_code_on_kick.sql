-- When the map creator kicks a member, rotate the 6-digit invite code so the
-- kicked user cannot rejoin with the old code. Map state, other members, and
-- everything else on the shared map is left unchanged.

-- Must drop first: return type changes from boolean → text
drop function if exists public.remove_shared_map_member(uuid, uuid);

create or replace function public.remove_shared_map_member(p_map_id uuid, p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_host uuid;
  v_code text;
  v_try int := 0;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_user_id is null then raise exception 'Member required'; end if;
  select host_user_id into v_host from public.shared_maps where id = p_map_id;
  if v_host is null then raise exception 'Map not found'; end if;
  if v_host is distinct from v_uid then
    raise exception 'Only the map creator can remove members';
  end if;
  if p_user_id = v_uid then
    raise exception 'Cannot remove yourself — delete the map instead';
  end if;

  delete from public.shared_map_members
  where map_id = p_map_id and user_id = p_user_id;
  delete from public.party_presence
  where map_id = p_map_id and user_id = p_user_id;
  delete from public.party_member_prefs
  where map_id = p_map_id and (member_user_id = p_user_id or owner_user_id = p_user_id);

  -- Issue a new unique 6-digit code (same allocation style as create_shared_map)
  loop
    v_code := lpad((floor(random() * 900000) + 100000)::int::text, 6, '0');
    begin
      update public.shared_maps
      set code = v_code,
          updated_at = now()
      where id = p_map_id;
      exit;
    exception when unique_violation then
      v_try := v_try + 1;
      if v_try > 20 then
        raise exception 'Could not allocate a new invite code';
      end if;
    end;
  end loop;

  return v_code;
end;
$$;

grant execute on function public.remove_shared_map_member(uuid, uuid) to authenticated;

comment on function public.remove_shared_map_member(uuid, uuid) is
  'Host removes a member and rotates the map invite code. Returns the new 6-digit code.';
