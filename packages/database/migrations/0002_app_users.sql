create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  firebase_uid text not null unique,
  email text,
  phone_number text,
  roles text[] not null default '{CUSTOMER}',
  permissions text[] not null default '{wallet:read:own,wallet:create:own,transfer:create}',
  status text not null check (status in ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists app_users_status_idx
  on app_users (status);

insert into app_users (id, firebase_uid, status)
select distinct owner_user_id, 'legacy:' || owner_user_id::text, 'ACTIVE'
from wallet_accounts
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'wallet_accounts_owner_user_id_fkey'
  ) then
    alter table wallet_accounts
      add constraint wallet_accounts_owner_user_id_fkey
      foreign key (owner_user_id)
      references app_users(id);
  end if;
end $$;
