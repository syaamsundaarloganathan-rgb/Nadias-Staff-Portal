-- Nadia Group Staff Portal: database setup for Supabase.
-- Run this once in Supabase: Dashboard > SQL Editor > New query > paste everything > Run.
-- Safe to run again: it replaces the functions and rules with these versions.

-- 1. Tables ---------------------------------------------------------------

-- Who is who. One row per passcode (sign-in account). Written only by the setup
-- script and the reset-passcode function (service role), never by the app.
create table if not exists public.members (
  auth_uid uuid primary key references auth.users(id) on delete cascade,
  sid      text unique not null,                      -- slot, e.g. DIR, HR, S01
  role     text not null check (role in ('director','hr','staff'))
);

-- Everything the portal stores: staff profiles, leave, Wholesale tasks, daily
-- sales and settings. col = which list, id = the record's id, data = the record.
create table if not exists public.docs (
  col        text not null check (col in ('staff','leaves','tasks','sales','settings')),
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (col, id)
);
create index if not exists docs_sid_idx on public.docs ((data->>'sid'));

-- 2. Helpers: who is signed in --------------------------------------------
create or replace function public.my_sid() returns text
language sql stable security definer set search_path = public as
$$ select sid from public.members where auth_uid = auth.uid() $$;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as
$$ select role from public.members where auth_uid = auth.uid() $$;

create or replace function public.is_boss() returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce(public.my_role() in ('hr','director'), false) $$;

-- 3. Row-level security: who can see and change what -----------------------
alter table public.members enable row level security;
alter table public.docs    enable row level security;

drop policy if exists members_read on public.members;
create policy members_read on public.members for select to authenticated
  using (auth_uid = auth.uid() or public.is_boss());

drop policy if exists docs_read   on public.docs;
drop policy if exists docs_insert on public.docs;
drop policy if exists docs_update on public.docs;
drop policy if exists docs_delete on public.docs;

-- Read: HR and the Director see everything. Staff see the settings (holidays,
-- policy), their own profile, and only their own leave, tasks and sales.
create policy docs_read on public.docs for select to authenticated using (
  public.is_boss()
  or col = 'settings'
  or (col = 'staff' and id = public.my_sid())
  or (col in ('leaves','tasks','sales') and data->>'sid' = public.my_sid())
);

-- Add: staff may only add their own leave, tasks and sales. HR and the
-- Director may also add settings. Nobody adds staff slots from the app.
create policy docs_insert on public.docs for insert to authenticated with check (
  (col in ('leaves','tasks','sales') and data->>'sid' = public.my_sid())
  or (public.is_boss() and col = 'settings')
);

-- Change: HR and the Director may change records (the guard trigger below
-- limits how). Staff may change only their own profile and own task updates.
create policy docs_update on public.docs for update to authenticated
  using (
    public.is_boss()
    or (col = 'staff' and id = public.my_sid())
    or (col = 'tasks' and data->>'sid' = public.my_sid())
  )
  with check (
    public.is_boss()
    or (col = 'staff' and id = public.my_sid())
    or (col = 'tasks' and data->>'sid' = public.my_sid())
  );

-- Delete: staff may cancel only their own leave while it is still pending.
-- HR and the Director may delete records, but never a staff slot.
create policy docs_delete on public.docs for delete to authenticated using (
  (col = 'leaves' and data->>'sid' = public.my_sid() and data->>'status' = 'pending')
  or (public.is_boss() and col <> 'staff')
);

-- 4. Guard trigger: rules the policies above can't express -----------------
create or replace function public.docs_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r   text := public.my_role();
  me  text := public.my_sid();
  allowed text[];
begin
  new.updated_at := now();
  -- The setup script and SQL editor run without a signed-in user: no limits.
  if auth.uid() is null then return new; end if;

  if tg_op = 'INSERT' then
    -- New leave and sales always start as pending; tasks start as new.
    -- Nobody can create a record that is already approved.
    if new.col in ('leaves','sales') then
      new.data := (new.data - 'by' - 'byName' - 'note' - 'at') || jsonb_build_object('status','pending');
    elsif new.col = 'tasks' then
      new.data := (new.data - 'by' - 'at') || jsonb_build_object('status','new');
    end if;
    return new;
  end if;

  -- UPDATE
  if new.col <> old.col or new.id <> old.id then raise exception 'Records cannot be moved'; end if;
  if new.col in ('leaves','tasks','sales') and (new.data->>'sid') is distinct from (old.data->>'sid') then
    raise exception 'The owner of a record cannot be changed';
  end if;

  if r = 'staff' then
    if new.col = 'staff' then
      -- Staff may only record that they accepted the policy and saw the welcome
      -- guide, and fill in their name and workplace the first time.
      allowed := array['ack','ackAt','welcomed'];
      if coalesce(old.data->>'name','') = '' then allowed := allowed || array['name']; end if;
      if coalesce(old.data->>'entity','') = '' then allowed := allowed || array['entity']; end if;
      if (new.data ? 'entity') and coalesce(old.data->>'entity','') = '' and new.data->>'entity' is not null
         and new.data->>'entity' not in ('Pharmacy','Pharmacy Wholesale','Dental','Clinic','Head Office') then
        raise exception 'Unknown workplace';
      end if;
      new.data := old.data || coalesce(
        (select jsonb_object_agg(e.key, e.value) from jsonb_each(new.data) e where e.key = any(allowed)),
        '{}'::jsonb);
      return new;
    elsif new.col = 'tasks' then
      -- Staff may update their own task (e.g. mark a quotation sent) but not review it.
      new.data := new.data || jsonb_build_object('status', old.data->'status');
      if old.data ? 'by' then new.data := new.data || jsonb_build_object('by', old.data->'by'); else new.data := new.data - 'by'; end if;
      return new;
    end if;
    raise exception 'Not allowed';
  end if;

  -- HR and the Director
  if new.col = 'leaves' and (new.data->>'status') is distinct from (old.data->>'status')
     and old.data->>'sid' = me then
    raise exception 'You cannot decide your own leave';
  end if;
  if new.col = 'sales' and (new.data->>'status') is distinct from (old.data->>'status') and r <> 'director' then
    raise exception 'Only the Director approves daily sales';
  end if;
  if new.col = 'staff' and (new.data->>'role') is distinct from (old.data->>'role') and r <> 'director' then
    raise exception 'Only the Director changes roles';
  end if;
  if new.col = 'staff' and (new.data->>'role') is distinct from (old.data->>'role') then
    -- keep the sign-in role in step with the profile role
    update public.members set role = new.data->>'role' where sid = new.id;
  end if;
  return new;
