import { idFromUri, type IntempusClient, type IntempusObject, type QueryValue } from './client.js';
import {
  addDays,
  caseView,
  customerView,
  employeeView,
  hoursBetween,
  normalizeTime,
  plannedView,
  today,
  uuidV5,
  workReportView,
  workTypeView,
} from './format.js';
import { contractOn, contractsOf, listEmployeesCached, type ContractSummary } from './identity.js';
import { assertWritesEnabled } from './policy.js';

// ---------------------------------------------------------------- reads

export interface WorkReportQuery {
  employeeIds?: number[];
  caseId?: number;
  from?: string;
  to?: string;
  approved?: boolean;
  limit?: number;
}

export async function listWorkReports(client: IntempusClient, input: WorkReportQuery) {
  const to = input.to ?? today();
  const from = input.from ?? addDays(to, -31);
  const query: Record<string, QueryValue> = {
    start_date__gte: from,
    start_date__lte: to,
    case: input.caseId,
    approved: input.approved,
  };
  if (input.employeeIds) {
    if (input.employeeIds.length === 0) return { from, to, count: 0, truncated: false, workReports: [] };
    query.employee__in = input.employeeIds;
  }
  const result = await client.listAll('work_report/', query, input.limit ?? 500);
  const workReports = result.items
    .map(workReportView)
    .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)) || String(a.startTime).localeCompare(String(b.startTime)));
  return {
    from,
    to,
    count: workReports.length,
    truncated: result.truncated,
    totalHours: Math.round(workReports.reduce((sum, row) => sum + (row.amount ?? 0), 0) * 100) / 100,
    workReports,
  };
}

export async function getWorkReport(client: IntempusClient, id: number): Promise<IntempusObject> {
  return client.get<IntempusObject>(`work_report/${id}/`);
}

export async function listCases(
  client: IntempusClient,
  input: { query?: string; includeInactive?: boolean; limit?: number },
) {
  const query: Record<string, QueryValue> = input.includeInactive ? {} : { active: true };
  const result = await client.listAll('case/', query, 5000);
  const needle = input.query?.trim().toLowerCase();
  const cases = result.items
    .filter(row => input.includeInactive || row.permit_new_workreports !== false)
    .filter(row => !needle || `${String(row.number ?? '')} ${String(row.name ?? '')} ${String(row.customer_name ?? '')}`.toLowerCase().includes(needle))
    .map(caseView);
  const limit = input.limit ?? 100;
  return { count: cases.length, truncated: cases.length > limit, cases: cases.slice(0, limit) };
}

export async function listWorkTypes(
  client: IntempusClient,
  input: { workModelIds?: number[]; query?: string; includeInactive?: boolean },
) {
  const query: Record<string, QueryValue> = input.includeInactive ? {} : { active: true };
  if (input.workModelIds?.length === 1) query.work_model = input.workModelIds[0];
  if (input.query) query.name__icontains = input.query;
  const result = await client.listAll('work_type/', query, 5000);
  const models = input.workModelIds ? new Set(input.workModelIds) : undefined;
  const workTypes = result.items
    .filter(row => !models || models.has(idFromUri(row.work_model) ?? -1))
    .map(workTypeView);
  return { count: workTypes.length, workTypes };
}

export async function listBalanceDefinitions(client: IntempusClient) {
  return (await client.listAll('balance/', {}, 1000)).items;
}

/**
 * Balances (saldi) per employee from explored_employee_balance, which
 * Intempus computes over [from, to] (both required by the API; it returns
 * only balances with movement). `net` = positive_sum − negative_sum.
 */
export async function employeeBalances(
  client: IntempusClient,
  input: { employeeIds: number[]; from?: string; to?: string; visibility: 'employee' | 'approver' | 'admin' },
) {
  const to = input.to ?? today();
  const from = input.from ?? '2000-01-01';
  if (input.employeeIds.length === 0) return { from, to, balances: [] };
  const [definitions, explored] = await Promise.all([
    listBalanceDefinitions(client),
    client.listAll('explored_employee_balance/', { employee_pk__in: input.employeeIds, start_date: from, end_date: to }, 10_000),
  ]);
  const byId = new Map(definitions.map(row => [Number(row.id), row]));
  const visible = (definition: IntempusObject | undefined): boolean => {
    if (!definition) return input.visibility === 'admin';
    if (input.visibility === 'admin') return true;
    if (input.visibility === 'approver') return definition.visible === true || definition.visible_for_admins_and_approvers === true;
    return definition.visible === true;
  };
  const balances = explored.items
    .filter(row => visible(byId.get(Number(row.balance_pk))))
    .map(row => {
      const definition = byId.get(Number(row.balance_pk));
      const positive = Number(row.positive_sum ?? 0);
      const negative = Number(row.negative_sum ?? 0);
      return {
        employeeId: row.employee_pk,
        balanceId: row.balance_pk,
        balance: definition?.name,
        unit: definition?.unit,
        positive,
        negative,
        net: Math.round((positive - negative) * 10_000) / 10_000,
        advanceSpent: row.advance_spent,
        advanceRemaining: row.advance_remaining,
      };
    });
  return { from, to, balances };
}

