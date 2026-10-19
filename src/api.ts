export async function api<T>(path: string, options?: { method: string; body: unknown }): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api${path}`, options ? { method: options.method, headers: { 'Content-Type': 'application/json', 'X-Relay-Request': '1' }, body: JSON.stringify(options.body) } : undefined); } catch { throw new Error('The local server is unavailable. Restart Relay and try again.'); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'The request failed. Please try again.');
  return data as T;
}
