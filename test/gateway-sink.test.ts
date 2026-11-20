// The sink check (README, "Threat model"): nothing that leaves a gateway holds a piece of 6 characters of the key.
// Every output is checked in its final form; known counterexamples and keys spliced from real outputs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIntempusGateway } from '../src/gateway.js';
import { visibleTexts } from '../src/key-admission.js';
import { FakeIntempus, seed } from './fake-intempus.js';

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function pieces(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
  return out;
}

function leaked(key: string, outputs: unknown[]): string[] {
  const texts = outputs.flatMap(output => (typeof output === 'string' ? [output] : visibleTexts(output)));
  return pieces(key).filter(piece => texts.some(text => text.includes(piece)));
}

/** Every output of a normal session with this key, or the refusal when it is not admitted. */
async function outputs(apiKey: string): Promise<{ refused?: string; outputs: unknown[] }> {
  const records: unknown[] = [];
  const fake = new FakeIntempus(seed());
  // The upstream echoes the key in a failure body and in data.
  fake.failWhen = (_method, path) =>
    path === 'customer/' ? new Response(`bad key ${apiKey}`, { status: 400, headers: { 'content-type': 'text/plain' } }) : undefined;
  fake.db.case!.push({ id: 64, number: apiKey, name: `Echo ${apiKey}`, active: true, permit_new_workreports: true });
  let gw: ReturnType<typeof createIntempusGateway>;
  try {
    gw = createIntempusGateway({
      apiUser: 'Api@Example.com',
      apiKey,
      timeoutMs: 5_000,
      fetchImpl: fake.fetchImpl,
      policy: { enableWrites: true, audit: record => void records.push(record) },
    });
  } catch (error) {
    return { refused: (error as Error).message, outputs: [(error as Error).message, (error as Error).name, (error as Error).stack] };
  }
  const results = [
    await gw.callTool('list_cases', {}, { caller: `person ${apiKey}`, requestId: apiKey }),
    await gw.callTool('search_capabilities', { query: 'timer' }),
    await gw.callTool('get_employee', { employeeId: 2 }),
    await gw.callTool('list_customers', {}),
    await gw.callTool('manage_case', { action: 'update', caseId: 60, notes: apiKey }),
    await gw.callTool('get_resource', { resource: 'case', filters: { number: apiKey.replace(/[^a-z]/g, 'a') || 'a' } }),
    await gw.callTool('no_such_tool', {}),
    await gw.callTool(apiKey, {}),
    await gw.callTool('list_cases', { unknown: apiKey }),
  ];
  return { outputs: [gw.tools, ...results, ...records] };
}

describe('the sink check', () => {
  it('holds for known counterexamples', async () => {
    for (const apiKey of [
      'qz7":"staV8k2mP9',
      'x"ok":y-0123456789',
      'riskLevelQz7pX2vK9mWb',
      'Zq7pX2visError9mWb4TnR',
      'Qz7pX2vK9"data":[{"id"',
      'IntempusQz7pX2vK9mWb',
      '0123456789abcdef0123456789abcdef01234567',
      'Zq7pX2vK9mWb4TnR8yLc3HdJ6fGs1QeU',
    ]) {
      const { refused, outputs: seen } = await outputs(apiKey);
      if (refused !== undefined) expect(refused, apiKey).toMatch(/key was refused/);
      expect(leaked(apiKey, seen), apiKey).toEqual([]);
    }
  });

  it('holds for keys spliced from the outputs of a normal session', async () => {
    const base = await outputs('Zq7pX2vK9mWb4TnR8yLc3HdJ6fGs1QeU');
    expect(base.refused).toBeUndefined();
    // Spliced from the results and audit records (the tool list is refused whole by admission).
    const texts = base.outputs
      .slice(1)
      .flatMap(output => (typeof output === 'string' ? [output] : visibleTexts(output)))
      .filter(text => text.length >= 6);
    let seed = 11;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const filler = (n: number) => Array.from({ length: n }, () => String.fromCharCode(0x30 + random(43))).join('');
    let admitted = 0;
    for (let round = 0; round < 60; round += 1) {
      const text = texts[random(texts.length)]!;
      const start = random(text.length - 5);
      const window = text.slice(start, start + 6);
      if (!/^[\x21-\x7E]{6}$/.test(window)) continue;
      const apiKey = `${filler(6)}${window}${filler(6)}`;
      const { refused, outputs: seen } = await outputs(apiKey);
      if (refused === undefined) admitted += 1;
      expect(leaked(apiKey, seen), apiKey).toEqual([]);
    }
    expect(admitted).toBeGreaterThan(0);
  });

  it('throws construction errors in final form: no frames or paths in the stack, no cause', () => {
    for (const [apiKey, baseUrl] of [
      ['Qz7way.jsV8k2mP9X', 'invalid'],
      ['Qz7way.tsV8k2mP9X', 'https://evil.example.test/'],
      ['short', 'invalid'],
    ] as const) {
      let caught: Error | undefined;
      try {
        createIntempusGateway({ apiUser: 'Api@Example.com', apiKey, baseUrl, timeoutMs: 1_000, policy: {} });
      } catch (error) {
        caught = error as Error;
      }
      expect(caught, apiKey).toBeInstanceOf(Error);
      const stack = String(caught!.stack);
      expect(stack).toBe(`${caught!.name}: ${caught!.message}`);
      expect(stack).not.toMatch(/\n\s+at /);
      expect((caught as { cause?: unknown }).cause).toBeUndefined();
      expect(leaked(apiKey, [stack, caught!.message, caught!.name, caught])).toEqual([]);
    }
  });
});

describe('credentials the upstream echoes, which are not the instance key', () => {
  const KEY = 'tenant-a-key-0123456789abcdef';
  const S = 'opaque-session-secret-778899';

  it('are masked in structuredContent and in the text block', async () => {
    const fake = new FakeIntempus(seed());
    fake.db.customer = [
      {
        id: 1,
        name: 'Testkunde ApS',
        active: true,
        note: `Authorization: ApiKey someone:${S}`,
        accessToken: S,
        nested: { refresh_token: S, client_secret: S, password: S, api_key: S, pin: S },
        text: `api_key=${S}`,
      },
    ];
    const gw = createIntempusGateway({ apiUser: 'Api@Example.com', apiKey: KEY, fetchImpl: fake.fetchImpl, timeoutMs: 5_000 });
    const result = await gw.callTool('get_resource', { resource: 'customer' });
    expect(result.isError).toBeUndefined();
    const all = JSON.stringify(result);
    expect(all).not.toContain(S);
    expect(all).toContain('Testkunde ApS');
    const row = (result.structuredContent as { objects: Array<Record<string, unknown>> }).objects[0]!;
    expect(row.accessToken).toBe('‹redacted›');
    expect((row.nested as Record<string, unknown>).pin).toBe('‹redacted›');
    expect(result.content[0]!.text).not.toContain(S);
  });
});