export async function plannedWork(client: IntempusClient, input: { employeeIds?: number[]; from?: string; to?: string }) {
  const from = input.from ?? today();
  const to = input.to ?? addDays(from, 14);
  const query: Record<string, QueryValue> = { start_date__gte: from, start_date__lte: to };
  if (input.employeeIds) {
    if (input.employeeIds.length === 0) return { from, to, planned: [] };
    query.employee__in = input.employeeIds;
  }
  const result = await client.listAll('planned_work_report/', query, 5000);
  return { from, to, truncated: result.truncated, planned: result.items.map(plannedView) };
}

export async function listEmployees(client: IntempusClient, input: { query?: string; activeOnly?: boolean }) {
  const needle = input.query?.trim().toLowerCase();
  const rows = (await listEmployeesCached(client))
    .filter(row => !input.activeOnly || row.active_contract === true)
    .filter(row => !needle || [row.name, row.number, row.username, row.email, row.initial].some(value => String(value ?? '').toLowerCase().includes(needle)));
  return { count: rows.length, employees: rows.map(row => employeeView(row)) };
}

export async function getEmployee(client: IntempusClient, employeeId: number) {
  const row = await client.get<IntempusObject>(`employee/${employeeId}/`);
  const profile = await userProfileOf(client, employeeId);
  return {
    ...employeeView(row, true),
    access: profile
      ? { userProfileId: profile.id, mayLogIntoBackend: profile.may_log_into_backend, mayLogIntoApproval: profile.may_log_into_approval }
      : null,
  };
}

export async function listCustomers(client: IntempusClient, input: { query?: string; includeInactive?: boolean }) {
  const result = await client.listAll('customer/', input.includeInactive ? {} : { active: true }, 10_000);
  const needle = input.query?.trim().toLowerCase();
  const customers = result.items
    .filter(row => !needle || `${String(row.number ?? '')} ${String(row.name ?? '')}`.toLowerCase().includes(needle))
    .map(customerView);
  return { count: customers.length, customers };
}

export async function listResponsibilities(client: IntempusClient) {
  const [levels, forEmployee, forDepartment, forCase, employees] = await Promise.all([
    client.listAll('responsible/'),
    client.listAll('responsible_for_employee/'),
    client.listAll('responsible_for_department/'),
    client.listAll('responsible_for_case/'),
    listEmployeesCached(client),
  ]);
  const names = new Map(employees.map(row => [Number(row.id), `${String(row.name ?? '')} (${String(row.number ?? '')})`]));
  const assignment = (rows: IntempusObject[], field: string) =>
    rows.map(row => ({ id: row.id, responsible: row.responsible, [field]: idFromUri(row[field]) }));
  return {
    approvers: levels.items.map(row => ({
      responsibleId: row.id,
      employeeId: idFromUri(row.employee),
      employee: names.get(idFromUri(row.employee) ?? -1),
      level: row.level,
    })),
    employeeAssignments: assignment(forEmployee.items, 'employee'),
    departmentAssignments: assignment(forDepartment.items, 'department'),
    caseAssignments: assignment(forCase.items, 'case'),
  };
}

export const REFERENCE_KINDS = {
  departments: 'department/',
  employee_groups: 'employee_group/',
  work_models: 'work_model/',
  work_categories: 'work_category/',
  working_hours_agreements: 'working_hours_agreement/',
  case_states: 'case_state/',
  case_groups: 'case_group/',
  customer_groups: 'customer_group/',
  holidays: 'holiday/',
  pay_types: 'pay_type/',
  shifts: 'shift/',
  companies: 'company/',
} as const;

export type ReferenceKind = keyof typeof REFERENCE_KINDS;

export async function listReferenceData(client: IntempusClient, kind: ReferenceKind) {
  const result = await client.listAll(REFERENCE_KINDS[kind], {}, 5000);
  return { kind, count: result.items.length, truncated: result.truncated, items: result.items };
}

