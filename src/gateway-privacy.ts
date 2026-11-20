import type { IntempusClient, IntempusObject } from './intempus/client.js';

/**
 * Personal data the embeddable gateway leaves out of its results, whatever
 * role the host gives a caller. A fixed layer, applied to every gateway
 * result after the handler and before redaction (src/gateway.ts). The MCP
 * server is not affected.
 *
 * - Private contact data and identity numbers: fields named like a private
 *   email address, next of kin or emergency contact, a CPR or social security
 *   number or a birth date are removed, at any depth.
 * - Absence reasons: a time registration or planned work with an absence
 *   work type (`vacation_or_leave`) whose name is not on NEUTRAL_ABSENCE_NAMES
 *   is shown with the work type name "Absence", without category and remarks.
 * - Balances per employee: a balance whose name is not on
 *   NEUTRAL_ABSENCE_NAMES is shown as "Absence"; the numbers stay.
 * - Raw resources that hold people's absence or its reasons are not read
 *   through get_resource (RAW_ABSENCE_RESOURCES).
 */

/** The name shown instead of a sensitive absence type or balance. */
export const ABSENCE_NAME = 'Absence';

/**
 * Absence names that say nothing sensitive (no health or private reason).
 * A name is neutral only when, lowercased and with spaces collapsed, it is
 * exactly one of these: "Ferie" is, "Ferie (sygdom)" is not.
 */
export const NEUTRAL_ABSENCE_NAMES: ReadonlySet<string> = new Set([
  'ferie',
  'feriefri',
  'feriefridag',
  'feriefridage',
  'afspadsering',
  'timebank',
  'fridag',
  'fridage',
  'helligdag',
  'helligdage',
  'holiday',
  'holidays',
  'vacation',
  'time off in lieu',
]);

export function isNeutralAbsenceName(name: unknown): boolean {
  return typeof name === 'string' && NEUTRAL_ABSENCE_NAMES.has(name.trim().toLowerCase().replace(/\s+/g, ' '));
}

/** get_resource resources that hold people's absence or its reasons in raw form; refused without a request. */
export const RAW_ABSENCE_RESOURCES: ReadonlySet<string> = new Set([
  'work_report',
  'historical_work_report',
  'explored_employee_balance',
  'holiday_year_balance',
  'holiday_year_balance_work_type',
  'work_type_balance',
  'planned_work_report',
  'incident',
  'missing_report_anomaly',
]);

export const RAW_ABSENCE_REFUSED =
  'This resource is not available through this connection: it holds people’s absence in raw form. Use list_work_reports, get_employee_balances or list_planned_work.';

/**
 * Whether a field name names private contact data or an identity number,
 * however it is written (case, `-`, `_`, spaces and dots do not matter).
 */
export function isPrivateField(name: string): boolean {
  const key = name.toLowerCase().replace(/[-_\s.]/g, '');
  return (
    key === 'personalemail' ||
    key === 'privateemail' ||
    key.startsWith('nextofkin') ||
    key.startsWith('relative') ||
    key.startsWith('emergencycontact') ||
    key.startsWith('pårørende') ||
    key.startsWith('paarorende') ||
    key.startsWith('cpr') ||
    key.startsWith('personnummer') ||
    key.startsWith('socialsecurity') ||
    key === 'ssn' ||
    key.startsWith('birthdate') ||
    key.startsWith('birthday') ||
    key.startsWith('dateofbirth') ||
    key.startsWith('fødselsdato')
  );
}

/** A copy of the data without private fields, at any depth. */
export function withoutPrivateFields(value: unknown, depth = 0): unknown {
  if (depth > 64 || typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map(entry => withoutPrivateFields(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isPrivateField(key))
      .map(([key, entry]) => [key, withoutPrivateFields(entry, depth + 1)]),
  );
}

/** Tools whose results hold time registrations or planned work, and so need the absence work types. */
export const ABSENCE_VIEW_TOOLS: ReadonlySet<string> = new Set([
  'intempus_list_work_reports',
  'intempus_manage_work_report',
  'intempus_list_planned_work',
]);

/**
 * The work types of the company: for each id, whether it is a sensitive
 * absence type (an absence type whose name is not neutral). Read once per
 * call, inactive types included.
 */
export async function sensitiveWorkTypes(client: IntempusClient): Promise<ReadonlyMap<number, boolean>> {
  const rows = (await client.listAll<IntempusObject>('work_type/', {}, 10_000)).items;
  return new Map(
    rows.map(row => [Number(row.id), row.vacation_or_leave === true && !isNeutralAbsenceName(row.name)] as const),
  );
}

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether a work type id is sensitive; an id the company does not have counts as sensitive (fail closed). */
function sensitive(types: ReadonlyMap<number, boolean>, id: unknown): boolean {
  return typeof id !== 'number' || types.get(id) !== false;
}

/** A time registration view (src/intempus/format.ts, workReportView) without a sensitive absence reason. */
function maskWorkReport(row: Row, types: ReadonlyMap<number, boolean>): Row {
  const workType = isRow(row.workType) ? row.workType : undefined;
  if (!workType || !sensitive(types, workType.id)) return row;
  const { category: _category, remarks: _remarks, additionalRemarks: _additional, ...rest } = row;
  return { ...rest, workType: { ...workType, name: ABSENCE_NAME } };
}

/** A planned work view (plannedView) without the remarks of a sensitive absence. */
function maskPlanned(row: Row, types: ReadonlyMap<number, boolean>): Row {
  if (!('workTypeId' in row) || !sensitive(types, row.workTypeId)) return row;
  const { remarks: _remarks, ...rest } = row;
  return rest;
}

/** The result of a tool in ABSENCE_VIEW_TOOLS without sensitive absence reasons. */
export function maskAbsenceViews(tool: string, data: unknown, types: ReadonlyMap<number, boolean>): unknown {
  if (!isRow(data)) return data;
  if (tool === 'intempus_list_work_reports' && Array.isArray(data.workReports)) {
    return { ...data, workReports: data.workReports.map(row => (isRow(row) ? maskWorkReport(row, types) : row)) };
  }
  if (tool === 'intempus_manage_work_report') {
    return maskWorkReport(data, types);
  }
  if (tool === 'intempus_list_planned_work' && Array.isArray(data.planned)) {
    return { ...data, planned: data.planned.map(row => (isRow(row) ? maskPlanned(row, types) : row)) };
  }
  return data;
}

/** get_employee_balances without the names of sensitive balances: those are "Absence", the numbers stay. */
export function maskBalanceNames(data: unknown): unknown {
  if (!isRow(data) || !Array.isArray(data.balances)) return data;
  return {
    ...data,
    balances: data.balances.map(row =>
      isRow(row) && !isNeutralAbsenceName(row.balance) ? { ...row, balance: ABSENCE_NAME } : row,
    ),
  };
}
