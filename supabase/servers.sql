-- =====================================================================
-- CHECKED ORYN — Servers, channels, roles and attachments
-- Run this ONCE in the Supabase dashboard: SQL Editor -> New query -> Run.
-- It is safe to re-run (everything is idempotent).
-- =====================================================================

-- ---------------------------------------------------------------------
-- TABLES
-- ---------------------------------------------------------------------

create table if not exists public.servers (
    id          uuid primary key default gen_random_uuid(),
    name        text not null check (char_length(name) between 2 and 50),
    owner_id    uuid not null references auth.users(id) on delete cascade,
    invite_code text not null unique
                default substr(replace(gen_random_uuid()::text, '-', ''), 1, 8),
    created_at  timestamptz not null default now()
);

create table if not exists public.server_members (
    server_id uuid not null references public.servers(id) on delete cascade,
    user_id   uuid not null references auth.users(id) on delete cascade,
    role      text not null default 'member'
              check (role in ('owner', 'admin', 'moderator', 'member')),
    joined_at timestamptz not null default now(),
    primary key (server_id, user_id)
);

create index if not exists server_members_user_idx
    on public.server_members (user_id);

create table if not exists public.channels (
    id         uuid primary key default gen_random_uuid(),
    server_id  uuid not null references public.servers(id) on delete cascade,
    name       text not null check (name ~ '^[a-z0-9-]{1,32}$'),
    position   int  not null default 0,
    created_at timestamptz not null default now(),
    unique (server_id, name)
);

