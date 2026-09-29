import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { IntempusClient, idFromUri } from '../src/intempus/client.js';
import { redactSecrets, IntempusHttpError } from '../src/errors.js';
import { checkToolPolicy, configuredRoles, parseRoles, toolNamesFor } from '../src/intempus/policy.js';
import { resolveEmployee } from '../src/intempus/identity.js';
import { ApproverScope } from '../src/intempus/scope.js';
import { uuidV5 } from '../src/intempus/format.js';
import { createServer } from '../src/server.js';
import { FakeIntempus, jsonResponse, seed, uri } from './fake-intempus.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.INTEMPUS_PROFILE;
  delete process.env.INTEMPUS_ENABLE_WRITES;
  delete process.env.INTEMPUS_IDENTITY_MAP;
  delete process.env.INTEMPUS_IDENTITY_MAP_PATH;
  delete process.env.INTEMPUS_APPROVER_UNASSIGNED_SCOPE;
  delete process.env.INTEMPUS_AUDIT_LOG;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

async function connect(fake: FakeIntempus, onBehalfOf?: string) {
  const server = createServer({ client: fake.client(), onBehalfOf });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // error text
    }
    return { isError: result.isError === true, text, data: data as Record<string, any> };
  };
  return { client, call };
}

describe('client', () => {
  it('sends ApiKey auth with the case-sensitive username and builds resource URIs', async () => {
    const fake = new FakeIntempus(seed());
    const client = fake.client();
    await client.get('employee/1/');
    expect(fake.calls[0]?.headers.Authorization).toBe('ApiKey Api@User.dk:k3y');
    expect(client.uri('case', 42)).toBe('/web/v1/case/42/');
    await client.get('/web/v1/case/60/');
    expect(fake.calls[1]?.url).toBe('https://intempus.test/web/v1/case/60/');
  });

  it('joins __in filters with commas and uses cursor pagination', async () => {
    const fake = new FakeIntempus(seed());
    await fake.client().listAll('work_report/', { employee__in: [2, 3] });
    const url = new URL(fake.calls[0]!.url);
    expect(url.searchParams.get('employee__in')).toBe('2,3');
    expect(url.searchParams.get('pagination_type')).toBe('cursor');
  });

  it('falls back to offset pagination when a resource rejects cursor paging with 500', async () => {
    const fake = new FakeIntempus(seed());
    fake.failWhen = (_method, path, query) =>
      path === 'work_type/' && query.get('pagination_type') === 'cursor' ? jsonResponse(500, { error_message: 'Sorry' }) : undefined;
    const result = await fake.client().listAll('work_type/');
    expect(result.items).toHaveLength(fake.db.work_type!.length);
    expect(new URL(fake.calls[1]!.url).searchParams.get('pagination_type')).toBeNull();
  });

  it('waits out one 429 and retries', async () => {
    const fake = new FakeIntempus(seed());
    let first = true;
    fake.failWhen = () => {
      if (!first) return undefined;
      first = false;
      return jsonResponse(429, { error: 'throttled' }, { 'retry-after': '0' });
    };
    await expect(fake.client().get('employee/1/')).resolves.toMatchObject({ id: 1 });
    expect(fake.calls).toHaveLength(2);
  });

  it('flattens tastypie validation errors into readable lines', () => {
    const error = new IntempusHttpError({
      status: 400,
      url: 'https://intempus.test/web/v1/work_report/',
      payload: { work_report: { amount: ['This field is required.'] } },
    });
    expect(error.message).toBe('Intempus API request failed with HTTP 400 | work_report: amount: This field is required.');
    expect(new IntempusHttpError({ status: 400, url: 'x', payload: { error: ['ugyldig dato'] } }).message).toContain('ugyldig dato');
  });

  it('redacts ApiKey credentials', () => {
    expect(redactSecrets('Authorization: ApiKey Abo@X.dk:abc123 failed')).not.toContain('abc123');
    expect(redactSecrets('sent ApiKey Abo@X.dk:abc123')).not.toContain('abc123');
    expect(redactSecrets('INTEMPUS_API_KEY=abc123')).not.toContain('abc123');
  });

  it('reads relation ids from URIs and from embedded objects', () => {
    expect(idFromUri('/web/v1/work_model/68620/')).toBe(68620);
    expect(idFromUri({ id: 68620, resource_uri: '/web/v1/work_model/68620/' })).toBe(68620);
    expect(idFromUri({ resource_uri: '/web/v1/work_model/7/' })).toBe(7);
    expect(idFromUri(null)).toBeUndefined();
  });

  it('refuses plain http to non-loopback hosts', () => {
    expect(() => new IntempusClient({ baseUrl: 'http://intempus.dk/web/v1' })).toThrow(/Refusing/);
    expect(() => new IntempusClient({ baseUrl: 'http://127.0.0.1:9/web/v1' })).not.toThrow();
  });

  it('refuses to follow pagination links to another origin', async () => {
    const client = new FakeIntempus(seed()).client();
    await expect(client.get('https://evil.test/web/v1/employee/')).rejects.toThrow(/outside/);
  });
});