/** Resources intempus_get_resource may read (GET only). Credentials-bearing ones are excluded. */
export const READABLE_RESOURCES = new Set([
  'average_weekly_working_time', 'balance', 'case', 'case_group', 'case_state', 'company', 'contract', 'customer',
  'customer_group', 'daily_rest_violation', 'department', 'employee', 'employee_case_rules', 'employee_department_case_rules',
  'employee_group', 'employee_work_type_rule', 'expense', 'explored_employee_balance', 'historical_work_report', 'holiday',
  'holiday_group', 'holiday_rule', 'holiday_year_balance', 'holiday_year_balance_work_type', 'incident',
  'missing_report_anomaly', 'pay_type', 'planned_work_report', 'planner_configuration', 'planner_template', 'priority',
  'product', 'product_group', 'responsible', 'responsible_for_case', 'responsible_for_department',
  'responsible_for_employee', 'schedule', 'shift', 'standard_hours', 'userprofile', 'webhook_configuration',
  'webhook_event_type', 'work_category', 'work_model', 'work_report', 'work_type', 'work_type_balance',
  'work_type_case_rules', 'work_type_rate', 'working_hours_agreement',
]);

// --------------------------------------------------------------- writes

export interface TimeInput {
  date: string;
  endDate?: string;
  caseId?: number;
  workTypeId: number;
  startTime?: string;
  endTime?: string;
  hours?: number;
  breakHours?: number;
  remarks?: string;
  additionalRemarks?: string;
  idempotencyKey?: string;
}

export interface TimeTarget {
  employeeId: number;
  contracts: ContractSummary[];
  /** Check up front that the work type belongs to the contract's work model (Intempus enforces it too: "Kontrakt og arbejdstype skal tilhøre samme arbejdsmodel"). */
  strictWorkModel: boolean;
  actingAs: string;
}

/**
 * Validate and create one work report. Checks what Intempus would reject
 * with an opaque error — a contract covering the date, a work type from
 * the employee's work model, an open case — and derives `amount` from
 * the times when hours are not given. `creation_id` makes retries safe.
 */
export async function createTime(client: IntempusClient, target: TimeTarget, input: TimeInput) {
  assertWritesEnabled('create work report');
  const body = await buildTimeBody(client, target, input);
  const creationId = uuidV5(`${target.actingAs}|${target.employeeId}|${input.idempotencyKey ?? crypto.randomUUID()}`);
  const employee = await client.get<IntempusObject>(`employee/${target.employeeId}/`);
  const created = await client.post<IntempusObject | null>('work_report/', {
    ...body,
    employee: client.uri('employee', target.employeeId),
    company: employee.company,
    creation_id: creationId,
  });
  return created ? workReportView(created) : { created: true, creationId };
}

export async function updateTime(
  client: IntempusClient,
  target: TimeTarget,
  existing: IntempusObject,
  input: Partial<TimeInput>,
) {
  assertWritesEnabled('update work report');
  const merged: TimeInput = {
    date: input.date ?? String(existing.start_date),
    endDate: input.endDate ?? (existing.end_date as string | undefined),
    caseId: input.caseId ?? idFromUri(existing.case),
    workTypeId: input.workTypeId ?? idFromUri(existing.worktype) ?? 0,
    startTime: input.startTime ?? (input.hours !== undefined ? undefined : (existing.start_time as string | undefined)),
    endTime: input.endTime ?? (input.hours !== undefined ? undefined : (existing.end_time as string | undefined)),
    hours: input.hours ?? (input.startTime || input.endTime ? undefined : Number(existing.amount)),
    breakHours: input.breakHours ?? Number(existing.break_duration ?? 0),
    remarks: input.remarks ?? (existing.remarks as string | undefined),
    additionalRemarks: input.additionalRemarks ?? (existing.additional_remarks as string | undefined),
  };
  const body = await buildTimeBody(client, target, merged);
  const updated = await client.patch<IntempusObject | null>(`work_report/${String(existing.id)}/`, body);
  return updated ? workReportView(updated) : workReportView(await getWorkReport(client, Number(existing.id)));
}

export async function deleteTime(client: IntempusClient, existing: IntempusObject) {
  assertWritesEnabled('delete work report');
  await client.delete(`work_report/${String(existing.id)}/`);
  return { deleted: true, workReport: workReportView(existing) };
}

