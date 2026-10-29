import type { TrafficOperation } from '../shared/traffic.ts';
type Operation = TrafficOperation | 'bootstrap' | 'summary' | 'clicks' | 'crawler-requests' | 'conversions.list' | 'conversions.create' | 'settings' | 'simulate' | 'articles.generate' | 'destinations.save' | 'campaigns.save' | 'articles.save';
interface Route { operation: Operation; method: 'GET' | 'POST' | 'PUT'; id?: string; }

const endpoints: Record<string, Route> = {
  '/api/traffic/status': { operation: 'traffic.status', method: 'GET' },
  '/api/traffic/config': { operation: 'traffic.config', method: 'PUT' },
  '/api/traffic/config/history': { operation: 'traffic.history', method: 'GET' },
  '/api/traffic/requests': { operation: 'traffic.requests', method: 'GET' },
  '/api/traffic/summary': { operation: 'traffic.summary', method: 'GET' },
  '/api/traffic/intelligence/refresh': { operation: 'traffic.refresh', method: 'POST' },
  '/api/traffic/labels': { operation: 'traffic.labels', method: 'POST' },
  '/api/traffic/simulate': { operation: 'traffic.simulate', method: 'POST' },
  '/api/traffic/maintenance': { operation: 'traffic.maintenance', method: 'POST' },
  '/api/traffic/model/evaluate': { operation: 'traffic.model', method: 'POST' },
  '/api/bootstrap': { operation: 'bootstrap', method: 'GET' },
  '/api/summary': { operation: 'summary', method: 'GET' },
  '/api/clicks': { operation: 'clicks', method: 'GET' },
  '/api/crawler-requests': { operation: 'crawler-requests', method: 'GET' },
  '/api/settings': { operation: 'settings', method: 'PUT' },
  '/api/simulate': { operation: 'simulate', method: 'POST' },
  '/api/articles/generate': { operation: 'articles.generate', method: 'POST' },
};

// Resolve the path once so method validation and the handler share its meaning.
export function apiRoute(pathname: string, method: string | undefined): { route: Route; allow: string } | null {
  if (Object.hasOwn(endpoints, pathname)) return { route: endpoints[pathname], allow: endpoints[pathname].method };
  const traffic = /^\/api\/traffic\/requests\/([a-f0-9-]{36})$/.exec(pathname);
  if (traffic) return { route: { operation: 'traffic.detail', method: 'GET', id: traffic[1] }, allow: 'GET' };
  if (pathname === '/api/conversions') return { route: { operation: method === 'GET' ? 'conversions.list' : 'conversions.create', method: method === 'GET' ? 'GET' : 'POST' }, allow: 'GET, POST' };
  const match = /^\/api\/(destinations|campaigns|articles)(?:\/([^/]+))?$/.exec(pathname);
  if (!match) return null;
  const resource = match[1] as 'destinations' | 'campaigns' | 'articles';
  const id = match[2];
  return { route: { operation: `${resource}.save`, method: id ? 'PUT' : 'POST', id }, allow: id ? 'PUT' : 'POST' };
}
