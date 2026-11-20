/**
 * One server, three roles. A user may hold several; the tools offered are
 * the union of the user's roles.
 *
 *  - "employee": self-service, hard-scoped to the requesting user's OWN
 *    Intempus employee. The gateway forwards the verified UPN (X-MCP-User);
 *    the server resolves it to an employee and pins every tool to that id.
 *    The API key is a single admin-level Intempus user, so this scoping is
 *    enforced HERE — employee tools never accept foreign employee ids.
 *
 *  - "approver": a read-only view of the team the user is responsible for
 *    in Intempus (responsible_for_employee / _department / _case): pending
 *    time, balances, planning. Approving stays in Intempus — the public API
 *    cannot approve (verified 2026-09-29: `approved` is read-only and
 *    approved_by_* do not approve).
 *
 *  - "admin": company-wide — employees, contracts, access, responsibility,
 *    time for anyone, cases, customers, balances and planning.
 *    Irreversible changes (deletes, period locks) only via
 *    intempus_prepare_admin_change → intempus_commit_prepared_operation;
 *    the gateway can additionally gate the commit tool with a duty group.
 *
 * Where roles come from (INTEMPUS_PROFILE):
 *  - "roles": per request from X-MCP-Roles, which the gateway derives from
 *    the user's groups in its identity provider. Honored only
 *    together with INTEMPUS_TRUST_FORWARDED_USER=true; none → nothing.
 *  - a fixed role or comma list ("employee", "admin", "employee,approver"):
 *    the same roles for every request (stdio, single-purpose instances).
 *    Default "employee".
 *
 * Writes require INTEMPUS_ENABLE_WRITES=true on top.
 */
import { IntempusToolError } from '../errors.js';
import { currentInstancePolicy } from './call-scope.js';

/*
 * Inside a gateway call (src/intempus/call-scope.ts) none of the variables
 * below is read: writes follow the host's policy.enableWrites (false when the
 * host passes no policy), tools in policy.disabledTools are refused, and
 * refusals are worded for the host. The gateway always runs as the admin role.
 */

export const ROLES = ['employee', 'approver', 'admin'] as const;
export type IntempusRole = (typeof ROLES)[number];

/** True when roles come per request from the gateway (INTEMPUS_PROFILE=roles). */
export function rolesFromGateway(): boolean {
  return process.env.INTEMPUS_PROFILE === 'roles';
}

/** Parse a comma-separated role list, keeping only known roles, in canonical order. */
export function parseRoles(value: string | undefined): IntempusRole[] {
  const wanted = new Set((value ?? '').split(',').map(part => part.trim().toLowerCase()));
  return ROLES.filter(role => wanted.has(role));
}

/** Roles fixed by configuration (when not taken from the gateway). */
export function configuredRoles(): IntempusRole[] {
  if (rolesFromGateway()) return [];
  const roles = parseRoles(process.env.INTEMPUS_PROFILE ?? 'employee');
  return roles.length > 0 ? roles : ['employee'];
}

export function trustForwardedUser(): boolean {
  return process.env.INTEMPUS_TRUST_FORWARDED_USER === 'true';
}

/** Whether write tools may run: the host's policy inside a gateway call, INTEMPUS_ENABLE_WRITES outside one. */
export function writesEnabled(): boolean {
  const hosted = currentInstancePolicy();
  return hosted ? hosted.enableWrites : process.env.INTEMPUS_ENABLE_WRITES === 'true';
}

const HOST_WRITES_OFF = 'Writes are disabled: the embedding host has not enabled writes for this instance.';

/**
 * What an approver with a responsible level but NO responsible_for_*
 * assignments may see: nobody (default, fail-closed) or everyone.
 */
export function approverUnassignedScope(): 'none' | 'all' {
  return process.env.INTEMPUS_APPROVER_UNASSIGNED_SCOPE === 'all' ? 'all' : 'none';
}

export function assertWritesEnabled(action: string): void {
  if (currentInstancePolicy() && !writesEnabled()) {
    throw new IntempusToolError(HOST_WRITES_OFF);
  }
  if (!writesEnabled()) {
    throw new IntempusToolError(
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

const ROLE_TOOLS: Record<IntempusRole, readonly string[]> = {
  employee: SELF_TOOLS,
  approver: APPROVAL_TOOLS,
  admin: ADMIN_ONLY_TOOLS,
};

const ALL_TOOLS = new Set([...COMMON_TOOLS, ...Object.values(ROLE_TOOLS).flat()]);

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

/** Tools available to a user holding `roles` (the union; nothing without a role). */
export function toolNamesFor(roles: readonly IntempusRole[]): Set<string> {
  if (roles.length === 0) return new Set();
  return new Set([...COMMON_TOOLS, ...roles.flatMap(role => ROLE_TOOLS[role])]);
}

export interface IntempusPolicyDecision {
  allowed: boolean;
  reason: string;
}

export function checkToolPolicy(toolName: string, roles: readonly IntempusRole[]): IntempusPolicyDecision {
  const hosted = currentInstancePolicy();
  if (hosted?.disabledTools.has(toolName)) {
    return { allowed: false, reason: `tool is disabled on this instance by the embedding host: ${toolName}` };
  }
  const label = roles.length ? roles.join('+') : 'no role';
  if (!toolNamesFor(roles).has(toolName)) {
    if (ALL_TOOLS.has(toolName)) {
      return { allowed: false, reason: `tool is not available for your roles (${label}): ${toolName}` };
    }
    return { allowed: false, reason: `tool is not allowlisted: ${toolName}` };
  }
  if (WRITE_TOOLS.has(toolName) && hosted && !hosted.enableWrites) {
    return { allowed: false, reason: HOST_WRITES_OFF };
  }
  if (WRITE_TOOLS.has(toolName) && !writesEnabled()) {
    return {
      allowed: false,
      reason: `write tool is disabled on this instance (INTEMPUS_ENABLE_WRITES != true): ${toolName}`,
    };
  }
  return { allowed: true, reason: `allowed for ${label}` };
}
