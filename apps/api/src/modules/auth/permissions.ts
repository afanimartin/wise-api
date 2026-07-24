export const DEFAULT_CUSTOMER_ROLE = 'CUSTOMER';

export const DEFAULT_CUSTOMER_PERMISSIONS = [
  'wallet:read:own',
  'wallet:create:own',
  'transfer:create',
] as const;

export const ADMIN_PERMISSIONS = [
  'admin:access',
  'wallet:read:any',
  'wallet:credit',
  'wallet:debit',
  'transfer:approve',
  'user:read:any',
] as const;

export type Permission =
  | (typeof DEFAULT_CUSTOMER_PERMISSIONS)[number]
  | (typeof ADMIN_PERMISSIONS)[number];

export function hasPermission(
  permissions: readonly string[],
  requiredPermission: Permission,
): boolean {
  return permissions.includes(requiredPermission);
}
