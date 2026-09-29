import { vi } from 'vitest';
import { IntempusClient } from '../src/intempus/client.js';
import { clearEmployeeCache } from '../src/intempus/identity.js';

type Row = Record<string, unknown> & { id: number };

export interface Recorded {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

const PREFIX = '/web/v1/';
export const uri = (resource: string, id: number) => `${PREFIX}${resource}/${id}/`;

/**
 * A tiny in-memory Intempus: list endpoints with a few exact filters,
 * detail GET/PATCH/DELETE and POST — enough to exercise tools end-to-end.
 */
export class FakeIntempus {
  readonly db: Record<string, Row[]> = {};
  readonly calls: Recorded[] = [];
  private nextId = 9000;
  /** Return a canned failure for matching requests. */
  failWhen?: (method: string, path: string, query: URLSearchParams) => Response | undefined;

  constructor(seed: Record<string, Row[]> = {}) {
    for (const [resource, rows] of Object.entries(seed)) {
      this.db[resource] = rows.map(row => ({ resource_uri: uri(resource, row.id), ...row }));
    }
  }

  client(): IntempusClient {
    clearEmployeeCache();
    return new IntempusClient({
      username: 'Api@User.dk',
      apiKey: 'k3y',
      baseUrl: 'https://intempus.test/web/v1',
      fetchImpl: this.fetch as unknown as typeof fetch,
      maxRetryAfterSeconds: 0,
    });
  }

  writes(): Recorded[] {
    return this.calls.filter(call => call.method !== 'GET');
  }

  private readonly fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const path = url.pathname.slice(PREFIX.length);
    this.calls.push({ method, url: url.toString(), path, headers: (init?.headers ?? {}) as Record<string, string>, body });

    const failure = this.failWhen?.(method, path, url.searchParams);
    if (failure) return failure;

    const [resource, id, extra] = path.split('/').filter(Boolean);
    if (!resource) return json(404, null);
    const table = (this.db[resource] ??= []);

    if (id === undefined || extra !== undefined || id === 'bulk') {
      if (method === 'GET') {
        const rows = table.filter(row => matches(row, url.searchParams));
        return json(200, { meta: { limit: 1000, next: null, total_count: rows.length }, objects: rows });
      }
      if (method === 'POST') {
        if (id === 'bulk') return json(200, { ok: true });
        const created: Row = { ...(body as object), id: this.nextId++ };
        created.resource_uri = uri(resource, created.id);
        table.push(created);
        return json(201, created);
      }
      return json(405, { error: 'method not allowed' });
    }

    const row = table.find(entry => entry.id === Number(id));
    if (!row) return json(404, null);
    if (method === 'GET') return json(200, row);
    if (method === 'PATCH') {
      Object.assign(row, body);
      return json(202, row);
    }
    if (method === 'DELETE') {
      table.splice(table.indexOf(row), 1);
      return new Response(null, { status: 204 });
    }
    return json(405, { error: 'method not allowed' });
  });
}

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, value] of params) {
    if (['limit', 'offset', 'pagination_type', 'after', 'order_by'].includes(key)) continue;
    const [field, op] = key.split('__') as [string, string | undefined];
    const actual = row[field];
    const comparable = typeof actual === 'string' && actual.startsWith(PREFIX) ? String(Number(actual.split('/').at(-2))) : String(actual);
    if (op === undefined || op === 'exact') {
      if (comparable !== value) return false;
    } else if (op === 'in') {
      if (!value.split(',').includes(comparable)) return false;
    } else if (op === 'gte') {
      if (!(String(actual) >= value)) return false;
    } else if (op === 'lte') {
      if (!(String(actual) <= value)) return false;
    }
  }
  return true;
}

function json(status: number, body: unknown): Response {
  return new Response(body === null ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A small company: employee 1 (Ann, approver), 2 (Bo), 3 (Cy, other team). */
export function seed(): Record<string, Row[]> {
  const contract = (id: number, employee: number, workModel = 10) => ({
    id,
    employee: uri('employee', employee),
    start_date: '2026-01-01',
    end_date: null,
    locked_date: '2026-03-31',
    work_model: uri('work_model', workModel),
    work_model_name: workModel === 10 ? 'Fastansatte' : 'Vikar',
    resource_uri: uri('contract', id),
  });
  return {
    company: [{ id: 5, name: 'ONE' }],
    employee: [
      { id: 1, number: '1', name: 'Ann', username: 'ann@one.dk', email: 'ann@one.dk', company: uri('company', 5), active_contract: true, contract: [contract(101, 1)] },
      { id: 2, number: '2', name: 'Bo', username: 'bo123', email: 'Bo@One.dk', personal_email: 'bo@gmail.com', company: uri('company', 5), active_contract: true, contract: [contract(102, 2)] },
      { id: 3, number: '3', name: 'Cy', username: 'cy', email: '', personal_email: 'cy@one.dk', company: uri('company', 5), active_contract: true, contract: [contract(103, 3, 11)] },
    ],
    contract: [contract(101, 1), contract(102, 2), contract(103, 3, 11)],
    responsible: [{ id: 700, employee: uri('employee', 1), level: 'final_approver' }],
    responsible_for_employee: [{ id: 800, employee: uri('employee', 2), responsible: uri('responsible', 700) }],
    responsible_for_department: [],
    responsible_for_case: [],
    work_type: [
      { id: 50, name: 'Projekttimer', active: true, work_model: uri('work_model', 10), work_model__name: 'Fastansatte' },
      { id: 51, name: 'Vikartimer', active: true, work_model: uri('work_model', 11), work_model__name: 'Vikar' },
      // As the detail endpoint returns it: work_model and work_category embedded.
      {
        id: 52,
        name: 'Projekttimer (interval)',
        active: true,
        report_interval: true,
        work_model: { id: 10, resource_uri: uri('work_model', 10) },
        work_category: { id: 5, case_related: true },
      },
    ],
    case: [
      { id: 60, number: '8', name: '2636 - Skovvej', active: true, permit_new_workreports: true },
      { id: 61, number: '9', name: '2600 - Lukket', active: false, permit_new_workreports: false },
    ],
    work_report: [
      { id: 900, employee: uri('employee', 2), employee_id: '2', start_date: '2026-09-28', amount: '7.5', approved: false, approved_by: [], isimmutable: false },
      { id: 901, employee: uri('employee', 2), employee_id: '2', start_date: '2026-09-27', amount: '7.5', approved: true, approved_by: [{ level: 'final_approver', date: '2026-09-28' }] },
      { id: 902, employee: uri('employee', 3), employee_id: '3', start_date: '2026-09-28', amount: '8', approved: false, approved_by: [] },
      { id: 903, employee: uri('employee', 1), employee_id: '1', start_date: '2026-09-28', amount: '8', approved: false, approved_by: [] },
    ],
    userprofile: [
      { id: 400, employee: uri('employee', 2), may_log_into_backend: false, may_log_into_approval: false },
      { id: 401, employee: uri('employee', 1), may_log_into_backend: false, may_log_into_approval: true },
    ],
  };
}
