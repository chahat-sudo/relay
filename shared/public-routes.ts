export type PublicRoute =
  | { kind: 'tracking'; slug: string; methods: readonly string[] }
  | { kind: 'events'; requestId: string; methods: readonly string[] }
  | { kind: 'asset' | 'challenge'; methods: readonly string[] };
export function publicRoute(pathname: string): PublicRoute | null {
  const tracking = /^\/r\/([^/]+)$/.exec(pathname);
  if (tracking) {
    let slug: string; try { slug = decodeURIComponent(tracking[1]); } catch { return null; }
    if (slug.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
    return { kind: 'tracking', slug, methods: ['GET', 'HEAD'] };
  }
  if (pathname === '/t/collector.js') return { kind: 'asset', methods: ['GET', 'HEAD'] };
  if (pathname === '/t/challenge') return { kind: 'challenge', methods: ['POST'] };
  const events = /^\/t\/events\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(pathname);
  return events ? { kind: 'events', requestId: events[1], methods: ['POST', 'OPTIONS'] } : null;
}
