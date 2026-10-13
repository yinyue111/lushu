// Creates the first (or any) admin console account from the server box. Prints a one-time initial
// password; the TOTP secret is shown at first login (binding is mandatory before any page opens).
// Usage: npm run admin:create -- --username alice --role admin
import { initializeRuntimeStorage, closeRuntimeStorage } from '../server/storage/runtime.mjs';
import { createAdminAccount } from '../server/admin/auth.mjs';
import { adminAudit } from '../server/admin/audit.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : '';
};
const username = arg('username');
const role = arg('role') || 'operator';
if (!username) {
  console.error('Usage: npm run admin:create -- --username <name> --role operator|admin');
  process.exit(2);
}
await initializeRuntimeStorage();
try {
  const { admin, initialPassword } = await createAdminAccount({ username, role });
  await adminAudit(null, { actor: 'cli', role: 'cli', action: 'admin.create', target: `admin:${admin.username}`, after: { role: admin.role } });
  console.log(`Created ${admin.role} "${admin.username}". Initial password (shown once): ${initialPassword}`);
  console.log('At first login at /admin the account must bind an authenticator app (TOTP) and save its backup codes.');
} finally {
  await closeRuntimeStorage();
}
