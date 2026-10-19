import { fileURLToPath } from 'node:url';
import { openStore } from './store.ts';
import { createApp } from './app.ts';
const store = openStore(fileURLToPath(new URL('../data/', import.meta.url)));
const server = createApp(store, fileURLToPath(new URL('../dist/', import.meta.url)));
server.listen(4180, '127.0.0.1', () => console.log('Relay is running at http://127.0.0.1:4180\nLocal workspace · SQLite data in traffic-platform/data'));
server.on('error', e => { console.error(e.message); process.exitCode = 1; });
let closing = false;
function close() { if (closing) return; closing = true; server.close(() => { store.db.close(); process.exit(); }); }
process.on('SIGINT', close); process.on('SIGTERM', close);
