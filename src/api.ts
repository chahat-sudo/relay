export async function api<T>(path: string, options?: { method: string; body: unknown }): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api${path}`, options ? { method: options.method, headers: { 'Content-Type': 'application/json', 'X-Relay-Request': '1' }, body: JSON.stringify(options.body) } : undefined); } catch { throw new Error('Relay is unavailable. Check your connection and try again.'); }
  if (response.status === 401) { await response.body?.cancel(); throw new Error('Sign in to your Relay workspace and reload this page.'); }
  if (!response.headers.get('Content-Type')?.toLowerCase().includes('application/json')) { await response.body?.cancel(); throw new Error('The backend API is unavailable. Check the deployment configuration and try again.'); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'The request failed. Please try again.');
  return data as T;
}
