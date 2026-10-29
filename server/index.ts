import { fileURLToPath } from 'node:url';
import { openStore } from './store.ts';
import { createApp } from './app.ts';
import { TrafficRuntime } from './traffic/runtime.ts';
import { ingressConfiguration } from './traffic/configuration.ts';
const ingress = ingressConfiguration(process.env);
const store = (await openStore(fileURLToPath(new URL('../data/', import.meta.url))));
const traffic = new TrafficRuntime(store, { edge: ingress.edge });
await traffic.ready;
const server = createApp(store, fileURLToPath(new URL('../dist/', import.meta.url)), traffic);
const publicServer = ingress.edge ? traffic.createPublicServer() : null;
server.listen(4180, '127.0.0.1', () => console.log('Relay is running at http://127.0.0.1:4180\nLocal workspace · Supabase PostgreSQL storage'));
publicServer?.listen(ingress.port, '127.0.0.1', () => console.log(`Authenticated tracking listener: 127.0.0.1:${ingress.port} · ${ingress.edge!.audience}`));
const servers = [server, ...(publicServer ? [publicServer] : [])];
for (const listener of servers) listener.on('error', e => { console.error(e.message); process.exitCode = 1; void close(); });
let closing = false;
async function close() {
  if (closing) return; closing = true;
  const deadline = setTimeout(() => { for (const listener of servers) listener.closeAllConnections(); }, 5000); deadline.unref();
  try {
    await Promise.all([...servers.map(listener => new Promise<void>(resolve => listener.close(() => resolve()))), traffic.close()]);
    (await store.db.close());
  } catch (error) { console.error('Shutdown could not finish:', error instanceof Error ? error.message : 'unknown failure'); process.exitCode = 1; }
  finally { clearTimeout(deadline); }
}
process.on('SIGINT', close); process.on('SIGTERM', close);
