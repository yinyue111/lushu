// Role → permission table (PRD 7.2). Single source of truth for the server; the admin UI only hides
// what the server would refuse anyway.
export const PERMISSIONS = {
  'dashboard.read': ['operator', 'admin'],
  'system.read': ['operator', 'admin'],
  'corrections.read': ['operator', 'admin'],
  'corrections.write': ['operator', 'admin'],
  'corrections.batch': ['admin'],
  'users.read': ['operator', 'admin'],
  'users.write': ['operator', 'admin'],
  'users.quota': ['operator', 'admin'], // operator capped at admin.operatorQuotaMax
  'roadbooks.read': ['operator', 'admin'],
  'roadbooks.write': ['operator', 'admin'],
  'config.read': ['operator', 'admin'], // secrets are never returned to anyone
  'config.write': ['admin'],
  'config.restore': ['admin'],
  'config.export': ['admin'],
  'config.testRun': ['admin'],
  'invites.manage': ['admin'],
  'audit.read.all': ['admin'],
  'audit.read.own': ['operator', 'admin'],
  'admins.manage': ['admin']
};

/** @param {string} role @param {keyof typeof PERMISSIONS} permission */
export function can(role, permission) {
  return Boolean(PERMISSIONS[permission]?.includes(role));
}
