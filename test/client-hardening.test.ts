import { describe, expect, it } from 'vitest';
import { IntempusClient } from '../src/intempus/client.js';

function client(fetchImpl: typeof fetch): IntempusClient {
  return new IntempusClient({ username: 'api-user', apiKey: 'api-key-value-123', fetchImpl });
}

describe('IntempusClient redirects, error bodies and configuration', () => {
  it('never follows redirects with the API key', async () => {
    const inits: RequestInit[] = [];
    const fetchImpl = (async (_url: string | URL, init: RequestInit = {}) => {
      inits.push(init);
      return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } });
    }) as unknown as typeof fetch;
    await expect(client(fetchImpl).get('employee/')).rejects.toThrow(/302.*redirect not followed/s);
    expect(inits).toHaveLength(1);
    expect(inits[0]?.redirect).toBe('manual');
  });

  it('caps error bodies', async () => {
    const fetchImpl = (async () =>
      new Response('x'.repeat(200_000), { status: 500, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch;
    const error = (await client(fetchImpl).get('employee/').catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message.length).toBeLessThan(70_000);
  });

  it('rejects an invalid INTEMPUS_TIMEOUT_MS instead of using NaN', () => {
    const saved = process.env.INTEMPUS_TIMEOUT_MS;
    process.env.INTEMPUS_TIMEOUT_MS = 'abc';
    try {
      expect(() => new IntempusClient({})).toThrow(/INTEMPUS_TIMEOUT_MS/);
    } finally {
      if (saved === undefined) delete process.env.INTEMPUS_TIMEOUT_MS;
      else process.env.INTEMPUS_TIMEOUT_MS = saved;
    }
  });
});
