create extension if not exists pgcrypto;

create table if not exists wallet_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  account_type text not null check (account_type in ('CUSTOMER', 'MERCHANT', 'SYSTEM')),
  currency text not null,
  status text not null check (status in ('ACTIVE', 'FROZEN', 'CLOSED')),
  created_at timestamptz not null default now(),
  unique (owner_user_id, account_type, currency)
);

create table if not exists wallet_transaction_ledger (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null,
  account_id uuid not null references wallet_accounts(id),
  owner_user_id uuid not null,
  entry_type text not null check (entry_type in ('DEBIT', 'CREDIT')),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null,
  reference_type text not null,
  reference_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists wallet_ledger_account_idx
  on wallet_transaction_ledger (account_id, created_at);

create index if not exists wallet_ledger_transaction_idx
  on wallet_transaction_ledger (transaction_id);

create table if not exists api_idempotency_registry (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  response_status int,
  response_payload jsonb,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists wallet_funding_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  account_id uuid not null references wallet_accounts(id),
  provider text not null check (provider in ('MTN_MOMO', 'MGURUSH')),
  provider_reference text,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null,
  status text not null check (status in ('PENDING', 'COMPLETED', 'FAILED', 'EXPIRED')),
  request_payload_hash text,
  callback_payload_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists wallet_funding_provider_ref_idx
  on wallet_funding_requests (provider, provider_reference)
  where provider_reference is not null;

create table if not exists merchant_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  display_name text not null,
  latitude numeric(10, 7) not null,
  longitude numeric(10, 7) not null,
  geofence_radius_meters int not null default 100,
  verification_secret_ref text not null,
  status text not null check (status in ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  created_at timestamptz not null default now()
);

create table if not exists compliance_flags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  merchant_id uuid,
  event_type text not null,
  severity text not null check (severity in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