async function buildTimeBody(client: IntempusClient, target: TimeTarget, input: TimeInput): Promise<Record<string, unknown>> {
  const contract = contractOn(target.contracts, input.date);
  if (!contract) {
    throw new Error(`Employee ${target.employeeId} has no Intempus contract covering ${input.date}; time cannot be registered on that date.`);
  }
  if (contract.lockedDate && input.date <= contract.lockedDate) {
    throw new Error(`The period up to ${contract.lockedDate} is locked on the employee's contract; ${input.date} cannot be changed.`);
  }

  const workType = await client.get<IntempusObject>(`work_type/${input.workTypeId}/`);
  if (workType.active !== true) {
    throw new Error(`Work type ${input.workTypeId} (${String(workType.name)}) is not active.`);
  }
  const workModelId = idFromUri(workType.work_model);
  if (target.strictWorkModel && contract.workModelId !== undefined && workModelId !== contract.workModelId) {
    throw new Error(
      `Work type ${input.workTypeId} (${String(workType.name)}) belongs to work model "${String(workType.work_model__name)}", ` +
        `not the employee's "${contract.workModelName ?? contract.workModelId}". Use intempus_list_work_types to pick a valid one.`,
    );
  }

  // The work_type detail embeds its category; project categories need a case
  // ("Projektarbejde skal være tilknyttet et projekt", verified 2026-09-29).
  const category = workType.work_category as { case_related?: unknown; name?: unknown } | string | null;
  if (input.caseId === undefined && category && typeof category === 'object' && category.case_related === true) {
    throw new Error(`Work type ${input.workTypeId} (${String(workType.name)}) is project work and needs a caseId.`);
  }

  if (input.caseId !== undefined) {
    const kase = await client.get<IntempusObject>(`case/${input.caseId}/`);
    if (kase.active !== true || kase.permit_new_workreports === false) {
      throw new Error(`Case ${input.caseId} (${String(kase.name)}) is closed for new time registrations.`);
    }
  }

  const startTime = input.startTime ? normalizeTime(input.startTime) : undefined;
  const endTime = input.endTime ? normalizeTime(input.endTime) : undefined;
  if ((startTime && !endTime) || (!startTime && endTime)) {
    throw new Error('Give both startTime and endTime, or neither (then hours is required).');
  }
  // Intempus: "Start- og sluttid skal være angivet for denne arbejdstype"
  // for work types with report_interval (verified 2026-09-29).
  if (workType.report_interval === true && !(startTime && endTime)) {
    throw new Error(`Work type ${input.workTypeId} (${String(workType.name)}) requires startTime and endTime, not just hours.`);
  }
  const breakHours = input.breakHours ?? 0;
  const amount = input.hours ?? (startTime && endTime ? Math.max(0, hoursBetween(startTime, endTime) - breakHours) : undefined);
  if (amount === undefined || !Number.isFinite(amount) || amount < 0) {
    throw new Error('Give hours, or startTime and endTime.');
  }
  if (amount > 24) {
    throw new Error(`${amount} hours on one registration is more than a day; split it or check the input.`);
  }

  return {
    worktype: client.uri('work_type', input.workTypeId),
    case: input.caseId === undefined ? null : client.uri('case', input.caseId),
    start_date: input.date,
    end_date: input.endDate ?? input.date,
    start_time: startTime ?? null,
    end_time: endTime ?? null,
    amount,
    break_duration: breakHours,
    remarks: input.remarks ?? '',
    additional_remarks: input.additionalRemarks ?? '',
  };
}

/** Reports that are approved (any level) or locked must not be edited by the employee. */
export function assertEditableBySelf(report: IntempusObject): void {
  if (report.isimmutable === true) {
    throw new Error(`Work report ${String(report.id)} is locked in Intempus and cannot be changed.`);
  }
  const anyApproval =
    report.approved === true ||
    Boolean(report.approved_by_initial) ||
    Boolean(report.approved_by_final) ||
    (Array.isArray(report.approved_by) && (report.approved_by as IntempusObject[]).some(entry => entry?.date));
  if (anyApproval) {
    throw new Error(`Work report ${String(report.id)} is already approved; ask your approver to withdraw the approval first.`);
  }
}

/** The userprofile of an employee (userprofile filters only on id__in, so read all). */
export async function userProfileOf(client: IntempusClient, employeeId: number): Promise<IntempusObject | undefined> {
  const rows = (await client.listAll<IntempusObject>('userprofile/', {}, 10_000)).items;
  return rows.find(row => idFromUri(row.employee) === employeeId);
}

// ------------------------------------------------ admin master data writes

export async function createOrUpdate(
  client: IntempusClient,
  resource: string,
  id: number | undefined,
  body: Record<string, unknown>,
  action: string,
) {
  assertWritesEnabled(action);
  const clean = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
  if (id === undefined) {
    return client.post<IntempusObject | null>(`${resource}/`, clean);
  }
  return client.patch<IntempusObject | null>(`${resource}/${id}/`, clean);
}

export { contractsOf };