describe('policy', () => {
  it('gives each role its own tools and a user the union of their roles', () => {
    const employee = toolNamesFor(['employee']);
    const approver = toolNamesFor(['approver']);
    const admin = toolNamesFor(['admin']);
    expect(employee.has('intempus_register_time')).toBe(true);
    expect(employee.has('intempus_list_team')).toBe(false);
    expect(employee.has('intempus_manage_employee')).toBe(false);
    expect(approver.has('intempus_list_team_work_reports')).toBe(true);
    expect(approver.has('intempus_register_time')).toBe(false);
    expect(approver.has('intempus_commit_prepared_operation')).toBe(false);
    expect(admin.has('intempus_manage_employee')).toBe(true);
    expect(admin.has('intempus_register_time')).toBe(false);
    const jesper = toolNamesFor(['employee', 'approver', 'admin']);
    for (const tool of ['intempus_register_time', 'intempus_list_team', 'intempus_manage_employee', 'intempus_whoami']) {
      expect(jesper.has(tool)).toBe(true);
    }
    expect(toolNamesFor([]).size).toBe(0);
  });

  it('parses role lists strictly and takes roles from the gateway only in roles mode', () => {
    expect(parseRoles('admin, Employee,root,,approver')).toEqual(['employee', 'approver', 'admin']);
    expect(parseRoles(undefined)).toEqual([]);
    process.env.INTEMPUS_PROFILE = 'roles';
    expect(configuredRoles()).toEqual([]);
    process.env.INTEMPUS_PROFILE = 'employee,approver';
    expect(configuredRoles()).toEqual(['employee', 'approver']);
    delete process.env.INTEMPUS_PROFILE;
    expect(configuredRoles()).toEqual(['employee']);
  });

  it('denies write tools unless INTEMPUS_ENABLE_WRITES=true, and tools outside the roles', () => {
    expect(checkToolPolicy('intempus_register_time', ['employee']).allowed).toBe(false);
    process.env.INTEMPUS_ENABLE_WRITES = 'yes';
    expect(checkToolPolicy('intempus_register_time', ['employee']).allowed).toBe(false);
    process.env.INTEMPUS_ENABLE_WRITES = 'true';
    expect(checkToolPolicy('intempus_register_time', ['employee']).allowed).toBe(true);
    expect(checkToolPolicy('intempus_manage_employee', ['employee'])).toMatchObject({ allowed: false, reason: expect.stringContaining('your roles') });
    expect(checkToolPolicy('intempus_whoami', []).allowed).toBe(false);
    expect(checkToolPolicy('intempus_do_anything', ['admin']).reason).toContain('not allowlisted');
  });
});

