import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { openTestStore as openStore } from '../tests/postgres.ts';
import { TrafficRuntime } from '../server/traffic/runtime.ts';
import { createApp } from '../server/app.ts';

const mode = process.argv[2] ?? 'off';
const seededClicks = Number(process.argv[3] ?? 0);
if (!['off', 'observe'].includes(mode) || !Number.isInteger(seededClicks) || seededClicks < 0 || seededClicks > 100000) throw new Error('Use off|observe and a synthetic seed count between 0 and 100000.');
const folder = mkdtempSync(path.join(tmpdir(), 'relay-benchmark-'));
const store = await openStore(folder);
await store.setSetting('traffic_config', JSON.stringify({ mode }));
const traffic = new TrafficRuntime(store, { networkEnabled: false }); await traffic.ready;
const server = createApp(store, folder, traffic);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
async function save(route: string, data: unknown) {
  const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Relay-Request': '1' }, body: JSON.stringify(data) });
  if (!response.ok) throw new Error(`Setup failed: ${response.status}`);
  return await response.json() as { id: string };
}
let peakRss = process.memoryUsage().rss;
const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 5);
try {
  const d = await save('/api/destinations', { name: 'Benchmark', url: 'https://example.com/offer', status: 'active', dailyCap: 0 });
  const campaign = await save('/api/campaigns', { name: 'Benchmark', slug: 'bench', source: '', status: 'active', costPerClick: .25, fallbackId: '', rules: [{ id: 'r', name: 'Primary', source: '', device: '', enabled: true, targets: [{ destinationId: d.id, weight: 100 }] }] });
  const insert = store.db.prepare('INSERT INTO relay.clicks VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)');
  await store.db.transaction(async () => {
  for (let i = 0; i < seededClicks; i++) await insert.run(randomUUID(), campaign.id, d.id, 'Synthetic seed', 'benchmark', 'desktop', 'synthetic-benchmark', '', 25, new Date(Date.now() - 2 * 86400000).toISOString());
  });
  const coldStarted = performance.now();
  const cold = await fetch(base + '/r/bench', { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' } }); await cold.arrayBuffer();
  if (cold.status !== 302) throw new Error('Cold tracking failed.');
  const coldRequestMs = performance.now() - coldStarted;
  const cpu = process.cpuUsage(); const started = performance.now(); const times: number[] = [];
  for (let batch = 0; batch < 20; batch++) {
    await Promise.all(Array.from({ length: 10 }, async () => {
      const t = performance.now(); const response = await fetch(base + '/r/bench', { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' } });
      await response.arrayBuffer(); if (response.status !== 302) throw new Error(`Tracking failed: ${response.status}`); times.push(performance.now() - t);
    }));
  }
  times.sort((a, b) => a - b); const used = process.cpuUsage(cpu);
  console.log(JSON.stringify({ mode, seededClicks, coldRequestMs, warmRequests: times.length, concurrency: 10, elapsedMs: performance.now() - started, p50Ms: times[Math.floor(times.length * .5)], p95Ms: times[Math.floor(times.length * .95)], p99Ms: times[Math.floor(times.length * .99)], cpuMs: (used.user + used.system) / 1000, peakProcessFamilyRssBytes: peakRss, memoryScope: 'single Node process; HTTP client and server share process; no children', cache: 'one cold request followed by 200 warm requests; no crawler claim or remote lookup', databaseGrowthBytes: 'not measured', backend: 'embedded PostgreSQL / PGlite', agentTokens: 'not measured', unmeasured: 'Cloudflare, external network, collector, production accuracy' }));
} finally {
  clearInterval(sample); await traffic.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await store.db.close();
  if (path.dirname(path.resolve(folder)) !== path.resolve(tmpdir()) || !path.basename(folder).startsWith('relay-benchmark-')) throw new Error('Unexpected temporary path');
  rmSync(folder, { recursive: true });
}
