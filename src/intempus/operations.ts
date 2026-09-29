import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { HttpMethod, IntempusClient, IntempusObject } from './client.js';
import { clearEmployeeCache } from './identity.js';
import { assertWritesEnabled } from './policy.js';

/**
 * Two-step admin changes for what cannot be undone from here: deletes,
 * locking work reports, and moving a contract's locked_date (period lock).
 *
 * prepare: reads every target (so the preview names what will change),
 *   builds the exact HTTP steps and signs them with an HMAC.
 * commit:  accepts only an operation this server signed, unexpired,
 *   prepared by the same user, echoed back with its hash, and whose steps
 *   still pass the allowlist — then runs the steps in order.
 *
 * The gateway can gate intempus_commit_prepared_operation with a duty
 * group (hosts.json toolGroups), so preparing and committing can be
 * separate privileges.
 */

/**
 * Not 'employee': Intempus answers 409 "Kan ikke slette Medarbejder da
 * Brugerprofiler er relateret" and user profiles have no DELETE, so an
 * employee is removed by offboarding (intempus_manage_employee).
 */
export const DELETABLE_RESOURCES = [
  'case',
  'customer',
  'contract',
  'work_report',
  'schedule',
  'planned_work_report',
  'balance',
] as const;
export type DeletableResource = (typeof DELETABLE_RESOURCES)[number];

export type AdminChange =
  | { kind: 'delete'; resource: DeletableResource; ids: number[] }
  | { kind: 'lock_work_reports'; ids: number[]; locked: boolean }
  | { kind: 'set_contract_locked_date'; contractIds: number[]; lockedDate: string | null };

export interface OperationStep {
  method: HttpMethod;
  path: string;
  body?: unknown;
}

export interface PreparedOperation {
  kind: AdminChange['kind'];
  steps: OperationStep[];
  preview: unknown[];
  reason: string;
  actingAs: string;
  preparedAt: string;
  expiresAt: string;
  operationHash: string;
}

const TTL_MS = 15 * 60 * 1000;
const processSecret = randomBytes(32);

function secret(): Buffer {
  const configured = process.env.INTEMPUS_OPERATION_SECRET;
  return configured ? Buffer.from(configured, 'utf8') : processSecret;
}

export async function prepareAdminChange(
  client: IntempusClient,
  change: AdminChange,
  context: { reason: string; actingAs: string },
): Promise<PreparedOperation> {
  const { steps, preview } = await planSteps(client, change);
  const preparedAt = new Date();
  const unsigned = {
    kind: change.kind,
    steps,
    preview,
    reason: context.reason,
    actingAs: context.actingAs,
    preparedAt: preparedAt.toISOString(),
    expiresAt: new Date(preparedAt.getTime() + TTL_MS).toISOString(),
  };
  return { ...unsigned, operationHash: sign(unsigned) };
}

export function verifyPreparedOperation(
  operation: PreparedOperation,
  context: { confirmOperationHash: string; actingAs: string; now?: Date },
): PreparedOperation {
  const { operationHash, ...unsigned } = operation;
  const expected = Buffer.from(sign(unsigned), 'hex');
  const given = Buffer.from(String(operationHash ?? ''), 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new Error('Prepared operation signature does not match; it was altered or prepared by another server. Prepare it again.');
  }
  if (context.confirmOperationHash !== operationHash) {
    throw new Error('confirmOperationHash does not match the operation; echo the operationHash from the prepare result.');
  }
  if ((context.now ?? new Date()).getTime() > Date.parse(operation.expiresAt)) {
    throw new Error('Prepared operation has expired (15 minutes); prepare it again.');
  }
  if (operation.actingAs !== context.actingAs) {
    throw new Error('Prepared operation belongs to another user; the committing user must prepare it themselves.');
  }
  for (const step of operation.steps) {
    assertAllowedStep(step);
  }
  return operation;
}

