// The gateway's self tools: they act on the Intempus employee of the person the host gives as actAs, and on nobody else.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACT_AS_TEXTS, createIntempusGateway, type GatewayToolResult, type IntempusGatewayOptions } from '../src/gateway.js';
import { FakeIntempus, seed, uri } from './fake-intempus.js';

const KEY = 'Zq7pX2vK9mWb4TnR8yLc3HdJ6fGs1QeU'; // gitleaks:allow (test value, not a credential)
const USER = 'Api@Example.com';

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

function world(): FakeIntempus {
  const data = seed();
  data.balance = [{ id: 20, name: 'Ferie', unit: 'days', visible: true }];
  data.explored_employee_balance = [
    // The fake matches Intempus' exact filters, so the rows carry the period get_my_balances asks for.
    { id: 1, employee_pk: 2, balance_pk: 20, positive_sum: '10', negative_sum: '2', start_date: '2000-01-01', end_date: '2026-09-30' },
    { id: 2, employee_pk: 1, balance_pk: 20, positive_sum: '25', negative_sum: '0', start_date: '2000-01-01', end_date: '2026-09-30' },
  ];
  data.planned_work_report = [];
  return new FakeIntempus(data);
}

function gateway(fake: FakeIntempus, extra: Partial<IntempusGatewayOptions> = {}) {
  return createIntempusGateway({ apiUser: USER, apiKey: KEY, fetchImpl: fake.fetchImpl, timeoutMs: 5_000, policy: { enableWrites: true }, ...extra });
}

const text = (result: GatewayToolResult) => result.content.map(entry => entry.text).join('\n');
const data = (result: GatewayToolResult) => result.structuredContent as Record<string, any>;
const as = (email: string) => ({ actAs: { email } });