end $$;

drop trigger if exists docs_guard on public.docs;
create trigger docs_guard before insert or update on public.docs
  for each row execute function public.docs_guard();

-- Merge a few fields into a record (what the app calls "update").
-- Runs as the signed-in user, so the rules above still apply.
create or replace function public.merge_doc(p_col text, p_id text, p_patch jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  update public.docs set data = data || p_patch where col = p_col and id = p_id;
  if not found then raise exception 'Record not found or not allowed'; end if;
end $$;
grant execute on function public.merge_doc(text, text, jsonb) to authenticated;

-- Ends all sign-ins of one account (used when HR gives someone a new passcode).
-- Only the server-side reset function may call it.
create or replace function public.revoke_sessions(p_uid uuid) returns void
language sql security definer set search_path = public, auth as
$$ delete from auth.sessions where user_id = p_uid $$;
revoke execute on function public.revoke_sessions(uuid) from public, anon, authenticated;
do $$ begin grant execute on function public.revoke_sessions(uuid) to service_role; exception when undefined_object then null; end $$;

-- 5. Live updates ------------------------------------------------------------
alter table public.docs replica identity default;
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- 6. MC slips and other attachments -------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('slips', 'slips', false, 10485760, array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists slips_upload on storage.objects;
drop policy if exists slips_read   on storage.objects;
-- Each person uploads into their own folder (slips/<slot>/...).
create policy slips_upload on storage.objects for insert to authenticated with check (
  bucket_id = 'slips' and (storage.foldername(name))[1] = public.my_sid()
);
-- They can open their own files; HR and the Director can open everyone's.
create policy slips_read on storage.objects for select to authenticated using (
  bucket_id = 'slips' and ((storage.foldername(name))[1] = public.my_sid() or public.is_boss())
);

-- 7. Starting data: Kuala Lumpur public holidays (HR edits them in the app) ---
insert into public.docs (col, id, data) values ('settings', 'holidays', jsonb_build_object('list', '[{"date": "2026-11-08", "name": "Deepavali"}, {"date": "2026-11-09", "name": "Deepavali (replacement holiday)"}, {"date": "2026-12-25", "name": "Christmas Day"}, {"date": "2027-01-01", "name": "New Year''s Day"}, {"date": "2027-01-22", "name": "Thaipusam"}, {"date": "2027-02-01", "name": "Federal Territory Day"}, {"date": "2027-02-06", "name": "Chinese New Year"}, {"date": "2027-02-07", "name": "Chinese New Year (Day 2)"}, {"date": "2027-02-08", "name": "Chinese New Year replacement (please confirm)"}, {"date": "2027-02-24", "name": "Nuzul Al-Quran"}, {"date": "2027-03-10", "name": "Hari Raya Aidilfitri"}, {"date": "2027-03-11", "name": "Hari Raya Aidilfitri (Day 2)"}, {"date": "2027-05-01", "name": "Labour Day"}, {"date": "2027-05-17", "name": "Hari Raya Haji"}, {"date": "2027-05-20", "name": "Wesak Day"}, {"date": "2027-06-06", "name": "Awal Muharram"}, {"date": "2027-06-07", "name": "Agong''s Birthday"}, {"date": "2027-06-08", "name": "Awal Muharram replacement (please confirm)"}, {"date": "2027-08-15", "name": "Maulidur Rasul"}, {"date": "2027-08-16", "name": "Maulidur Rasul replacement (please confirm)"}, {"date": "2027-08-31", "name": "National Day"}, {"date": "2027-09-16", "name": "Malaysia Day"}, {"date": "2027-10-28", "name": "Deepavali"}, {"date": "2027-12-25", "name": "Christmas Day"}]'::jsonb))
on conflict (col, id) do nothing;