export async function commitPreparedOperation(client: IntempusClient, operation: PreparedOperation) {
  assertWritesEnabled(`commit ${operation.kind}`);
  const results: Array<{ step: number; method: HttpMethod; path: string; ok: boolean; error?: string }> = [];
  for (const [index, step] of operation.steps.entries()) {
    try {
      await client.send(step.method, step.path, step.body);
      results.push({ step: index + 1, method: step.method, path: step.path, ok: true });
    } catch (error) {
      results.push({
        step: index + 1,
        method: step.method,
        path: step.path,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  if (operation.kind === 'delete' || operation.kind === 'set_contract_locked_date') {
    clearEmployeeCache();
  }
  const failed = results.find(result => !result.ok);
  return {
    kind: operation.kind,
    completed: results.filter(result => result.ok).length,
    total: operation.steps.length,
    status: failed ? (results.length === 1 ? 'failed' : 'partially_applied') : 'applied',
    results,
  };
}

async function planSteps(client: IntempusClient, change: AdminChange): Promise<{ steps: OperationStep[]; preview: unknown[] }> {
  switch (change.kind) {
    case 'delete': {
      if (!DELETABLE_RESOURCES.includes(change.resource)) {
        throw new Error(`Deleting ${String(change.resource)} is not supported.`);
      }
      const rows = await readAll(client, change.resource, change.ids);
      return {
        steps: change.ids.map(id => ({ method: 'DELETE' as const, path: `${change.resource}/${id}/` })),
        preview: rows.map(row => describe(change.resource, row)),
      };
    }
    case 'lock_work_reports': {
      const rows = await readAll(client, 'work_report', change.ids);
      return {
        // Needs Intempus' "work report state" feature for the company; without
        // it Intempus answers 401 "Work report state can only be updated if
        // the feature is enabled" (verified 2026-09-29).
        steps: [
          {
            method: 'POST',
            path: 'work_report/bulk/',
            body: { ids: change.ids, immutable: change.locked, action: 'work_report_state' },
          },
        ],
        preview: rows.map(row => ({ ...(describe('work_report', row) as object), lockedNow: row.isimmutable === true, lockedAfter: change.locked })),
      };
    }
    case 'set_contract_locked_date': {
      const rows = await readAll(client, 'contract', change.contractIds);
      return {
        steps: change.contractIds.map(id => ({ method: 'PATCH' as const, path: `contract/${id}/`, body: { locked_date: change.lockedDate } })),
        preview: rows.map(row => ({ ...(describe('contract', row) as object), lockedDateNow: row.locked_date ?? null, lockedDateAfter: change.lockedDate })),
      };
    }
  }
}

async function readAll(client: IntempusClient, resource: string, ids: number[]): Promise<IntempusObject[]> {
  if (ids.length === 0) throw new Error('No ids given.');
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate ids given.');
  return Promise.all(ids.map(id => client.get<IntempusObject>(`${resource}/${id}/`)));
}

function describe(resource: string, row: IntempusObject): unknown {
  switch (resource) {
    case 'employee':
      return { resource, id: row.id, number: row.number, name: row.name, activeContract: row.active_contract };
    case 'case':
    case 'customer':
      return { resource, id: row.id, number: row.number, name: row.name };
    case 'contract':
      return { resource, id: row.id, employee: row.employee, workModel: row.work_model_name, startDate: row.start_date, endDate: row.end_date };
    case 'work_report':
      return {
        resource,
        id: row.id,
        employee: row.employee_name,
        date: row.start_date,
        amount: row.amount,
        case: row.case_name,
        workType: row.worktype_name,
        approved: row.approved,
      };
    default:
      return { resource, id: row.id, name: row.name ?? row.remarks };
  }
}

const STEP_PATTERNS: Array<{ method: HttpMethod; pattern: RegExp }> = [
  { method: 'DELETE', pattern: new RegExp(`^(${DELETABLE_RESOURCES.join('|')})/\\d+/$`) },
  { method: 'POST', pattern: /^work_report\/bulk\/$/ },
  { method: 'PATCH', pattern: /^contract\/\d+\/$/ },
];

function assertAllowedStep(step: OperationStep): void {
  if (!STEP_PATTERNS.some(entry => entry.method === step.method && entry.pattern.test(step.path))) {
    throw new Error(`Step ${step.method} ${step.path} is not an allowed admin change.`);
  }
  if (step.method === 'PATCH') {
    const keys = Object.keys((step.body ?? {}) as object);
    if (keys.length !== 1 || keys[0] !== 'locked_date') {
      throw new Error('Contract steps may only change locked_date.');
    }
  }
}

function sign(value: unknown): string {
  return createHmac('sha256', secret()).update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}
