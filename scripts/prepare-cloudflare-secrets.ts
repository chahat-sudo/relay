import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const key = readFileSync(new URL('../data/.local-key', import.meta.url));
if (key.length !== 32) throw new Error('Restore the original 32-byte data/.local-key.');
const target = fileURLToPath(new URL('../data/cloudflare-secrets.json', import.meta.url));
const existing = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) as Record<string, string> : undefined;
if (existing && existing.RELAY_WORKSPACE_KEY !== key.toString('base64')) throw new Error('The existing Cloudflare secrets use a different workspace key. No files were changed.');
const values = {
    RELAY_WORKSPACE_KEY: key.toString('base64'),
    RELAY_ADMIN_USER: process.env.RELAY_ADMIN_USER || existing?.RELAY_ADMIN_USER || 'owner',
    RELAY_ADMIN_PASSWORD: process.env.RELAY_ADMIN_PASSWORD || existing?.RELAY_ADMIN_PASSWORD || randomBytes(32).toString('base64url'),
};
if (values.RELAY_ADMIN_PASSWORD.length < 24 || values.RELAY_ADMIN_USER.includes(':')) throw new Error('Choose an admin user without a colon and a password of at least 24 characters.');
const content = JSON.stringify(values, null, 2) + '\n';
if (!existsSync(target) || readFileSync(target, 'utf8') !== content) {
  mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
  if (existing) copyFileSync(target, `${target}.backup-${Date.now()}`, constants.COPYFILE_EXCL);
  writeFileSync(target, content, { flag: existing ? 'w' : 'wx', mode: 0o600 });
  console.log('Prepared ignored data/cloudflare-secrets.json with the existing workspace key and admin login.');
} else {
  console.log('Existing data/cloudflare-secrets.json is current; no files changed.');
}
console.log('Upload from this folder: npx wrangler secret bulk data/cloudflare-secrets.json');
console.log('The admin login is inside that local file. Never commit or share it.');
console.log('Database credentials and the verified CA are held by the configured Hyperdrive resource.');