describe('finding the person', () => {
  it('finds the employee by work email or username, case-insensitively', async () => {
    const byEmail = await gateway(world()).callTool('get_my_profile', {}, as('BO@example.COM'));
    expect(byEmail.isError, text(byEmail)).toBeUndefined();
    expect(data(byEmail)).toMatchObject({ id: 2, name: 'Bo' });
    const byUsername = await gateway(world()).callTool('get_my_profile', {}, as('ann@example.com'));
    expect(data(byUsername)).toMatchObject({ id: 1, name: 'Ann' });
  });

  it('refuses as no_user, sending nothing more, when no employee has the address (the private email never counts)', async () => {
    for (const email of ['nobody@example.com', 'bo.private@example.net', 'cy@example.com']) {
      const fake = world();
      const result = await gateway(fake).callTool('register_time', { date: '2026-09-29', workTypeId: 50, hours: 1 }, as(email));
      expect(result.actAsRefused, email).toBe('no_user');
      expect(text(result)).toBe(ACT_AS_TEXTS.no_user);
      expect(text(result)).not.toContain(email);
      expect(fake.writes()).toHaveLength(0);
    }
  });

  it('refuses as no_user when two employees share the address, in either field', async () => {
    const fake = world();
    fake.db.employee!.push({ id: 4, number: '4', name: 'Bo 2', username: 'bo@example.com', email: '', company: uri('company', 5), contract: [] });
    const result = await gateway(fake).callTool('list_my_work_reports', {}, as('bo@example.com'));
    expect(result.actAsRefused).toBe('no_user');
  });

  it('never reads the identity map from the environment', async () => {
    vi.stubEnv('INTEMPUS_IDENTITY_MAP', JSON.stringify({ 'stranger@example.com': '2' }));
    const result = await gateway(world()).callTool('get_my_profile', {}, as('stranger@example.com'));
    expect(result.actAsRefused).toBe('no_user');
  });

  it('refuses a self tool without actAs, and a malformed actAs on any tool, as invalid with nothing sent', async () => {
    const fake = world();
    const gw = gateway(fake);
    const none = await gw.callTool('get_my_balances', {});
    expect(none.actAsRefused).toBe('invalid');
    expect(text(none)).toBe(ACT_AS_TEXTS.invalid);
    for (const actAs of [null, 'bo@example.com', { email: 'not an address' }, { email: 'bo@example.com', name: 7 }]) {
      const result = await gw.callTool('list_cases', {}, { actAs } as never);
      expect(result.actAsRefused, JSON.stringify(actAs)).toBe('invalid');
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('lets the company-wide tools ignore actAs, and keeps actAsRefused off a successful result', async () => {
    const result = await gateway(world()).callTool('list_work_reports', { from: '2026-09-01', to: '2026-09-30' }, as('bo@example.com'));
    expect(result.isError).toBeUndefined();
    expect(result.actAsRefused).toBeUndefined();
    expect(data(result).count).toBe(4);
  });
});

describe('the person’s own data only', () => {
  it('lists only the person’s own registrations and balances', async () => {
    const reports = await gateway(world()).callTool('list_my_work_reports', { from: '2026-09-01', to: '2026-09-30' }, as('bo@example.com'));
    expect(data(reports).workReports.map((row: { id: number }) => row.id).sort()).toEqual([900, 901]);
    const balances = await gateway(world()).callTool('get_my_balances', { to: '2026-09-30' }, as('bo@example.com'));
    expect(data(balances).balances.map((row: { employeeId: number }) => row.employeeId)).toEqual([2]);
  });

  it('registers time on the person’s own employee, never the one in the input', async () => {
    const fake = world();
    const result = await gateway(fake).callTool('register_time', { date: '2026-09-29', workTypeId: 50, caseId: 60, hours: 2 }, as('bo@example.com'));
    expect(result.isError, text(result)).toBeUndefined();
    const post = fake.writes().find(write => write.method === 'POST' && write.path === 'work_report/')!;
    expect((post.body as { employee: string }).employee).toBe(uri('employee', 2));
    expect(JSON.stringify(post.body)).not.toContain('bo@example.com');
    const foreign = await gateway(fake).callTool('register_time', { date: '2026-09-29', workTypeId: 50, hours: 2, employeeId: 1 } as never, as('bo@example.com'));
    expect(text(foreign)).toMatch(/^Invalid input for register_time:/);
  });

  it('refuses to correct or delete another employee’s registration, and changes nothing', async () => {
    const fake = world();
    const gw = gateway(fake);
    const update = await gw.callTool('update_my_work_report', { workReportId: 903, hours: 1 }, as('bo@example.com'));
    expect(update.isError).toBe(true);
    expect(text(update)).toBe('Work report 903 was not found among your registrations.');
    const remove = await gw.callTool('delete_my_work_report', { workReportId: 902 }, as('bo@example.com'));
    expect(text(remove)).toBe('Work report 902 was not found among your registrations.');
    expect(fake.writes()).toHaveLength(0);
  });

  it('deletes only an own registration that is neither approved nor locked', async () => {
    const fake = world();
    const gw = gateway(fake);
    const approved = await gw.callTool('delete_my_work_report', { workReportId: 901 }, as('bo@example.com'));
    expect(text(approved)).toMatch(/already approved/);
    expect(fake.writes()).toHaveLength(0);
    const open = await gw.callTool('delete_my_work_report', { workReportId: 900 }, as('bo@example.com'));
    expect(open.isError, text(open)).toBeUndefined();
    expect(fake.writes().map(write => `${write.method} ${write.path}`)).toEqual(['DELETE work_report/900/']);
  });

  it('runs the writes only when the host enabled them', async () => {
    const fake = world();
    const result = await gateway(fake, { policy: {} }).callTool('register_time', { date: '2026-09-29', workTypeId: 50, hours: 2 }, as('bo@example.com'));
    expect(result.isError).toBe(true);
    expect(fake.writes()).toHaveLength(0);
  });
});

describe('the audit', () => {
  it('never holds the person’s address', async () => {
    const records: Array<Readonly<Record<string, unknown>>> = [];
    const fake = world();
    const gw = gateway(fake, { policy: { enableWrites: true, audit: record => void records.push(record) } });
    await gw.callTool('register_time', { date: '2026-09-29', workTypeId: 50, hours: 2 }, { caller: 'person-1', ...as('bo@example.com') });
    await gw.callTool('get_my_profile', {}, { caller: 'person-1', ...as('nobody@example.com') });
    await gw.callTool('get_my_planning', {}, { caller: 'person-1' });
    expect(records.length).toBeGreaterThan(0);
    const all = JSON.stringify(records).toLowerCase();
    expect(all).not.toContain('bo@example.com');
    expect(all).not.toContain('nobody@example.com');
  });
});
