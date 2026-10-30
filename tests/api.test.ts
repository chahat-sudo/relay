import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/api.ts';

test('hosted API failures identify SPA fallback and expired authentication without parsing HTML as JSON', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('<!doctype html><html></html>', { headers: { 'Content-Type': 'text/html' } });
    await assert.rejects(api('/bootstrap'), /backend API is unavailable/);
    globalThis.fetch = async () => new Response('Sign in', { status: 401 });
    await assert.rejects(api('/bootstrap'), /Sign in/);
    globalThis.fetch = async () => Response.json({ error: 'Database unavailable' }, { status: 503 });
    await assert.rejects(api('/bootstrap'), /Database unavailable/);
  } finally { globalThis.fetch = original; }
});
