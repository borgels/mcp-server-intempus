// The embeddable gateway (package export ./gateway): catalog, credentials, policy, errors, results and tenants.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIntempusGateway,
  GatewayConfigError,
  intempusGatewayTools,
  intempusToolCatalog,
  type GatewayToolResult,
  type IntempusGatewayOptions,
} from '../src/gateway.js';
import { KNOWN_PROBLEMS } from '../src/errors.js';
import { createServer } from '../src/server.js';
import { FakeIntempus, jsonResponse, seed, uri } from './fake-intempus.js';

const KEY = 'Zq7pX2vK9mWb4TnR8yLc3HdJ6fGs1QeU'; // gitleaks:allow (test value, not a credential)
const USER = 'Api@Example.com';
const BASE = 'https://intempus.dk/web/v1/';

let dir: string;

beforeEach(() => {
  vi.unstubAllEnvs();
  dir = mkdtempSync(join(tmpdir(), 'intempus-gw-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function world(): FakeIntempus {
  const data = seed();
  data.customer = [{ id: 1, number: '100', name: 'Testkunde ApS', active: true }];
  data.schedule = [{ id: 300, employees: [uri('employee', 2)], start_date: '2026-10-01', end_date: null }];
  data.balance = [{ id: 20, name: 'Ferie', unit: 'days', visible: true }];
  data.explored_employee_balance = [{ id: 1, employee_pk: 2, balance_pk: 20, positive_sum: '10', negative_sum: '2' }];
  data.planned_work_report = [];
  data.department = [{ id: 7, name: 'Montage' }];
  data.work_report![0]!.worktype = uri('work_type', 50);
  return new FakeIntempus(data);
}

function gateway(fake: FakeIntempus, extra: Partial<IntempusGatewayOptions> = {}) {
  return createIntempusGateway({ apiUser: USER, apiKey: KEY, fetchImpl: fake.fetchImpl, timeoutMs: 5_000, ...extra });
}

const text = (result: GatewayToolResult) => result.content.map(entry => entry.text).join('\n');
const data = (result: GatewayToolResult) => result.structuredContent as Record<string, any>;

const EXPECTED_TOOLS: Array<[string, 'read' | 'write', boolean]> = [
  ['search_capabilities', 'read', false],
  ['list_cases', 'read', false],
  ['list_work_types', 'read', false],
  ['list_employees', 'read', false],
  ['get_employee', 'read', false],
  ['list_responsibilities', 'read', false],
  ['list_work_reports', 'read', false],
  ['list_customers', 'read', false],
  ['list_balances', 'read', false],
  ['get_employee_balances', 'read', false],
  ['list_schedules', 'read', false],
  ['list_planned_work', 'read', false],
  ['list_reference_data', 'read', false],
  ['get_resource', 'read', true],
  ['manage_work_report', 'write', false],
  ['manage_case', 'write', false],
  ['manage_customer', 'write', false],
  ['manage_schedule', 'write', false],
  ['manage_employee', 'write', false],
  ['manage_contract', 'write', false],
  ['manage_user_access', 'write', false],
  ['manage_responsibility', 'write', false],
];

describe('Intempus gateway catalog', () => {
  it('holds exactly the company-wide tools that need no identity, without the prefix', () => {
    expect(intempusToolCatalog.map(entry => [entry.name, entry.riskLevel, entry.broad])).toEqual(EXPECTED_TOOLS);
    for (const entry of intempusToolCatalog) {
      expect(entry.enabledByDefault).toBe(entry.riskLevel === 'read');
      expect(entry.name.startsWith('intempus_')).toBe(false);
      expect(entry.inputSchema.type).toBe('object');
      expect(entry.upstream.length > 0 || entry.name === 'search_capabilities').toBe(true);
      if (entry.riskLevel === 'read') {
        for (const op of entry.upstream) expect(op.method).toBe('GET');
      }
    }
    const names = intempusToolCatalog.map(entry => entry.name).join(' ');
    for (const absent of ['whoami', 'my_', 'team', 'register_time', 'prepare_admin_change', 'commit_prepared_operation']) {
      expect(names).not.toContain(absent);
    }
    const { upstream: _u, broad: _b, ...first } = intempusToolCatalog[1]!;
    expect(first).toEqual(intempusGatewayTools[1]);
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(intempusToolCatalog)).toBe(true);
    const visit = (value: unknown) => {
      if (typeof value === 'object' && value !== null) {
        expect(Object.isFrozen(value)).toBe(true);
        Object.values(value).forEach(visit);
      }
    };
    visit(intempusToolCatalog);
    expect(() => {
      (intempusToolCatalog[0] as { name: string }).name = 'changed';
    }).toThrow(TypeError);
  });

  it('shares its input schemas with the MCP server’s admin tools', async () => {
    vi.stubEnv('INTEMPUS_PROFILE', 'admin');
    const server = createServer({ client: world().client() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    for (const entry of intempusToolCatalog) {
      const tool = tools.find(candidate => candidate.name === `intempus_${entry.name}`);
      expect(tool, entry.name).toBeDefined();
      expect(Object.keys((entry.inputSchema.properties ?? {}) as object).sort()).toEqual(
        Object.keys(tool!.inputSchema.properties ?? {}).sort(),
      );
    }
  });
});

/** Sample inputs per tool, used to check each tool's declared upstream requests (every action of a manage tool). */
const SAMPLE_INPUTS: Record<string, Array<Record<string, unknown>>> = {
  search_capabilities: [{ query: 'timer' }],
  list_cases: [{ query: 'Skovvej', includeInactive: true }],
  list_work_types: [{}, { workModelId: 10 }, { employeeId: 2 }],
  list_employees: [{ query: 'bo' }],
  get_employee: [{ employeeId: 2 }],
  list_responsibilities: [{}],
  list_work_reports: [{ from: '2026-09-01', to: '2026-09-30', employeeIds: [2] }],
  list_customers: [{}],
  list_balances: [{}],
  get_employee_balances: [{}, { employeeIds: [2], to: '2026-09-30' }],
  list_schedules: [{}],
  list_planned_work: [{}],
  list_reference_data: [
    'departments',
    'employee_groups',
    'work_models',
    'work_categories',
    'working_hours_agreements',
    'case_states',
    'case_groups',
    'customer_groups',
    'holidays',
    'pay_types',
    'shifts',
    'companies',
  ].map(kind => ({ kind })),
  get_resource: [
    { resource: 'case', id: 60 },
    { resource: 'daily_rest_violation', filters: { start_date__gte: '2026-09-01' } },
  ],
  manage_work_report: [
    { action: 'create', employeeId: 2, date: '2026-09-29', workTypeId: 50, caseId: 60, hours: 2 },
    { action: 'update', workReportId: 900, hours: 6 },
  ],
  manage_case: [
    { action: 'create', projectNumber: '2700', name: 'Havnevej', customerId: 1 },
    { action: 'update', caseId: 60, active: false },
  ],
  manage_customer: [
    { action: 'create', name: 'Ny Kunde ApS' },
    { action: 'update', customerId: 1, city: 'Aarhus' },
  ],
  manage_schedule: [
    { action: 'create', employeeIds: [2], startDate: '2026-10-01', caseId: 60, weekdays: ['monday'] },
    { action: 'update', scheduleId: 300, remarks: 'Flyttet' },
  ],
  manage_employee: [
    { action: 'create', name: 'Dee', number: '4', email: 'dee@example.com', workModelId: 10 },
    { action: 'update', employeeId: 2, phone: '12345678' },
    { action: 'offboard', employeeId: 3, date: '2026-10-31' },
  ],
  manage_contract: [
    { action: 'create', employeeId: 2, workModelId: 10, startDate: '2026-11-01' },
    { action: 'update', contractId: 102, hourlyWage: 200 },
  ],
  manage_user_access: [
    { employeeId: 2, mayLogIntoBackend: true },
    { employeeId: 3, mayLogIntoApproval: true },
  ],
  manage_responsibility: [
    { action: 'add_level', employeeId: 2, level: 'second_approver' },
    { action: 'assign', responsibleId: 700, targetType: 'case', targetId: 60 },
    { action: 'unassign', targetType: 'employee', assignmentId: 800 },
    { action: 'remove_level', responsibleId: 700 },
  ],
};

describe('Intempus gateway upstream requests', () => {
  it('sends only the requests the catalog declares for each tool', async () => {
    for (const entry of intempusToolCatalog) {
      const inputs = SAMPLE_INPUTS[entry.name];
      expect(inputs, `sample input for ${entry.name}`).toBeDefined();
      for (const input of inputs!) {
        const fake = world();
        const gw = gateway(fake, { policy: { enableWrites: true } });
        const result = await gw.callTool(entry.name, input as never);
        expect(result.isError, `${entry.name} ${JSON.stringify(input)}: ${text(result)}`).toBeUndefined();
        const declared = entry.upstream.map(op => `${op.method} ${op.path.replace('{resource}', String(input.resource))}`);
        for (const call of fake.calls) {
          const path = `/${call.path.split('/').map(part => (/^\d+$/.test(part) ? '{id}' : part)).join('/')}`;
          expect(declared, `${entry.name} made ${call.method} ${path}`).toContain(`${call.method} ${path}`);
        }
        if (entry.riskLevel === 'write') expect(fake.writes().length, entry.name).toBeGreaterThan(0);
      }
    }
  });

  it('lists only the tools the instance offers in search_capabilities', async () => {
    const gw = gateway(world(), { policy: { disabledTools: ['list_customers'] } });
    const result = await gw.callTool('search_capabilities', { query: '', limit: 50 });
    const ids = (result.structuredContent as Array<{ id: string }>).map(capability => capability.id);
    expect(ids).toContain('intempus_list_cases');
    expect(ids).not.toContain('intempus_list_customers');
    for (const absent of ['intempus_whoami', 'intempus_register_time', 'intempus_prepare_admin_change', 'intempus_commit_prepared_operation']) {
      expect(ids).not.toContain(absent);
    }
  });
});

describe('Intempus gateway credentials', () => {
  it('requires apiUser and apiKey and never reads INTEMPUS_* credentials', () => {
    vi.stubEnv('INTEMPUS_API_USER', 'env-user@example.com');
    vi.stubEnv('INTEMPUS_API_KEY', 'EnvKeyEnvKeyEnvKey0123456789'); // gitleaks:allow (test value, not a credential)
    expect(() => createIntempusGateway({ apiUser: USER } as never)).toThrow(GatewayConfigError);
    expect(() => createIntempusGateway({ apiKey: KEY } as never)).toThrow(/apiUser and options.apiKey/);
    expect(() => createIntempusGateway(undefined as never)).toThrow(GatewayConfigError);
    expect(() => createIntempusGateway({ apiUser: 'two words', apiKey: KEY })).toThrow(/user name/);
    expect(() => createIntempusGateway({ apiUser: 'a:b', apiKey: KEY })).toThrow(/user name/);
  });

  it('admits keys only of printable ASCII and at least 16 characters, with a sealed refusal', () => {
    for (const apiKey of ['short-key', 'Zq7pX2vK 9mWb4TnR8yLc', 'Zq7pX2vK9mWb4TnRæøå8yLc', 'Intempus API request failed']) {
      let caught: Error | undefined;
      try {
        createIntempusGateway({ apiUser: USER, apiKey });
      } catch (error) {
        caught = error as Error;
      }
      expect(caught, apiKey).toBeInstanceOf(GatewayConfigError);
      expect(caught!.message).toMatch(/key was refused/);
      expect(caught!.stack).toBe(`${caught!.name}: ${caught!.message}`);
    }
  });

  it('sends ApiKey <user>:<key> to intempus.dk only, never the environment’s', async () => {
    vi.stubEnv('INTEMPUS_API_USER', 'env-user@example.com');
    vi.stubEnv('INTEMPUS_API_KEY', 'EnvKeyEnvKeyEnvKey0123456789'); // gitleaks:allow (test value, not a credential)
    vi.stubEnv('INTEMPUS_BASE_URL', 'https://elsewhere.example.test/web/v1');
    const fake = world();
    const result = await gateway(fake).callTool('list_employees', {});
    expect(result.isError).toBeUndefined();
    expect(fake.calls.length).toBeGreaterThan(0);
    for (const call of fake.calls) {
      expect(new URL(call.url).origin).toBe('https://intempus.dk');
      expect(call.headers.Authorization).toBe(`ApiKey ${USER}:${KEY}`);
    }
  });

  it('refuses a base URL outside intempus.dk without quoting it', () => {
    for (const baseUrl of [
      'https://evil.example.test/web/v1/',
      'http://intempus.dk/web/v1/',
      'https://intempus.dk.evil.example.test/web/v1/',
      'https://user:pw@intempus.dk/web/v1/',
      'https://intempus.dk/web/v1/?x=1',
      'not a url',
    ]) {
      expect(() => createIntempusGateway({ apiUser: USER, apiKey: KEY, baseUrl }), baseUrl).toThrow(
        'options.baseUrl must be an https address on intempus.dk.',
      );
    }
    expect(() => createIntempusGateway({ apiUser: USER, apiKey: KEY, baseUrl: BASE })).not.toThrow();
  });

  it('refuses an invalid timeout or policy without quoting it', () => {
    expect(() => gateway(world(), { timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => gateway(world(), { policy: { disabledTools: ['whoami'] } })).toThrow('policy.disabledTools[0] is not a known gateway tool.');
    expect(() => gateway(world(), { policy: { enableWrites: 'yes' as never } })).toThrow(/enableWrites/);
  });

  it('accepts gateway names and MCP server names, in any case', async () => {
    const gw = gateway(world());
    for (const name of ['list_cases', 'intempus_list_cases', 'LIST_CASES', ' Intempus_List_Cases ']) {
      expect((await gw.callTool(name, {})).isError, name).toBeUndefined();
    }
  });
});

describe('Intempus gateway policy', () => {
  it('reads no policy or audit variables, with or without a host policy', async () => {
    const auditPath = join(dir, 'audit.jsonl');
    vi.stubEnv('INTEMPUS_ENABLE_WRITES', 'true');
    vi.stubEnv('INTEMPUS_AUDIT_LOG', auditPath);
    vi.stubEnv('INTEMPUS_PROFILE', 'employee');
    vi.stubEnv('INTEMPUS_TIMEOUT_MS', 'not a number');
    const fake = world();
    const gw = gateway(fake);
    expect((await gw.callTool('list_cases', {})).isError).toBeUndefined();
    const refused = await gw.callTool('manage_customer', { action: 'create', name: 'X' });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toBe('Writes are disabled: the embedding host has not enabled writes for this instance.');
    expect(fake.writes()).toHaveLength(0);
    expect(() => readFileSync(auditPath, 'utf8')).toThrow();
  });

  it('runs write tools only with policy.enableWrites and when they are not disabled', async () => {
    const fake = world();
    const on = gateway(fake, { policy: { enableWrites: true } });
    expect((await on.callTool('manage_customer', { action: 'create', name: 'Ny Kunde ApS' })).isError).toBeUndefined();
    expect(fake.writes()).toHaveLength(1);

    const off = gateway(fake, { policy: { enableWrites: true, disabledTools: ['manage_customer', 'intempus_list_cases'] } });
    expect(off.tools.map(tool => tool.name)).not.toContain('manage_customer');
    expect(off.tools.map(tool => tool.name)).not.toContain('list_cases');
    expect(off.tools).toHaveLength(intempusGatewayTools.length - 2);
    const refused = await off.callTool('manage_customer', { action: 'create', name: 'Ny Kunde ApS' });
    expect(text(refused)).toMatch(/disabled on this instance by the embedding host/);
    expect(fake.writes()).toHaveLength(1);
  });

  it('writes audit records to the host’s sink with a caller pseudonym and fixed error codes', async () => {
    const records: Array<Record<string, unknown>> = [];
    const fake = world();
    fake.failWhen = (_method, path) => (path === 'customer/' ? jsonResponse(400, { customer: { name: ['Navn mangler'] } }) : undefined);
    const gw = gateway(fake, { policy: { enableWrites: true, audit: record => void records.push({ ...record }) } });
    await gw.callTool('list_cases', {}, { caller: 'person@example.com', requestId: 'host-req-1' });
    await gw.callTool('manage_customer', { action: 'create', name: 'Ny' }, { caller: 'person@example.com' });
    await gw.callTool('no_such_tool', {});
    await gw.callTool('list_cases', { unknown: 1 });
    expect(records.map(record => [record.tool, record.action])).toEqual([
      ['intempus_list_cases', 'start'],
      ['intempus_list_cases', 'finish'],
      ['intempus_manage_customer', 'start'],
      ['intempus_manage_customer', 'error'],
      ['unknown_tool', 'rejected'],
      ['intempus_list_cases', 'rejected'],
    ]);
    expect(records[0]!.caller).toMatch(/^hmac:[0-9a-f]{16}$/);
    expect(records[2]!.caller).toBe(records[0]!.caller);
    expect(records[3]!.error).toBe('http_400');
    const all = JSON.stringify(records);
    for (const forbidden of ['person@example.com', 'host-req-1', 'Navn mangler', 'no_such_tool', KEY, USER]) {
      expect(all).not.toContain(forbidden);
    }
  });

  it('does not run a tool whose start record the sink refuses', async () => {
    const fake = world();
    const gw = gateway(fake, {
      policy: {
        enableWrites: true,
        audit: () => {
          throw new Error(`sink is down ${KEY}`);
        },
      },
    });
    const result = await gw.callTool('manage_customer', { action: 'create', name: 'Ny' });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('The Intempus call failed.');
    expect(fake.writes()).toHaveLength(0);
  });
});

describe('Intempus gateway errors', () => {
  it('starts with the HTTP status in our own text and never carries the Intempus body', async () => {
    const cases: Array<[number, unknown, RegExp]> = [
      [400, { work_report: { amount: ['Beløbet er ugyldigt for Hemmelig Kunde A/S'] } }, /Check the ids, dates and required fields/],
      [401, 'Brugeren har ikke adgang til funktionen Hemmelig', /refused the API user or key/],
      [403, { error: 'Ingen adgang' }, /no access/],
      [404, { error: 'Findes ikke' }, /found nothing/],
      [500, '<html>Traceback Hemmelig</html>', /internal error/],
      [418, { error: 'Hemmelig tekande' }, /^Intempus API request failed with HTTP 418$/],
    ];
    for (const [status, body, hint] of cases) {
      const fake = world();
      fake.failWhen = () => jsonResponse(status, body, { 'retry-after': 'Hemmelig' });
      const result = await gateway(fake).callTool('list_customers', {});
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(new RegExp(`^Intempus API request failed with HTTP ${status}`));
      expect(text(result)).toMatch(hint);
      expect(JSON.stringify(result)).not.toMatch(/Hemmelig|Beløbet|Brugeren|Ingen adgang|Findes ikke|Traceback/);
    }
  });

  it('turns a known Danish validation message into our own text, and nothing else of the body', async () => {
    const [phrase, ours] = KNOWN_PROBLEMS[0]!;
    const fake = world();
    fake.failWhen = (method, path) =>
      method === 'POST' && path === 'work_report/'
        ? jsonResponse(400, { work_report: { __all__: [`Kontrakt og arbejdstype ${phrase} (Hemmelig model)`] } })
        : undefined;
    const result = await gateway(fake, { policy: { enableWrites: true } }).callTool('manage_work_report', {
      action: 'create',
      employeeId: 2,
      date: '2026-09-29',
      workTypeId: 50,
      hours: 1,
    });
    expect(text(result)).toBe(`Intempus API request failed with HTTP 400 | ${ours}`);
    expect(JSON.stringify(result)).not.toMatch(/Hemmelig|arbejdstype/);
  });

  it('keeps a parsed Retry-After and drops anything else', async () => {
    const fake = world();
    fake.failWhen = () => jsonResponse(429, { error: 'Slow down Hemmelig' }, { 'retry-after': '120' });
    const result = await gateway(fake, { maxRetryAfterSeconds: 0 }).callTool('list_customers', {});
    expect(text(result)).toMatch(/^Intempus API request failed with HTTP 429 \| .*throttling.* \| retry-after=120s$/);
  });

  it('refuses redirects, network failures and timeouts in our own words, without the address or the cause', async () => {
    const redirect: typeof fetch = async () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.example.test/steal?k=1' } });
    const redirected = await createIntempusGateway({ apiUser: USER, apiKey: KEY, fetchImpl: redirect }).callTool('list_cases', {});
    expect(text(redirected)).toBe('Intempus API request failed with HTTP 302 | Intempus answered with a redirect, which is not followed.');

    const down: typeof fetch = async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443 Hemmelig'), { code: 'ECONNREFUSED' }) });
    };
    const refused = await createIntempusGateway({ apiUser: USER, apiKey: KEY, fetchImpl: down }).callTool('list_cases', {});
    expect(text(refused)).toBe('Intempus could not be reached. (ECONNREFUSED)');

    const slow: typeof fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    const timedOut = await createIntempusGateway({ apiUser: USER, apiKey: KEY, fetchImpl: slow, timeoutMs: 20 }).callTool('list_cases', {});
    expect(text(timedOut)).toBe('Intempus did not answer within the time limit. Retry later.');

    const odd: typeof fetch = async () => {
      throw new Error(`Hemmelig upstream text ${KEY}`);
    };
    const failed = await createIntempusGateway({ apiUser: USER, apiKey: KEY, fetchImpl: odd }).callTool('list_cases', {});
    expect(text(failed)).toBe('The Intempus call failed.');
  });

  it('puts no Intempus names into the errors of its own checks', async () => {
    const fake = world();
    fake.db.case!.push({ id: 62, number: '10', name: 'Hemmelig Sag', active: false, permit_new_workreports: false });
    fake.db.work_type![1]!.name = 'Hemmelig Type';
    const gw = gateway(fake, { policy: { enableWrites: true } });
    const closed = await gw.callTool('manage_work_report', { action: 'create', employeeId: 2, date: '2026-09-29', workTypeId: 50, caseId: 62, hours: 1 });
    expect(text(closed)).toBe('Case 62 is closed for new time registrations.');
    const model = await gw.callTool('manage_work_report', { action: 'create', employeeId: 2, date: '2026-09-29', workTypeId: 51, hours: 1 });
    expect(text(model)).toMatch(/^Work type 51 belongs to work model 11, not to the employee's work model 10/);
    const duplicate = await gw.callTool('manage_case', { action: 'create', name: 'Hemmelig Sag', customerId: 1 });
    expect(text(duplicate)).toBe('Case 62 with the same number or name already exists; update it instead.');
    const locked = await gw.callTool('manage_work_report', { action: 'create', employeeId: 2, date: '2026-03-02', workTypeId: 50, hours: 1 });
    expect(text(locked)).toMatch(/locked/);
    expect(JSON.stringify([closed, model, duplicate, locked])).not.toMatch(/Hemmelig|Fastansatte|Vikar/);
    expect(fake.writes()).toHaveLength(0);
  });

  it('quotes no value of a stored registration in the errors of an update', async () => {
    const fake = world();
    const report = fake.db.work_report![0]!;
    report.start_time = 'UPSTREAM_FREE_TEXT_ABCXYZ';
    report.end_time = '17:00:00';
    const gw = gateway(fake, { policy: { enableWrites: true } });
    const badTime = await gw.callTool('manage_work_report', { action: 'update', workReportId: 900, remarks: 'Ny bemærkning' });
    expect(text(badTime)).toBe('Invalid time; use HH:MM.');
    report.start_time = '07:00:00';
    report.start_date = 'UPSTREAM_DATE_ABCXYZ';
    const badDate = await gw.callTool('manage_work_report', { action: 'update', workReportId: 900, remarks: 'Ny bemærkning' });
    expect(text(badDate)).toBe('Work report 900 has no readable date; refusing to change it.');
    report.start_date = '2026-09-28';
    report.worktype = '/web/v1/work_type/UPSTREAM_TYPE_ABCXYZ/';
    const badType = await gw.callTool('manage_work_report', { action: 'update', workReportId: 900, remarks: 'Ny bemærkning' });
    expect(badType.isError).toBe(true);
    expect(JSON.stringify([badTime, badDate, badType])).not.toContain('ABCXYZ');
    expect(fake.writes()).toHaveLength(0);
  });

  it('validates input with the tool schema before anything is sent, and refuses unknown fields and tools', async () => {
    const fake = world();
    const gw = gateway(fake, { policy: { enableWrites: true } });
    const unknownField = await gw.callTool('list_cases', { query: 'x', extra: true });
    expect(text(unknownField)).toMatch(/^Invalid input for list_cases:/);
    const badDate = await gw.callTool('list_work_reports', { from: '29-09-2026' });
    expect(text(badDate)).toMatch(/^Invalid input for list_work_reports:/);
    for (const name of ['whoami', 'intempus_register_time', 'prepare_admin_change', 'commit_prepared_operation', 'get_my_profile', KEY]) {
      const result = await gw.callTool(name, {});
      expect(text(result), name).toBe('Unsupported Intempus gateway tool.');
    }
    expect(fake.calls).toHaveLength(0);
  });
});

describe('Intempus gateway results', () => {
  it('puts the summary, then the data as compact JSON, in the text block, exactly the structured content', async () => {
    const result = await gateway(world()).callTool('get_employee', { employeeId: 2 });
    const [summary, json, ...rest] = result.content[0]!.text.split('\n\n');
    expect(summary).toBe('Intempus employee.');
    expect(rest).toEqual([]);
    expect(JSON.parse(json!)).toEqual(result.structuredContent);
    expect(data(result)).toMatchObject({ id: 2, name: 'Bo', access: { userProfileId: 400 } });
  });

  it('never returns a password, PIN or key, generated or read', async () => {
    const fake = world();
    fake.db.employee![1]!.password = 'pbkdf2_sha256$hash';
    fake.db.employee![1]!.pin = '4321';
    fake.db.employee![1]!.current_password = 'old-secret';
    fake.db.webhook_configuration = [{ id: 1, url: 'https://hooks.example.test/x', secret: 'whsec-123456', api_key: 'ak-123456' }]; // gitleaks:allow (test value, not a credential)
    const gw = gateway(fake, { policy: { enableWrites: true } });

    const created = await gw.callTool('manage_employee', { action: 'create', name: 'Dee', number: '4', username: 'dee' });
    expect(created.isError).toBeUndefined();
    const post = fake.writes().find(write => write.method === 'POST' && write.path === 'employee/')!;
    const generated = (post.body as { password: string }).password;
    expect(generated.length).toBeGreaterThan(10);
    expect(JSON.stringify(created)).not.toContain(generated);

    const raw = await gw.callTool('get_resource', { resource: 'employee', id: 2 });
    const hook = await gw.callTool('get_resource', { resource: 'webhook_configuration' });
    const all = JSON.stringify([raw, hook]);
    for (const secret of ['pbkdf2_sha256$hash', '4321', 'old-secret', 'whsec-123456', 'ak-123456']) { // gitleaks:allow (test value, not a credential)
      expect(all).not.toContain(secret);
    }
    expect(data(raw).name).toBe('Bo');
    expect(data(hook).objects[0].url).toBe('https://hooks.example.test/x');
  });

  it('redacts the key from values, object keys and numbers, in text and data', async () => {
    const fake = world();
    fake.db.customer = [{ id: 1, number: KEY.slice(3, 15), name: `Kunde ${KEY}`, [`key-${KEY.slice(0, 10)}`]: 1, active: true }];
    const result = await gateway(fake).callTool('get_resource', { resource: 'customer' });
    expect(result.isError).toBeUndefined();
    const all = JSON.stringify(result);
    for (let i = 0; i + 6 <= KEY.length; i += 1) expect(all).not.toContain(KEY.slice(i, i + 6));
    expect(all).toContain('‹redacted›');
  });
});

describe('Intempus gateway tenants', () => {
  it('keeps the company and the employees of each instance apart', async () => {
    const a = world();
    const b = world();
    b.db.company = [{ id: 6, name: 'Other' }];
    b.db.employee = [{ id: 77, number: '77', name: 'Eva', username: 'eva', email: 'eva@example.com', company: uri('company', 6), active_contract: true, contract: [] }];
    const gwA = gateway(a, { policy: { enableWrites: true } });
    const gwB = gateway(b, { policy: { enableWrites: true } });
    await gwA.callTool('manage_customer', { action: 'create', name: 'Kunde A' });
    await gwB.callTool('manage_customer', { action: 'create', name: 'Kunde B' });
    expect(a.writes()[0]!.body).toMatchObject({ company: uri('company', 5) });
    expect(b.writes()[0]!.body).toMatchObject({ company: uri('company', 6) });
    const [listA, listB] = await Promise.all([gwA.callTool('list_employees', {}), gwB.callTool('list_employees', {})]);
    expect(data(listA).employees.map((row: { name: string }) => row.name)).toEqual(['Ann', 'Bo', 'Cy']);
    expect(data(listB).employees.map((row: { name: string }) => row.name)).toEqual(['Eva']);
  });

  it('runs a call made from inside another instance’s sink under its own policy', async () => {
    const inner = world();
    const innerGw = gateway(inner);
    let innerResult: GatewayToolResult | undefined;
    const outer = gateway(world(), {
      policy: {
        enableWrites: true,
        audit: async record => {
          if (record.action === 'start' && !innerResult) {
            innerResult = await innerGw.callTool('manage_customer', { action: 'create', name: 'Inner' });
          }
        },
      },
    });
    await outer.callTool('list_cases', {});
    expect(text(innerResult!)).toMatch(/Writes are disabled/);
    expect(inner.writes()).toHaveLength(0);
  });
});

describe('Intempus gateway personal data', () => {
  function absenceWorld(): FakeIntempus {
    const fake = world();
    for (const row of fake.db.work_type!) row.vacation_or_leave = false;
    fake.db.work_type!.push(
      { id: 53, name: 'Sygdom', active: true, vacation_or_leave: true, work_model: uri('work_model', 10) },
      { id: 55, name: 'Barn syg', active: true, work_model: uri('work_model', 10) },
      { id: 54, name: 'Ferie', active: true, vacation_or_leave: true, work_model: uri('work_model', 10) },
    );
    fake.db.work_report = [
      { id: 910, employee: uri('employee', 2), employee_id: '2', start_date: '2026-09-21', amount: '7.5', worktype: uri('work_type', 53), worktype_name: 'Sygdom', work_category_name: 'Fravær', remarks: 'Influenza og feber', additional_remarks: 'Lægeerklæring', approved_by: [] },
      { id: 911, employee: uri('employee', 2), employee_id: '2', start_date: '2026-09-22', amount: '7.5', worktype: uri('work_type', 54), worktype_name: 'Ferie', work_category_name: 'Fravær', remarks: 'Sommerhus', approved_by: [] },
      { id: 912, employee: uri('employee', 2), employee_id: '2', start_date: '2026-09-23', amount: '7.5', worktype: uri('work_type', 50), worktype_name: 'Projekttimer', remarks: 'Montage', approved_by: [] },
    ];
    fake.db.schedule = [
      { id: 930, employees: [uri('employee', 2)], work_type: uri('work_type', 53), work_type__name: 'Sygdom', start_date: '2026-09-01', end_date: null, remarks: 'Operation i knæet' },
      { id: 931, employees: [uri('employee', 2)], work_type: uri('work_type', 50), work_type__name: 'Projekttimer', start_date: '2026-09-01', end_date: null, remarks: 'Montage' },
      { id: 932, employees: [uri('employee', 2)], work_type: { id: 53, resource_uri: uri('work_type', 53), name: 'Sygdom', work_category: { id: 5, name: 'Helbredsfravær' } }, start_date: '2026-09-01', end_date: null, remarks: 'Genoptræning', note: 'Fysioterapi', extra: [{ category_name: 'Helbredsfravær', keep: 'ok' }, { resource_uri: uri('work_type', 53), id: 53, name: 'Sygdom' }, { nested: { link: uri('work_category', 5), id: 5, name: 'Helbredsfravær' }, keep: 'ok' }] },
    ];
    fake.db.work_report.push({ id: 913, employee: uri('employee', 2), employee_id: '2', start_date: '2026-09-24', amount: '7.5', worktype: uri('work_type', 55), worktype_name: 'Barn syg', remarks: 'Mæslinger', approved_by: [] });
    fake.db.planned_work_report = [
      { id: 920, employee: uri('employee', 2), worktype: uri('work_type', 53), start_date: '2099-01-02', remarks: 'Operation i knæet' },
      { id: 921, employee: uri('employee', 2), worktype: uri('work_type', 50), start_date: '2099-01-03', remarks: 'Montage' },
      { id: 922, employee: uri('employee', 2), worktype: null, start_date: '2099-01-04', remarks: 'Kemoterapi' },
    ];
    fake.db.balance = [
      { id: 20, name: 'Ferie', unit: 'days', visible: true },
      { id: 21, name: 'Sygdom', unit: 'days', visible: true },
    ];
    fake.db.explored_employee_balance = [
      { id: 1, employee_pk: 2, balance_pk: 20, positive_sum: '10', negative_sum: '2', start_date: '2000-01-01', end_date: '2026-09-30' },
      { id: 2, employee_pk: 2, balance_pk: 21, positive_sum: '3', negative_sum: '0', start_date: '2000-01-01', end_date: '2026-09-30' },
    ];
    fake.db.employee![1]!.personal_email = 'bo.private@example.net';
    fake.db.employee![1]!.next_of_kin_name = 'Pårørende Person';
    fake.db.employee![1]!.emergency_contact_phone = '+4512345678';
    fake.db.employee![1]!.cpr_number = '010190-1234';
    fake.db.employee![1]!.birth_date = '1990-01-01';
    return fake;
  }

  it('shows a sensitive absence type as Absence without its reason, and a neutral one as it is', async () => {
    const fake = absenceWorld();
    const result = await gateway(fake).callTool('list_work_reports', { from: '2026-09-20', to: '2026-09-30' });
    const rows = data(result).workReports as Array<Record<string, any>>;
    const sick = rows.find(row => row.id === 910)!;
    expect(sick.workType.name).toBe('Absence');
    expect(sick).not.toHaveProperty('category');
    expect(sick).not.toHaveProperty('remarks');
    expect(sick).not.toHaveProperty('additionalRemarks');
    expect(sick.amount).toBe(7.5);
    const holiday = rows.find(row => row.id === 911)!;
    expect(holiday.workType.name).toBe('Ferie');
    expect(holiday.remarks).toBe('Sommerhus');
    expect(rows.find(row => row.id === 912)!.remarks).toBe('Montage');
    expect(JSON.stringify(result)).not.toMatch(/Sygdom|Influenza|Lægeerklæring/);
  });

  it('treats a work type without the absence mark as sensitive (fail closed)', async () => {
    const result = await gateway(absenceWorld()).callTool('list_work_reports', { from: '2026-09-20', to: '2026-09-30' });
    const row = (data(result).workReports as Array<Record<string, any>>).find(entry => entry.id === 913)!;
    expect(row.workType.name).toBe('Absence');
    expect(row).not.toHaveProperty('remarks');
    expect(JSON.stringify(result)).not.toMatch(/Barn syg|Mæslinger/);
  });

  it('masks the reason in schedules, listed and saved', async () => {
    const fake = absenceWorld();
    const gw = gateway(fake, { policy: { enableWrites: true } });
    const listed = await gw.callTool('list_schedules', {});
    const rows = data(listed).schedules as Array<Record<string, any>>;
    const sick = rows.find(row => row.id === 930)!;
    expect(sick).not.toHaveProperty('remarks');
    expect(sick.workType).toEqual({ name: 'Absence' });
    expect(sick).not.toHaveProperty('work_type');
    expect(sick).not.toHaveProperty('work_type__name');
    expect(rows.find(row => row.id === 931)!.remarks).toBe('Montage');
    const saved = await gw.callTool('manage_schedule', { action: 'update', scheduleId: 930, remarks: 'Genoptræning' });
    expect(saved.isError).toBeUndefined();
    const embedded = rows.find(row => row.id === 932)!;
    expect(embedded).not.toHaveProperty('work_type');
    expect(embedded.workType).toEqual({ name: 'Absence' });
    expect(JSON.stringify([listed, saved])).not.toMatch(/Sygdom|Operation|Genoptræning|Helbredsfravær|Fysioterapi/);
  });

  it('leaves no id or URI in a masked entry that list_work_types can link back to the sensitive work type', async () => {
    const fake = absenceWorld();
    fake.db.planned_work_report!.push({ id: 923, employee: uri('employee', 2), worktype: uri('work_type', 53), start_date: '2099-01-05', remarks: 'x' });
    const gw = gateway(fake, { policy: { enableWrites: true } });
    const types = data(await gw.callTool('list_work_types', {})).workTypes as Array<{ id: number; name: string }>;
    const sick = types.find(type => type.name === 'Sygdom')!;
    expect(sick.id).toBe(53);
    const reports = await gw.callTool('list_work_reports', { from: '2026-09-20', to: '2026-09-30' });
    const saved = await gw.callTool('manage_work_report', { action: 'update', workReportId: 910, remarks: 'Stadig syg' });
    const planned = await gw.callTool('list_planned_work', { from: '2099-01-01', to: '2099-01-10' });
    const schedules = await gw.callTool('list_schedules', {});
    const masked = [
      (data(reports).workReports as Array<Record<string, any>>).find(row => row.id === 910)!,
      data(saved),
      (data(planned).planned as Array<Record<string, any>>).find(row => row.id === 923)!,
      (data(schedules).schedules as Array<Record<string, any>>).find(row => row.id === 930)!,
      (data(schedules).schedules as Array<Record<string, any>>).find(row => row.id === 932)!,
    ];
    // Objects that point at a work type or category go whole; the last keeps what is not a reference.
    expect(masked[4]!.extra).toEqual([{ keep: 'ok' }]);
    for (const row of masked) {
      expect(row.workType).toMatchObject({ name: 'Absence' });
      expect(Object.keys(row.workType).filter(key => key !== 'unit')).toEqual(['name']);
      const { workType: _workType, ...rest } = row;
      const json = JSON.stringify(rest);
      expect(json).not.toMatch(/work_?type|work_?category|workTypeId|category/i);
      expect(json).not.toContain(uri('work_type', 53));
      expect(json).not.toMatch(/Helbredsfravær|Sygdom|_pk|Pk/);
      // No id field anywhere in the row holds the sensitive work type's id.
      const ids = JSON.stringify(row, (key, value) => (/(^|_)id$|Id$/.test(key) && value === sick.id ? 'LINK' : value));
      expect(ids).not.toContain('LINK');
    }
  });

  it('masks the reason in the answer of manage_work_report and in planned work', async () => {
    const fake = absenceWorld();
    const gw = gateway(fake, { policy: { enableWrites: true } });
    const saved = await gw.callTool('manage_work_report', { action: 'update', workReportId: 910, remarks: 'Stadig syg' });
    expect(saved.isError).toBeUndefined();
    expect(data(saved).workType.name).toBe('Absence');
    expect(JSON.stringify(saved)).not.toMatch(/Sygdom|Stadig syg|Lægeerklæring/);
    const planned = await gw.callTool('list_planned_work', { from: '2099-01-01', to: '2099-01-10' });
    const result = planned;
    const rows = data(planned).planned as Array<Record<string, any>>;
    expect(rows.find(row => row.id === 920)).not.toHaveProperty('remarks');
    expect(rows.find(row => row.id === 921)!.remarks).toBe('Montage');
    // No work type: treated as absence (fail closed), through serialisation.
    expect(rows.find(row => row.id === 922)).not.toHaveProperty('remarks');
    expect(result.content[0]!.text).not.toContain('Kemoterapi');
  });

  it('names a sensitive balance Absence and keeps the numbers; the definitions stay', async () => {
    const fake = absenceWorld();
    const gw = gateway(fake);
    const result = await gw.callTool('get_employee_balances', { employeeIds: [2], to: '2026-09-30' });
    const balances = data(result).balances as Array<Record<string, any>>;
    expect(balances.map(row => [row.balance, row.net])).toEqual([
      ['Ferie', 8],
      ['Absence', 3],
    ]);
    expect(JSON.stringify(result)).not.toContain('Sygdom');
    const definitions = await gw.callTool('list_balances', {});
    expect(JSON.stringify(definitions)).toContain('Sygdom');
  });

  it('leaves out private contact data and identity numbers, in views and raw rows', async () => {
    const fake = absenceWorld();
    const gw = gateway(fake);
    const outputs = [
      await gw.callTool('get_employee', { employeeId: 2 }),
      await gw.callTool('list_employees', {}),
      await gw.callTool('get_resource', { resource: 'employee', id: 2 }),
      await gw.callTool('get_resource', { resource: 'employee' }),
    ];
    for (const result of outputs) expect(result.isError).toBeUndefined();
    const all = JSON.stringify(outputs);
    for (const forbidden of ['personalEmail', 'personal_email', 'bo.private@example.net', 'next_of_kin', 'Pårørende Person', 'emergency_contact', '+4512345678', 'cpr_number', '010190-1234', 'birth_date', '1990-01-01']) {
      expect(all, forbidden).not.toContain(forbidden);
    }
    expect(data(outputs[0]!).name).toBe('Bo');
  });

  it('refuses raw absence resources in get_resource without a request', async () => {
    const fake = absenceWorld();
    const gw = gateway(fake);
    for (const resource of ['work_report', 'historical_work_report', 'explored_employee_balance', 'holiday_year_balance', 'holiday_year_balance_work_type', 'work_type_balance', 'planned_work_report', 'incident', 'missing_report_anomaly', 'schedule']) {
      const result = await gw.callTool('get_resource', { resource });
      expect(result.isError, resource).toBe(true);
      expect(text(result)).toMatch(/^This resource is not available through this connection/);
    }
    expect(fake.calls).toHaveLength(0);
  });
});
