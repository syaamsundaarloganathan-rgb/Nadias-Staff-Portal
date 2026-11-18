-- Creates the sign-in passcodes from the Supabase SQL editor (no Node.js or secret key needed).
-- Same result as scripts/create-passcodes.mjs: 1 Director, 1 HR Manager, N staff slots.
-- Run AFTER schema.sql. Re-running only adds missing slots.
create or replace function public._nadia_create_passcodes(staff_count int default 20)
returns table(slot text, role_name text, passcode text)
language plpgsql security definer set search_path = public, auth, extensions as $$
declare
  s record; code text; em text; new_uid uuid;
  def jsonb := '{"annual":14,"mc":14,"hospital":60,"emergency":3,"timeoff":4,"maternity":98,"paternity":7,"compassionate":3,"marriage":3,"replacement":0,"exam":3,"pilgrimage":0}';
begin
  for s in
    select * from (values ('DIR','director','Head Office','Director'), ('HR','hr','Head Office','HR Manager')) v(sid, r, ent, lbl)
    union all
    select 'S' || lpad(g::text, 2, '0'), 'staff', null, 'Staff' from generate_series(1, staff_count) g
  loop
    continue when exists (select 1 from public.members m where m.sid = s.sid);
    loop
      code := (10000000 + floor(random() * 90000000))::bigint::text;
      continue when code ~ '^(\d)\1+$';
      em := 'p' || left(encode(sha256(convert_to('nadia-passcode:' || code, 'UTF8')), 'hex'), 24) || '@staff.nadia-portal.app';
      exit when not exists (select 1 from auth.users u where u.email = em);
    end loop;
    new_uid := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change)
    values ('00000000-0000-0000-0000-000000000000', new_uid, 'authenticated', 'authenticated', em,
      crypt('Nadia#' || code, gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', jsonb_build_object('sid', s.sid), now(), now(), '', '', '', '');
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), new_uid, new_uid::text,
      jsonb_build_object('sub', new_uid::text, 'email', em, 'email_verified', true), 'email', now(), now(), now());
    insert into public.members (auth_uid, sid, role) values (new_uid, s.sid, s.r);
    insert into public.docs (col, id, data)
      values ('staff', s.sid, jsonb_build_object('role', s.r, 'entity', s.ent, 'name', null) || def)
      on conflict (col, id) do update set data = excluded.data;
    slot := s.sid; role_name := s.lbl; passcode := code;
    return next;
  end loop;
end $$;
revoke execute on function public._nadia_create_passcodes(int) from public, anon, authenticated;

select * from public._nadia_create_passcodes(20);
