import { idFromUri, type IntempusClient, type IntempusObject } from './client.js';
import { listEmployeesCached, type ResolvedEmployee } from './identity.js';
import { approverUnassignedScope } from './policy.js';

export type ApproverLevel = 'second_approver' | 'final_approver' | string;

export interface ResponsibleLevel {
  /** Id of the /responsible/ record (an employee holding an approval level). */
  id: number;
  level: ApproverLevel;
}

export interface ScopeSnapshot {
  levels: ResponsibleLevel[];
  all: boolean;
  employeeIds: number[];
  departmentIds: number[];
  caseIds: number[];
  note?: string;
}

/**
 * Approver scope, resolved from Intempus' own responsibility data:
 *
 *   responsible               employee E holds level L (second/final approver)
 *   responsible_for_employee  responsible R covers employee X
 *   responsible_for_department  … covers every employee of department D
 *   responsible_for_case      … covers every report on case C
 *
 * The approver sees time, balances and planning of covered employees/cases only.
 * An approver with a level but no assignments sees nobody unless
 * INTEMPUS_APPROVER_UNASSIGNED_SCOPE=all. Without any level the user is
 * not an approver at all, even on the approver host (fail-closed).
 *
 * The responsibility tables are tiny, so they are read whole and matched
 * in memory: that works whether `responsible` on an assignment points at
 * the /responsible/ record or directly at the approver's /employee/.
 */
export class ApproverScope {
  private snapshot?: Promise<ScopeSnapshot>;

  constructor(
    private readonly client: IntempusClient,
    private readonly me: ResolvedEmployee,
  ) {}

  load(): Promise<ScopeSnapshot> {
    this.snapshot ??= this.resolve();
    return this.snapshot;
  }

  private async resolve(): Promise<ScopeSnapshot> {
    const levelRows = (await this.client.listAll<IntempusObject>('responsible/', { employee: this.me.employeeId })).items
      .filter(row => idFromUri(row.employee) === this.me.employeeId);
    const levels = levelRows.map(row => ({ id: Number(row.id), level: String(row.level ?? '') }));
    if (levels.length === 0) {
      throw new Error(
        `${this.me.name || this.me.number} is not registered as an approver (responsible) in Intempus. ` +
          'An administrator must give the employee a responsible level before approval tools work.',
      );
    }

    const levelIds = new Set(levels.map(level => level.id));
    const mine = (row: IntempusObject): boolean => {
      const raw = row.responsible;
      const ref = raw && typeof raw === 'object' ? (raw as { resource_uri?: unknown }).resource_uri : raw;
      if (typeof ref !== 'string') return false;
      if (ref.includes('/employee/')) return idFromUri(ref) === this.me.employeeId;
      const id = idFromUri(ref);
      return id !== undefined && levelIds.has(id);
    };

    const [forEmployee, forDepartment, forCase] = await Promise.all([
      this.client.listAll<IntempusObject>('responsible_for_employee/'),
      this.client.listAll<IntempusObject>('responsible_for_department/'),
      this.client.listAll<IntempusObject>('responsible_for_case/'),
    ]);

    const employeeIds = new Set(ids(forEmployee.items.filter(mine), 'employee'));
    const departmentIds = ids(forDepartment.items.filter(mine), 'department');
    const caseIds = ids(forCase.items.filter(mine), 'case');

    if (departmentIds.length > 0) {
      const departments = new Set(departmentIds);
      for (const employee of await listEmployeesCached(this.client)) {
        const department = idFromUri(employee.department);
        if (department !== undefined && departments.has(department)) {
          employeeIds.add(Number(employee.id));
        }
      }
    }

    const unassigned = employeeIds.size === 0 && caseIds.length === 0;
    const all = unassigned && approverUnassignedScope() === 'all';
    return {
      levels,
      all,
      employeeIds: [...employeeIds],
      departmentIds,
      caseIds,
      note: unassigned
        ? all
          ? 'No responsible_for_* assignments; INTEMPUS_APPROVER_UNASSIGNED_SCOPE=all grants company-wide approval.'
          : 'No responsible_for_* assignments in Intempus, so no employees are in scope. An administrator can assign employees, departments or cases with intempus_manage_responsibility.'
        : undefined,
    };
  }

  /** Employees whose time this approver may see. */
  async employees(): Promise<IntempusObject[]> {
    const scope = await this.load();
    const rows = await listEmployeesCached(this.client);
    if (scope.all) return rows;
    const allowed = new Set(scope.employeeIds);
    return rows.filter(row => allowed.has(Number(row.id)));
  }

  async coversEmployee(employeeId: number): Promise<boolean> {
    const scope = await this.load();
    return scope.all || scope.employeeIds.includes(employeeId);
  }
}

function ids(rows: IntempusObject[], field: string): number[] {
  return rows.map(row => idFromUri(row[field])).filter((id): id is number => id !== undefined);
}
