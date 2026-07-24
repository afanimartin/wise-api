alter table app_users
  add column if not exists permissions text[] not null default '{wallet:read:own,wallet:create:own,transfer:create}';

alter table app_users
  alter column roles set default '{CUSTOMER}';

alter table app_users
  alter column permissions set default '{wallet:read:own,wallet:create:own,transfer:create}';

update app_users
set roles = '{CUSTOMER}',
    permissions = '{wallet:read:own,wallet:create:own,transfer:create}',
    updated_at = now()
where cardinality(roles) = 0;

update app_users
set permissions = array(
    select distinct permission
    from unnest(
      permissions ||
      case when 'CUSTOMER' = any(roles)
        then '{wallet:read:own,wallet:create:own,transfer:create}'::text[]
        else '{}'::text[]
      end ||
      case when 'ADMIN' = any(roles)
        then '{admin:access,wallet:read:any,wallet:credit,wallet:debit,transfer:approve,user:read:any}'::text[]
        else '{}'::text[]
      end
    ) as permission
  ),
  updated_at = now()
where 'CUSTOMER' = any(roles)
   or 'ADMIN' = any(roles);
