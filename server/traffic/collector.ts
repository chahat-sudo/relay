// Served as a first-party integration asset. It never reads page text, cookies or storage.
export const collectorScript = `(() => {
  'use strict';
  const script = document.currentScript;
  const requestId = new URL(location.href).searchParams.get('relay_request');
  if (!script || !requestId || !/^[a-f0-9-]{36}$/.test(requestId)) return;
  const endpoint = new URL('/t/events/' + requestId, script.src);
  const started = performance.now();
  const errors = [];
  const read = (name, fn) => { try { return fn(); } catch { errors.push(name); return null; } };
  const facts = {
    version: 1,
    webdriver: read('webdriver', () => typeof navigator.webdriver === 'boolean' ? navigator.webdriver : null),
    language: read('language', () => navigator.language ? navigator.language.slice(0, 100) : null),
    timezone: read('timezone', () => Intl.DateTimeFormat().resolvedOptions().timeZone || null),
    platform: read('platform', () => navigator.userAgentData?.platform || null),
    viewport: read('viewport', () => ({ width: Math.min(20000, Math.max(0, innerWidth)), height: Math.min(20000, Math.max(0, innerHeight)) })),
    cookiesEnabled: read('cookiesEnabled', () => typeof navigator.cookieEnabled === 'boolean' ? navigator.cookieEnabled : null),
    elapsedMs: null, errors
  };
  facts.elapsedMs = Math.round(performance.now() - started);
  fetch(endpoint, { method: 'POST', credentials: 'include', mode: 'cors', cache: 'no-store', keepalive: true,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(facts) }).catch(() => {});
})();`;
