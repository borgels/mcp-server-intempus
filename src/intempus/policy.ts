/**
 * One image, three profiles — selected by INTEMPUS_PROFILE, each deployed
 * on its own hostname behind its own Entra security group:
 *
 *  - "employee" (default): self-service, hard-scoped to the requesting
 *    user's OWN Intempus employee. The gateway forwards the verified UPN
 *    (X-MCP-User); the server resolves it to an employee and pins every
 *    tool to that id. The API key is a single admin-level Intempus user,
 *    so this scoping is enforced HERE — employee tools never accept
 *    foreign employee ids.
 *
 *  - "approver": the employee tools plus a read-only view of the team the
 *    user is responsible for in Intempus (responsible_for_employee /
 *    _department / _case): pending time, balances, planning. Approving
 *    stays in Intempus — the public API cannot approve (verified
 *    2026-09-29: `approved` is read-only and approved_by_* do not approve).
 *
 *  - "admin": company-wide — employees, contracts, access, responsibility,
 *    time for anyone, cases, customers, balances and planning.
 *    Irreversible changes (deletes, period locks) only via
 *    intempus_prepare_admin_change → intempus_commit_prepared_operation;
 *    the gateway can additionally gate the commit tool with a duty group.
 *
 * Writes in every profile require INTEMPUS_ENABLE_WRITES=true on top.
 */
export type IntempusProfile = 'employee' | 'approver' | 'admin';

export function profile(): IntempusProfile {
  const value = process.env.INTEMPUS_PROFILE;
  return value === 'admin' || value === 'approver' ? value : 'employee';
}

export function trustForwardedUser(): boolean {
  return process.env.INTEMPUS_TRUST_FORWARDED_USER === 'true';
}

export function writesEnabled(): boolean {
  return process.env.INTEMPUS_ENABLE_WRITES === 'true';
}

/**
 * What an approver with a responsible level but NO responsible_for_*
 * assignments may see: nobody (default, fail-closed) or everyone.
 */
export function approverUnassignedScope(): 'none' | 'all' {
  return process.env.INTEMPUS_APPROVER_UNASSIGNED_SCOPE === 'all' ? 'all' : 'none';
}

export function assertWritesEnabled(action: string): void {
  if (!writesEnabled()) {
    throw new Error(
      `Write access is disabled on this Intempus MCP instance (${action}). ` +
        'Set INTEMPUS_ENABLE_WRITES=true in the server environment to allow write tools.',
    );
  }
}

const COMMON_TOOLS = [
  'intempus_search_capabilities',
  'intempus_whoami',
  'intempus_list_cases',
  'intempus_list_work_types',
];

const SELF_TOOLS = [
  'intempus_get_my_profile',
  'intempus_list_my_work_reports',
  'intempus_register_time',
  'intempus_update_my_work_report',
  'intempus_delete_my_work_report',
  'intempus_get_my_balances',
  'intempus_get_my_planning',
];

const APPROVAL_TOOLS = [
  'intempus_list_team',
  'intempus_list_team_work_reports',
  'intempus_get_team_balances',
  'intempus_get_team_planning',
];

const ADMIN_ONLY_TOOLS = [
  'intempus_list_employees',
  'intempus_get_employee',
  'intempus_manage_employee',
  'intempus_manage_contract',
  'intempus_manage_user_access',
  'intempus_list_responsibilities',
  'intempus_manage_responsibility',
  'intempus_list_work_reports',
  'intempus_manage_work_report',
  'intempus_manage_case',
  'intempus_list_customers',
  'intempus_manage_customer',
  'intempus_list_balances',
  'intempus_get_employee_balances',
  'intempus_list_schedules',
  'intempus_manage_schedule',
  'intempus_list_planned_work',
  'intempus_list_reference_data',
  'intempus_get_resource',
  'intempus_prepare_admin_change',
  'intempus_commit_prepared_operation',
];

const PROFILE_TOOLS: Record<IntempusProfile, Set<string>> = {
  employee: new Set([...COMMON_TOOLS, ...SELF_TOOLS]),
  approver: new Set([...COMMON_TOOLS, ...SELF_TOOLS, ...APPROVAL_TOOLS]),
  admin: new Set([...COMMON_TOOLS, ...ADMIN_ONLY_TOOLS]),
};

const ALL_TOOLS = new Set(Object.values(PROFILE_TOOLS).flatMap(tools => [...tools]));

export const WRITE_TOOLS = new Set([
  'intempus_register_time',
  'intempus_update_my_work_report',
  'intempus_delete_my_work_report',
  'intempus_manage_employee',
  'intempus_manage_contract',
  'intempus_manage_user_access',
  'intempus_manage_responsibility',
  'intempus_manage_work_report',
  'intempus_manage_case',
  'intempus_manage_customer',
  'intempus_manage_schedule',
  'intempus_commit_prepared_operation',
]);

export function toolNamesForProfile(current: IntempusProfile = profile()): Set<string> {
  return PROFILE_TOOLS[current];
}

export interface IntempusPolicyDecision {
  allowed: boolean;
  reason: string;
}

export function checkToolPolicy(toolName: string): IntempusPolicyDecision {
  const current = profile();
  if (!PROFILE_TOOLS[current].has(toolName)) {
    if (ALL_TOOLS.has(toolName)) {
      return { allowed: false, reason: `tool is not available in the ${current} profile: ${toolName}` };
    }
    return { allowed: false, reason: `tool is not allowlisted: ${toolName}` };
  }
  if (WRITE_TOOLS.has(toolName) && !writesEnabled()) {
    return {
      allowed: false,
      reason: `write tool is disabled on this instance (INTEMPUS_ENABLE_WRITES != true): ${toolName}`,
    };
  }
  return { allowed: true, reason: `allowed in ${current} profile` };
}