create table if not exists public.server_messages (
    id              uuid primary key default gen_random_uuid(),
    server_id       uuid not null references public.servers(id) on delete cascade,
    channel_id      uuid not null references public.channels(id) on delete cascade,
    user_id         uuid not null default auth.uid()
                    references auth.users(id) on delete cascade,
    content         text not null default '' check (char_length(content) <= 2000),
    attachment_url  text,
    attachment_type text check (attachment_type in
                    ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
    attachment_name text check (char_length(attachment_name) <= 200),
    created_at      timestamptz not null default now(),
    check (char_length(btrim(content)) > 0 or attachment_url is not null)
);

create index if not exists server_messages_channel_idx
    on public.server_messages (channel_id, created_at desc);

-- ---------------------------------------------------------------------
-- HELPERS
-- rank: member 0, moderator 1, admin 2, owner 3, not a member -> NULL
-- SECURITY DEFINER so policies can ask "what is my role?" without
-- recursing into the RLS policy of server_members.
-- ---------------------------------------------------------------------

create or replace function public.server_rank(sid uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
    select case role
        when 'owner'     then 3
        when 'admin'     then 2
        when 'moderator' then 1
        else 0
    end
    from public.server_members
    where server_id = sid and user_id = auth.uid()
$$;

create or replace function public.role_rank(r text)
returns int
language sql
immutable
as $$
    select case r
        when 'owner'     then 3
        when 'admin'     then 2
        when 'moderator' then 1
        else 0
    end
$$;

-- ---------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ---------------------------------------------------------------------

alter table public.servers         enable row level security;
alter table public.server_members  enable row level security;
alter table public.channels        enable row level security;
alter table public.server_messages enable row level security;

-- servers: members can see; admins+ can rename; only the owner can delete.
-- (creating / joining goes through the functions below)
drop policy if exists "servers: members read"  on public.servers;
drop policy if exists "servers: admins rename" on public.servers;
drop policy if exists "servers: owner delete"  on public.servers;

create policy "servers: members read" on public.servers
    for select to authenticated
    using (public.server_rank(id) is not null);

create policy "servers: admins rename" on public.servers
    for update to authenticated
    using (public.server_rank(id) >= 2)
    with check (public.server_rank(id) >= 2);

create policy "servers: owner delete" on public.servers
    for delete to authenticated
    using (public.server_rank(id) = 3);

-- Admins may only change the name directly, never owner_id / invite_code.
revoke update on public.servers from authenticated;
grant  update (name) on public.servers to authenticated;

-- server_members: members can see who else is in the server.
-- All writes go through the role functions below.
drop policy if exists "members: members read" on public.server_members;

create policy "members: members read" on public.server_members
    for select to authenticated
    using (public.server_rank(server_id) is not null);

-- channels: members read; admins+ manage.
drop policy if exists "channels: members read"  on public.channels;
drop policy if exists "channels: admins insert" on public.channels;
drop policy if exists "channels: admins update" on public.channels;
drop policy if exists "channels: admins delete" on public.channels;

create policy "channels: members read" on public.channels
    for select to authenticated
    using (public.server_rank(server_id) is not null);

create policy "channels: admins insert" on public.channels
    for insert to authenticated
    with check (public.server_rank(server_id) >= 2);

create policy "channels: admins update" on public.channels
    for update to authenticated
    using (public.server_rank(server_id) >= 2)
    with check (public.server_rank(server_id) >= 2);

create policy "channels: admins delete" on public.channels
    for delete to authenticated
    using (public.server_rank(server_id) >= 2);

-- messages: members read + post (as themselves, in a channel of that server);
-- authors delete their own; moderators+ delete anyone's.
drop policy if exists "messages: members read"   on public.server_messages;
drop policy if exists "messages: members post"   on public.server_messages;
drop policy if exists "messages: author or mod delete" on public.server_messages;

create policy "messages: members read" on public.server_messages
    for select to authenticated
    using (public.server_rank(server_id) is not null);

create policy "messages: members post" on public.server_messages
    for insert to authenticated
    with check (
        user_id = auth.uid()
        and public.server_rank(server_id) is not null
        and exists (
            select 1 from public.channels c
            where c.id = channel_id and c.server_id = server_messages.server_id
        )
    );

create policy "messages: author or mod delete" on public.server_messages
    for delete to authenticated
    using (user_id = auth.uid() or public.server_rank(server_id) >= 1);

-- ---------------------------------------------------------------------
-- FUNCTIONS (the only way to create / join / change roles / kick)
-- ---------------------------------------------------------------------

create or replace function public.create_server(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    uid uuid := auth.uid();
    sid uuid;
begin
    if uid is null then raise exception 'Not signed in'; end if;

    p_name := btrim(p_name);
    if char_length(p_name) not between 2 and 50 then
        raise exception 'Server name must be 2-50 characters';
    end if;

    if (select count(*) from servers where owner_id = uid) >= 10 then
        raise exception 'You can own up to 10 servers';
    end if;

    insert into servers (name, owner_id) values (p_name, uid) returning id into sid;
    insert into server_members (server_id, user_id, role) values (sid, uid, 'owner');
    insert into channels (server_id, name, position) values (sid, 'general', 0);

    return sid;
end;
$$;

create or replace function public.join_server(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    uid uuid := auth.uid();
    sid uuid;
begin
    if uid is null then raise exception 'Not signed in'; end if;

    select id into sid from servers where invite_code = lower(btrim(p_code));
    if sid is null then raise exception 'Invalid invite code'; end if;

    insert into server_members (server_id, user_id, role)
    values (sid, uid, 'member')
    on conflict do nothing;

    return sid;
end;
$$;

create or replace function public.leave_server(p_server uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if public.server_rank(p_server) is null then
        raise exception 'You are not in this server';
    end if;
    if public.server_rank(p_server) = 3 then
        raise exception 'Owners cannot leave. Delete the server instead.';
    end if;

    delete from server_members
    where server_id = p_server and user_id = auth.uid();
end;
$$;

-- Admins can set moderator/member; the owner can also set admin.
-- You can only change people ranked BELOW you, to a role BELOW you.
create or replace function public.set_member_role(p_server uuid, p_user uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    my_rank     int := public.server_rank(p_server);
    target_role text;
begin
    if my_rank is null or my_rank < 2 then
        raise exception 'Only admins can change roles';
    end if;
    if p_role not in ('admin', 'moderator', 'member') then
        raise exception 'Invalid role';
    end if;
    if p_user = auth.uid() then
        raise exception 'You cannot change your own role';
    end if;

    select role into target_role
    from server_members where server_id = p_server and user_id = p_user;

    if target_role is null then raise exception 'Member not found'; end if;
    if public.role_rank(target_role) >= my_rank then
        raise exception 'You cannot change someone of equal or higher rank';
    end if;
    if public.role_rank(p_role) >= my_rank then
        raise exception 'You cannot grant a role equal to or above your own';
    end if;

    update server_members set role = p_role
    where server_id = p_server and user_id = p_user;
end;
$$;

-- Moderators can kick members; admins can kick moderators; owner kicks anyone.
create or replace function public.kick_member(p_server uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    my_rank     int := public.server_rank(p_server);
    target_role text;
begin
    if my_rank is null or my_rank < 1 then
        raise exception 'Only moderators and above can remove members';
    end if;
    if p_user = auth.uid() then
        raise exception 'You cannot kick yourself';
    end if;

    select role into target_role
    from server_members where server_id = p_server and user_id = p_user;

    if target_role is null then raise exception 'Member not found'; end if;
    if public.role_rank(target_role) >= my_rank then
        raise exception 'You cannot remove someone of equal or higher rank';
    end if;

    delete from server_members where server_id = p_server and user_id = p_user;
end;
$$;

create or replace function public.reset_invite_code(p_server uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    new_code text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
begin
    if coalesce(public.server_rank(p_server), -1) < 2 then
        raise exception 'Only admins can reset the invite code';
    end if;

    update servers set invite_code = new_code where id = p_server;
    return new_code;
end;
$$;

-- Invite codes are readable by members through the servers table.
revoke all on function public.create_server(text)                 from public, anon;
revoke all on function public.join_server(text)                   from public, anon;
revoke all on function public.leave_server(uuid)                  from public, anon;
revoke all on function public.set_member_role(uuid, uuid, text)   from public, anon;
revoke all on function public.kick_member(uuid, uuid)             from public, anon;
revoke all on function public.reset_invite_code(uuid)             from public, anon;

grant execute on function public.create_server(text)               to authenticated;
grant execute on function public.join_server(text)                 to authenticated;
grant execute on function public.leave_server(uuid)                to authenticated;
grant execute on function public.set_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.kick_member(uuid, uuid)           to authenticated;
grant execute on function public.reset_invite_code(uuid)           to authenticated;

-- ---------------------------------------------------------------------
-- STORAGE: image + GIF attachments (max 8 MB each)
-- Files live at  <user id>/<random>.<ext>  and users may only upload into
-- their own folder. The bucket is public so images load in <img> tags;
-- file names are random and unguessable.
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'server-attachments',
    'server-attachments',
    true,
    8388608,
    array['image/png', 'image/jpeg', 'image/gif', 'image/webp']
)
on conflict (id) do update set
    public             = excluded.public,
    file_size_limit    = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "attachments: upload to own folder" on storage.objects;
drop policy if exists "attachments: delete own files"     on storage.objects;

create policy "attachments: upload to own folder" on storage.objects
    for insert to authenticated
    with check (
        bucket_id = 'server-attachments'
        and (storage.foldername(name))[1] = auth.uid()::text
    );

create policy "attachments: delete own files" on storage.objects
    for delete to authenticated
    using (
        bucket_id = 'server-attachments'
        and (storage.foldername(name))[1] = auth.uid()::text
    );

-- ---------------------------------------------------------------------
-- REALTIME (live messages, channel and member changes)
-- If you get "already member of publication", that table is already on.
-- ---------------------------------------------------------------------

do $$
declare t text;
begin
    foreach t in array array['server_messages', 'channels', 'server_members']
    loop
        begin
            execute format('alter publication supabase_realtime add table public.%I', t);
        exception when duplicate_object then
            null;
        end;
    end loop;
end;
$$;

-- DELETE events need the full row so the client can filter by server.
alter table public.server_messages replica identity full;
alter table public.channels        replica identity full;
alter table public.server_members  replica identity full;
