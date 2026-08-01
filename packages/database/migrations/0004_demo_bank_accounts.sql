alter table app_users
  alter column permissions set default '{wallet:read:own,wallet:create:own,transfer:create,bank:read:demo,bank:link:demo,wallet:deposit:bank}';

update app_users
set permissions = array(
    select distinct permission
    from unnest(
      permissions ||
      case when 'CUSTOMER' = any(roles)
        then '{bank:read:demo,bank:link:demo,wallet:deposit:bank}'::text[]
        else '{}'::text[]
      end
    ) as permission
  ),
  updated_at = now()
where 'CUSTOMER' = any(roles);

create table if not exists demo_bank_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references app_users(id) on delete cascade,
  bank_code text not null,
  bank_name text not null,
  account_name text not null,
  account_number_last4 text not null check (account_number_last4 ~ '^[0-9]{4}$'),
  currency text not null,
  balance_minor bigint not null check (balance_minor >= 0),
  status text not null check (status in ('ACTIVE', 'DISABLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists demo_bank_accounts_owner_idx
  on demo_bank_accounts (owner_user_id, created_at);
