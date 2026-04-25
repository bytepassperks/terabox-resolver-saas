export const ADMIN_ROLES = ['support', 'admin', 'super_admin'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/**
 * Role → permission set. Kept in shared-types so bot, admin-api and
 * resolver-api all gate actions consistently.
 */
export const ADMIN_PERMISSIONS: Record<AdminRole, readonly AdminPermission[]> = {
  support: ['users.read', 'stats.read', 'cache.read'],
  admin: [
    'users.read',
    'users.block',
    'users.unblock',
    'credits.adjust',
    'stats.read',
    'cache.read',
    'cache.clear',
    'tokens.read',
    'accounts.read',
    'accounts.write',
  ],
  super_admin: [
    'users.read',
    'users.block',
    'users.unblock',
    'credits.adjust',
    'credits.refund',
    'stats.read',
    'cache.read',
    'cache.clear',
    'tokens.read',
    'tokens.quarantine',
    'providers.toggle',
    'admins.manage',
    'accounts.read',
    'accounts.write',
  ],
};

export type AdminPermission =
  | 'users.read'
  | 'users.block'
  | 'users.unblock'
  | 'credits.adjust'
  | 'credits.refund'
  | 'stats.read'
  | 'cache.read'
  | 'cache.clear'
  | 'tokens.read'
  | 'tokens.quarantine'
  | 'providers.toggle'
  | 'admins.manage'
  | 'accounts.read'
  | 'accounts.write';

export interface AdminJwtPayload {
  sub: string;
  role: AdminRole;
  iss: string;
  iat: number;
  exp: number;
}