describe('roles from the gateway', () => {
  it('registers the union of the roles passed per request', async () => {
    const fake = new FakeIntempus(seed());
    const server = createServer({ client: fake.client(), onBehalfOf: 'ann@one.dk', roles: ['employee', 'approver'] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(['intempus_register_time', 'intempus_list_team', 'intempus_whoami']));
    expect(names).not.toContain('intempus_manage_employee');
    const whoami = JSON.parse(((await client.callTool({ name: 'intempus_whoami', arguments: {} })).content as Array<{ text: string }>)[0]!.text);
    expect(whoami).toMatchObject({ roles: ['employee', 'approver'], employee: { id: 1 }, approver: { levels: [{ level: 'final_approver' }] } });
  });

  it('offers nothing without a role', async () => {
    const server = createServer({ client: new FakeIntempus(seed()).client(), onBehalfOf: 'ann@one.dk', roles: [] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    await expect(client.listTools()).rejects.toThrow();
  });
});

describe('identity (fail-closed)', () => {
  it('matches username, then work email, case-insensitively', async () => {
    const client = new FakeIntempus(seed()).client();
    await expect(resolveEmployee(client, 'ANN@one.dk')).resolves.toMatchObject({ employeeId: 1, matchedBy: 'username' });
    await expect(resolveEmployee(client, 'bo@one.dk')).resolves.toMatchObject({ employeeId: 2, matchedBy: 'email' });
  });

  it('never matches on the private email', async () => {
    const client = new FakeIntempus(seed()).client();
    await expect(resolveEmployee(client, 'bo@gmail.com')).rejects.toThrow(/No Intempus employee matches/);
    await expect(resolveEmployee(client, 'cy@one.dk')).rejects.toThrow(/No Intempus employee matches/);
  });

  it('uses INTEMPUS_IDENTITY_MAP before anything else', async () => {
    process.env.INTEMPUS_IDENTITY_MAP = JSON.stringify({ 'cy@one.dk': '3' });
    const client = new FakeIntempus(seed()).client();
    await expect(resolveEmployee(client, 'Cy@One.dk')).resolves.toMatchObject({ employeeId: 3, matchedBy: 'identity_map' });
  });

  it('refuses ambiguous matches', async () => {
    const data = seed();
    data.employee!.push({ ...data.employee![0]!, id: 4, number: '4' });
    await expect(resolveEmployee(new FakeIntempus(data).client(), 'ann@one.dk')).rejects.toThrow(/refusing to guess/);
  });
});

describe('approver scope', () => {
  const me = async (fake: FakeIntempus, upn = 'ann@one.dk') => {
    const client = fake.client();
    return { client, scope: new ApproverScope(client, await resolveEmployee(client, upn)) };
  };

  it('covers exactly the assigned employees', async () => {
    const { scope } = await me(new FakeIntempus(seed()));
    expect((await scope.load()).employeeIds).toEqual([2]);
    expect(await scope.coversEmployee(2)).toBe(true);
    expect(await scope.coversEmployee(3)).toBe(false);
  });

  it('expands department assignments to their employees', async () => {
    const data = seed();
    data.employee![2]!.department = uri('department', 77);
    data.responsible_for_department = [{ id: 801, department: uri('department', 77), responsible: uri('responsible', 700) }];
    const { scope } = await me(new FakeIntempus(data));
    expect((await scope.load()).employeeIds.sort()).toEqual([2, 3]);
  });

  it('is empty without assignments unless INTEMPUS_APPROVER_UNASSIGNED_SCOPE=all', async () => {
    const data = seed();
    data.responsible_for_employee = [];
    const empty = await me(new FakeIntempus(data));
    expect(await empty.scope.load()).toMatchObject({ all: false, employeeIds: [], note: expect.stringContaining('No responsible_for_') });
    process.env.INTEMPUS_APPROVER_UNASSIGNED_SCOPE = 'all';
    const all = await me(new FakeIntempus(data));
    expect((await all.scope.load()).all).toBe(true);
  });

  it('rejects users without an approver level', async () => {
    const { scope } = await me(new FakeIntempus(seed()), 'bo@one.dk');
    await expect(scope.load()).rejects.toThrow(/not registered as an approver/);
  });
});

describe('employee profile tools', () => {
  beforeEach(() => {
    process.env.INTEMPUS_PROFILE = 'employee';
    process.env.INTEMPUS_ENABLE_WRITES = 'true';
  });

  it('exposes only self-service tools', async () => {
    const { client } = await connect(new FakeIntempus(seed()), 'bo@one.dk');
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toContain('intempus_register_time');
    expect(names).not.toContain('intempus_list_employees');
    expect(names).not.toContain('intempus_list_team');
  });

  it('fails closed without a forwarded identity', async () => {
    const { call } = await connect(new FakeIntempus(seed()));
    const result = await call('intempus_list_my_work_reports');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('X-MCP-User');
  });

  it('pins registrations to the caller and computes hours from times', async () => {
    const fake = new FakeIntempus(seed());
    const { call } = await connect(fake, 'bo@one.dk');
    const result = await call('intempus_register_time', {
      date: '2026-09-29',
      caseId: 60,
      workTypeId: 50,
      startTime: '7:00',
      endTime: '15:30',
      breakHours: 0.5,
      idempotencyKey: 'retry-safe-1',
    });
    expect(result.isError).toBe(false);
    const post = fake.writes().find(write => write.method === 'POST')!;
    expect(post.body).toMatchObject({
      employee: uri('employee', 2),
      company: uri('company', 5),
      worktype: uri('work_type', 50),
      case: uri('case', 60),
      start_time: '07:00:00',
      end_time: '15:30:00',
      amount: 8,
      creation_id: uuidV5('bo@one.dk|2|retry-safe-1'),
    });
  });

  it('refuses a work type from another work model, a closed case and a locked period', async () => {
    const fake = new FakeIntempus(seed());
    const { call } = await connect(fake, 'bo@one.dk');
    expect((await call('intempus_register_time', { date: '2026-09-29', workTypeId: 51, hours: 1 })).text).toContain('work model');
    expect((await call('intempus_register_time', { date: '2026-09-29', workTypeId: 50, caseId: 61, hours: 1 })).text).toContain('closed');
    expect((await call('intempus_register_time', { date: '2026-03-02', workTypeId: 50, hours: 1 })).text).toContain('locked');
    expect((await call('intempus_register_time', { date: '2025-06-02', workTypeId: 50, hours: 1 })).text).toContain('no Intempus contract');
    expect(fake.writes()).toHaveLength(0);
  });

  it('knows Intempus\' own rules: interval work types need times, project work needs a case', async () => {
    const fake = new FakeIntempus(seed());
    const { call } = await connect(fake, 'bo@one.dk');
    expect((await call('intempus_register_time', { date: '2026-09-29', workTypeId: 52, caseId: 60, hours: 2 })).text).toContain('requires startTime and endTime');
    expect((await call('intempus_register_time', { date: '2026-09-29', workTypeId: 52, startTime: '07:00', endTime: '09:00' })).text).toContain('needs a caseId');
    expect((await call('intempus_register_time', { date: '2026-09-29', workTypeId: 52, caseId: 60, startTime: '07:00', endTime: '09:00' })).isError).toBe(false);
  });

  it('cannot touch other people\'s reports and cannot edit approved ones', async () => {
    const fake = new FakeIntempus(seed());
    const { call } = await connect(fake, 'bo@one.dk');
    const foreign = await call('intempus_delete_my_work_report', { workReportId: 902 });
    expect(foreign.text).toContain('not found among your registrations');
    const approved = await call('intempus_update_my_work_report', { workReportId: 901, hours: 6 });
    expect(approved.text).toContain('already approved');
    expect(fake.writes()).toHaveLength(0);
    const own = await call('intempus_delete_my_work_report', { workReportId: 900 });
    expect(own.isError).toBe(false);
    expect(fake.writes()).toEqual([expect.objectContaining({ method: 'DELETE', path: 'work_report/900/' })]);
  });

  it('refuses writes when the instance is read-only', async () => {
    process.env.INTEMPUS_ENABLE_WRITES = 'false';
    const fake = new FakeIntempus(seed());
    const { call } = await connect(fake, 'bo@one.dk');
    const result = await call('intempus_register_time', { date: '2026-09-29', workTypeId: 50, hours: 1 });
    expect(result.text).toContain('INTEMPUS_ENABLE_WRITES');
    expect(fake.writes()).toHaveLength(0);
  });
});

describe('approver profile tools', () => {
  beforeEach(() => {
    process.env.INTEMPUS_PROFILE = 'approver';
    process.env.INTEMPUS_ENABLE_WRITES = 'true';
  });

  it('has no approval tools: the public API cannot approve', async () => {
    const { client } = await connect(new FakeIntempus(seed()), 'ann@one.dk');
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toContain('intempus_list_team_work_reports');
    expect(names.some(name => name.includes('approve'))).toBe(false);
  });

  it('lists only team reports and refuses employees outside the scope', async () => {
    const fake = new FakeIntempus(seed());
    const { call } = await connect(fake, 'ann@one.dk');
    const team = await call('intempus_list_team_work_reports', { status: 'all', from: '2026-09-01', to: '2026-09-30' });
    expect(team.data.workReports.map((row: { id: number }) => row.id).sort()).toEqual([900, 901]);
    const other = await call('intempus_list_team_work_reports', { employeeId: 3 });
    expect(other.text).toContain('not in your approval scope');
  });
});

describe('admin profile tools', () => {
  beforeEach(() => {
    process.env.INTEMPUS_PROFILE = 'admin';
    process.env.INTEMPUS_ENABLE_WRITES = 'true';
  });

  it('prepares a signed delete without changing anything, then commits it', async () => {
    const fake = new FakeIntempus(seed());
    const { call } = await connect(fake, 'admin@one.dk');
    const prepared = await call('intempus_prepare_admin_change', { change: { kind: 'delete', resource: 'case', ids: [61] }, reason: 'test' });
    expect(prepared.isError).toBe(false);
    expect(prepared.data.preview).toEqual([expect.objectContaining({ id: 61, name: '2600 - Lukket' })]);
    expect(fake.writes()).toHaveLength(0);

    const committed = await call('intempus_commit_prepared_operation', {
      operation: prepared.data,
      confirmOperationHash: prepared.data.operationHash,
    });
    expect(committed.data).toMatchObject({ status: 'applied', completed: 1 });
    expect(fake.writes()).toEqual([expect.objectContaining({ method: 'DELETE', path: 'case/61/' })]);
  });

  it('does not offer deleting employees (Intempus refuses it); offboarding ends contracts and logins', async () => {
    const fake = new FakeIntempus(seed());
    const { call } = await connect(fake, 'admin@one.dk');
    expect((await call('intempus_prepare_admin_change', { change: { kind: 'delete', resource: 'employee', ids: [3] }, reason: 'x' })).isError).toBe(true);
    const off = await call('intempus_manage_employee', { action: 'offboard', employeeId: 2, date: '2026-10-31' });
    expect(off.data).toMatchObject({ endedContracts: [{ contractId: 102, endDate: '2026-10-31' }], loginsRevoked: true });
    expect(fake.writes().map(write => `${write.method} ${write.path}`)).toEqual(['PATCH contract/102/', 'PATCH userprofile/400/']);
  });

  it('refuses tampered, foreign or unconfirmed operations', async () => {
    const fake = new FakeIntempus(seed());
    const admin = await connect(fake, 'admin@one.dk');
    const prepared = (await admin.call('intempus_prepare_admin_change', {
      change: { kind: 'delete', resource: 'case', ids: [61] },
      reason: 'test',
    })).data;

    const tampered = { ...prepared, steps: [{ method: 'DELETE', path: 'case/60/' }] };
    expect((await admin.call('intempus_commit_prepared_operation', { operation: tampered, confirmOperationHash: prepared.operationHash })).text).toContain('signature');

    expect((await admin.call('intempus_commit_prepared_operation', { operation: prepared, confirmOperationHash: 'a'.repeat(64) })).text).toContain('confirmOperationHash');

    const other = await connect(fake, 'other-admin@one.dk');
    expect((await other.call('intempus_commit_prepared_operation', { operation: prepared, confirmOperationHash: prepared.operationHash })).text).toContain('another user');

    expect(fake.writes()).toHaveLength(0);
  });

  it('creates an employee without echoing the generated password', async () => {
    const fake = new FakeIntempus(seed());
    const { call } = await connect(fake, 'admin@one.dk');
    const result = await call('intempus_manage_employee', { action: 'create', name: 'Dee', number: '4', email: 'dee@one.dk', workModelId: 10 });
    expect(result.isError).toBe(false);
    const post = fake.writes().find(write => write.method === 'POST' && write.path === 'employee/')!;
    const body = post.body as { password: string; password_generation: number; username: string };
    expect(body).toMatchObject({ username: 'dee@one.dk', password_generation: 1 });
    expect(result.text).not.toContain(body.password);
    expect(fake.writes().some(write => write.path === 'contract/')).toBe(true);
  });

  it('refuses duplicate employee identity and duplicate cases', async () => {
    const fake = new FakeIntempus(seed());
    const { call } = await connect(fake, 'admin@one.dk');
    expect((await call('intempus_manage_employee', { action: 'create', name: 'X', email: 'ANN@one.dk' })).text).toContain('already used');
    expect((await call('intempus_manage_case', { action: 'create', projectNumber: '2636', name: 'Skovvej', customerId: 1 })).text).toContain('already exists');
    expect(fake.writes()).toHaveLength(0);
  });

  it('registers time for another employee', async () => {
    const fake = new FakeIntempus(seed());
    const { call } = await connect(fake, 'admin@one.dk');
    const result = await call('intempus_manage_work_report', { action: 'create', employeeId: 3, date: '2026-09-29', workTypeId: 51, hours: 4 });
    expect(result.isError).toBe(false);
    expect(fake.writes()[0]?.body).toMatchObject({ employee: uri('employee', 3), amount: 4 });
  });

  it('reads allowlisted resources only and strips credentials', async () => {
    const fake = new FakeIntempus(seed());
    fake.db.employee![0]!.password = 'hash';
    const { call } = await connect(fake, 'admin@one.dk');
    const employee = await call('intempus_get_resource', { resource: 'employee', id: 1 });
    expect(employee.data.password).toBeUndefined();
    expect((await call('intempus_get_resource', { resource: 'api_key' })).isError).toBe(true);
  });
});
