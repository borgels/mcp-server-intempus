import { createHash } from 'node:crypto';
import { idFromUri, type IntempusObject } from './client.js';
import { contractsOf } from './identity.js';

/**
 * Compact projections of Intempus objects. Raw tastypie rows carry ~60
 * fields (GPS, route data, UI flags); tools return what a person or an
 * agent acts on, keeping ids for follow-up calls.
 */

export function workReportView(row: IntempusObject) {
  const approvals = Array.isArray(row.approved_by) ? (row.approved_by as IntempusObject[]) : [];
  return {
    id: row.id,
    employee: { id: idFromUri(row.employee), number: row.employee_number, name: row.employee_name },
    case: row.case ? { id: idFromUri(row.case), name: row.case_name } : null,
    workType: { id: idFromUri(row.worktype), name: row.worktype_name, unit: row.work_type_unit },
    category: row.work_category_name,
    startDate: row.start_date,
    endDate: row.end_date,
    startTime: row.start_time,
    endTime: row.end_time,
    amount: toNumber(row.amount),
    breakHours: toNumber(row.break_duration),
    remarks: row.remarks || undefined,
    additionalRemarks: row.additional_remarks || undefined,
    approved: row.approved === true,
    approvals: approvals
      .filter(entry => entry && (entry.date || entry.username || entry.name))
      .map(entry => ({ level: entry.level, label: entry.label, by: entry.name ?? entry.username, date: entry.date, time: entry.time })),
    pendingLevels: approvals.filter(entry => entry && !entry.date).map(entry => entry.level),
    locked: row.isimmutable === true,
    origin: row.origin,
    createdAt: row.creation_datetime,
  };
}

export function employeeView(row: IntempusObject, full = false) {
  const levels = Array.isArray(row.responsible_levels) ? (row.responsible_levels as IntempusObject[]) : [];
  const base = {
    id: row.id,
    number: row.number,
    name: row.name,
    initial: row.initial || undefined,
    username: row.username || undefined,
    email: row.email || undefined,
    departmentId: idFromUri(row.department),
    department: row.department__name ?? undefined,
    employeeGroupId: idFromUri(row.employee_group),
    activeContract: row.active_contract === true,
    approverLevels: levels.map(level => ({ id: level.id, level: level.level })),
  };
  if (!full) return base;
  return {
    ...base,
    phone: row.phone || undefined,
    personalEmail: row.personal_email || undefined,
    address: [row.street_address, row.zip_code, row.city, row.country].filter(Boolean).join(', ') || undefined,
    seniorityDate: row.seniority_date,
    subscribeDate: row.subscribe_date,
    unsubscribeDate: row.unsubscribe_date,
    mayCreateCustomersAndCases: row.may_CUD_customers_and_cases,
    mayAddWorkReportsToAllCases: row.may_add_work_reports_to_all_cases,
    contracts: contractsOf(row),
  };
}

export function caseView(row: IntempusObject) {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    customer: row.customer ? { id: idFromUri(row.customer), name: row.customer_name } : null,
    active: row.active === true,
    permitNewWorkReports: row.permit_new_workreports === true,
    allEmployeesMayReport: row.all_employees_may_add_work_reports,
    startDate: row.start_date,
    endDate: row.end_date,
    hourBudget: toNumber(row.hour_budget),
    responsible: row.responsible ? { id: idFromUri(row.responsible), name: row.responsible_name } : null,
    parent: row.parent ? { id: idFromUri(row.parent), name: row.parent_name } : null,
    department: row.department_name ?? undefined,
    state: row.case_state_name ?? undefined,
    address: [row.street_address, row.zip_code, row.city].filter(Boolean).join(', ') || undefined,
  };
}

export function workTypeView(row: IntempusObject) {
  return {
    id: row.id,
    number: row.number || undefined,
    name: row.name,
    active: row.active === true,
    inputType: row.input_type,
    workModel: { id: idFromUri(row.work_model), name: row.work_model__name },
    workCategoryId: idFromUri(row.work_category),
    vacationOrLeave: row.vacation_or_leave === true,
    reportInterval: row.report_interval,
    dateInterval: row.date_interval,
  };
}

export function customerView(row: IntempusObject) {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    active: row.active,
    vatNumber: row.vat_registration_number || undefined,
    address: [row.street_address, row.zip_code, row.city].filter(Boolean).join(', ') || undefined,
    email: row.email || undefined,
    phone: row.phone || undefined,
  };
}

export function plannedView(row: IntempusObject) {
  return {
    id: row.id,
    employeeId: idFromUri(row.employee),
    caseId: idFromUri(row.case),
    workTypeId: idFromUri(row.worktype),
    date: row.start_date,
    startTime: row.start_time,
    endTime: row.end_time,
    amount: toNumber(row.amount),
    remarks: row.remarks || undefined,
    draft: row.is_draft === true,
    scheduleId: idFromUri(row.schedule),
  };
}

/** Strip credentials and noise from a raw row before returning it. */
export function sanitizeRaw(row: IntempusObject): IntempusObject {
  const { password, current_password, pin, password_generation, ...rest } = row as Record<string, unknown>;
  void password;
  void current_password;
  void pin;
  void password_generation;
  return rest as IntempusObject;
}

export function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 10_000) / 10_000 : undefined;
}

/** Today's date in Denmark (YYYY-MM-DD). */
export function today(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Copenhagen' }).format(new Date());
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** "7:30" / "07:30" / "07:30:00" → "07:30:00". */
export function normalizeTime(value: string): string {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid time "${value}"; use HH:MM.`);
  const [hours, minutes, seconds] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  if (hours > 23 || minutes > 59 || seconds > 59) throw new Error(`Invalid time "${value}".`);
  return [hours, minutes, seconds].map(part => String(part).padStart(2, '0')).join(':');
}

/** Hours between two HH:MM:SS times; an end before start wraps past midnight. */
export function hoursBetween(start: string, end: string): number {
  const toMinutes = (time: string) => {
    const [h, m, s] = time.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0) + (s ?? 0) / 60;
  };
  let minutes = toMinutes(end) - toMinutes(start);
  if (minutes <= 0) minutes += 24 * 60;
  return Math.round((minutes / 60) * 10_000) / 10_000;
}

const CREATION_NAMESPACE = '6f1d0c1e-2b8a-5d39-9c43-8f5b8e0a7c21';

/**
 * RFC 4122 v5 UUID for Intempus' `creation_id`, which it de-duplicates on
 * (a retried create returns the existing row instead of a duplicate).
 */
export function uuidV5(name: string, namespace = CREATION_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
