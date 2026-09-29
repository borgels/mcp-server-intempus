export type CapabilityRisk = 'read' | 'write';

export interface IntempusCapability {
  id: string;
  title: string;
  description: string;
  risk: CapabilityRisk;
  examples: unknown[];
  identifierFormats: string[];
  safetyNotes: string[];
  keywords: string[];
}

export const READ_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export const DESTRUCTIVE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const SELF_NOTE = 'Scoped to YOUR OWN Intempus employee — the server resolves you from the gateway identity and pins every call to your employee id.';
const SCOPE_NOTE = 'Scoped to the employees/cases you are responsible for in Intempus (responsible_for_employee/_department/_case).';
const WRITE_NOTE = 'Requires INTEMPUS_ENABLE_WRITES=true on the instance.';
const ADMIN_NOTE = 'Admin profile: company-wide. Every call is audited with your Entra identity (Intempus itself records the API user).';
const DATE = 'Dates as YYYY-MM-DD, times as HH:MM';

export const INTEMPUS_CAPABILITIES: IntempusCapability[] = [
  {
    id: 'intempus_search_capabilities',
    title: 'Search Intempus Capabilities',
    description: 'Find the Intempus MCP tool for time registration, approval, balances, cases, employees or planning.',
    risk: 'read',
    examples: [{ query: 'registrer timer' }, { query: 'godkend' }],
    identifierFormats: ['Tool id such as intempus_register_time.'],
    safetyNotes: ['Discovery only.'],
    keywords: ['discover', 'help', 'hjælp', 'capabilities'],
  },
  {
    id: 'intempus_whoami',
    title: 'Who Am I (Intempus)',
    description: 'Show the profile of this endpoint and which Intempus employee (and approver levels) this session is bound to.',
    risk: 'read',
    examples: [{}],
    identifierFormats: [],
    safetyNotes: [SELF_NOTE],
    keywords: ['me', 'identity', 'hvem', 'mig', 'profil'],
  },
  {
    id: 'intempus_list_cases',
    title: 'List Cases (Intempus)',
    description: 'Search cases/projects (sager) that accept time, by number, name or customer.',
    risk: 'read',
    examples: [{ query: 'Skovvej' }],
    identifierFormats: ['caseId is the numeric Intempus case id'],
    safetyNotes: ['Only active cases open for new registrations unless includeInactive (admin).'],
    keywords: ['sag', 'sager', 'projekt', 'projekter', 'case', 'project', 'kunde'],
  },
  {
    id: 'intempus_list_work_types',
    title: 'List Work Types (Intempus)',
    description: 'Work types (arbejdstyper: projekttimer, ferie, sygdom, kørsel …). Employees see the types of their own work model.',
    risk: 'read',
    examples: [{}, { query: 'ferie' }],
    identifierFormats: ['workTypeId is the numeric Intempus work type id'],
    safetyNotes: [],
    keywords: ['arbejdstype', 'løntype', 'work type', 'ferie', 'sygdom', 'fravær', 'kørsel', 'timer'],
  },
  {
    id: 'intempus_get_my_profile',
    title: 'My Profile (Intempus)',
    description: 'Your Intempus employee record, contracts (work model, locked date) and approver levels.',
    risk: 'read',
    examples: [{}],
    identifierFormats: [],
    safetyNotes: [SELF_NOTE],
    keywords: ['profil', 'kontrakt', 'arbejdsmodel', 'stamdata', 'profile', 'contract'],
  },
  {
    id: 'intempus_list_my_work_reports',
    title: 'My Time Registrations (Intempus)',
    description: 'Your time registrations (work reports) in a period, with approval status and total hours.',
    risk: 'read',
    examples: [{ from: '2026-09-01', to: '2026-09-30' }],
    identifierFormats: [DATE],
    safetyNotes: [SELF_NOTE, 'Default period is the last 31 days.'],
    keywords: ['mine timer', 'registreringer', 'tidsregistrering', 'timesedler', 'work reports', 'timesheet'],
  },
  {
    id: 'intempus_register_time',
    title: 'Register Time (Intempus)',
    description: 'Register time for yourself: a work type, optional case, a date and either start/end time or hours.',
    risk: 'write',
    examples: [
      { date: '2026-09-29', caseId: 2001, workTypeId: 3001, startTime: '07:00', endTime: '15:00', breakHours: 0.5 },
      { date: '2026-09-29', workTypeId: 3001, hours: 7.5, remarks: 'Opmåling' },
    ],
    identifierFormats: [DATE, 'caseId from intempus_list_cases; workTypeId from intempus_list_work_types'],
    safetyNotes: [SELF_NOTE, WRITE_NOTE, 'Checks contract, work model and case before creating; pass idempotencyKey to make retries safe.'],
    keywords: ['registrer', 'registrere tid', 'timer', 'tid', 'log time', 'time entry', 'stemple'],
  },
  {
    id: 'intempus_update_my_work_report',
    title: 'Edit My Time Registration (Intempus)',
    description: 'Change one of your own registrations — only while it is neither approved nor locked.',
    risk: 'write',
    examples: [{ workReportId: 4001, endTime: '15:30' }],
    identifierFormats: ['workReportId from intempus_list_my_work_reports'],
    safetyNotes: [SELF_NOTE, WRITE_NOTE],
    keywords: ['ret', 'rette', 'ændre', 'edit', 'update', 'timer'],
  },
  {
    id: 'intempus_delete_my_work_report',
    title: 'Delete My Time Registration (Intempus)',
    description: 'Delete one of your own registrations — only while it is neither approved nor locked.',
    risk: 'write',
    examples: [{ workReportId: 4001 }],
    identifierFormats: ['workReportId from intempus_list_my_work_reports'],
    safetyNotes: [SELF_NOTE, WRITE_NOTE],
    keywords: ['slet', 'fjern', 'delete', 'timer'],
  },
  {
    id: 'intempus_get_my_balances',
    title: 'My Balances (Intempus)',
    description: 'Your balances (saldi): ferie, feriefri, timebank/flex, sygdom … as computed by Intempus. Only balances visible to employees.',
    risk: 'read',
    examples: [{}, { to: '2026-12-31' }],
    identifierFormats: [DATE],
    safetyNotes: [SELF_NOTE],
    keywords: ['saldo', 'saldi', 'ferie', 'feriefri', 'flex', 'timebank', 'overtid', 'restferie', 'balance'],
  },
  {
    id: 'intempus_get_my_planning',
    title: 'My Planning (Intempus)',
    description: 'Your planned work (vagtplan/planlægning) in a period.',
    risk: 'read',
    examples: [{ from: '2026-10-01', to: '2026-10-14' }],
    identifierFormats: [DATE],
    safetyNotes: [SELF_NOTE, 'Default period is the next 14 days.'],
    keywords: ['planlægning', 'plan', 'vagtplan', 'vagter', 'planning', 'schedule'],
  },
  {
    id: 'intempus_list_team',
    title: 'My Team (Intempus, approver)',
    description: 'The employees you are responsible for (whose time you approve), and your approver levels.',
    risk: 'read',
    examples: [{}],
    identifierFormats: [],
    safetyNotes: [SCOPE_NOTE],
    keywords: ['team', 'medarbejdere', 'ansvarlig', 'godkender', 'hold'],
  },
  {
    id: 'intempus_list_team_work_reports',
    title: 'Team Time Registrations (Intempus, approver)',
    description: 'Time registrations of your team in a period — e.g. those awaiting approval. Approve them in Intempus itself; the public API cannot approve.',
    risk: 'read',
    examples: [{ status: 'pending' }, { employeeId: 1001, from: '2026-09-01' }],
    identifierFormats: [DATE, 'status: pending | approved | all'],
    safetyNotes: [SCOPE_NOTE],
    keywords: ['godkend', 'godkendelse', 'afventer', 'mangler godkendelse', 'team timer', 'pending', 'approval', 'approve'],
  },
  {
    id: 'intempus_get_team_balances',
    title: 'Team Balances (Intempus, approver)',
    description: 'Balances (saldi) of your team members.',
    risk: 'read',
    examples: [{}, { employeeId: 1001 }],
    identifierFormats: [DATE],
    safetyNotes: [SCOPE_NOTE],
    keywords: ['saldo', 'saldi', 'team', 'ferie', 'flex', 'timebank'],
  },
  {
    id: 'intempus_get_team_planning',
    title: 'Team Planning (Intempus, approver)',
    description: 'Planned work of your team in a period.',
    risk: 'read',
    examples: [{ from: '2026-10-01', to: '2026-10-14' }],
    identifierFormats: [DATE],
    safetyNotes: [SCOPE_NOTE],
    keywords: ['planlægning', 'team', 'vagtplan', 'planning'],
  },
  {
    id: 'intempus_list_employees',
    title: 'List Employees (Intempus, admin)',
    description: 'Search all employees by name, number, username or email.',
    risk: 'read',
    examples: [{ query: 'jensen' }],
    identifierFormats: ['employeeId is the numeric Intempus employee id'],
    safetyNotes: [ADMIN_NOTE],
    keywords: ['medarbejdere', 'ansatte', 'employees', 'personale'],
  },
  {
    id: 'intempus_get_employee',
    title: 'Get Employee (Intempus, admin)',
    description: 'One employee with contracts, approver levels and login access (backend/approval app).',
    risk: 'read',
    examples: [{ employeeId: 1001 }],
    identifierFormats: ['employeeId'],
    safetyNotes: [ADMIN_NOTE],
    keywords: ['medarbejder', 'employee', 'kontrakt', 'adgang'],
  },
  {
    id: 'intempus_manage_employee',
    title: 'Create/Update/Offboard Employee (Intempus, admin)',
    description: 'Create an employee, update master data, or offboard (end open contracts, revoke logins) — offboarding is how an employee is removed; Intempus does not allow deleting employees.',
    risk: 'write',
    examples: [
      { action: 'create', name: 'Jane Jensen', number: '1003', username: 'jane@example.com', email: 'jane@example.com' },
      { action: 'offboard', employeeId: 1001, date: '2026-10-31' },
    ],
    identifierFormats: ['action: create | update | offboard'],
    safetyNotes: [ADMIN_NOTE, WRITE_NOTE, 'Set username or email to the Entra sign-in address so self-service can resolve the employee.'],
    keywords: ['opret medarbejder', 'ny medarbejder', 'ret medarbejder', 'fratræd', 'fjern medarbejder', 'slet medarbejder', 'offboard', 'onboard', 'employee'],
  },
  {
    id: 'intempus_manage_contract',
    title: 'Create/Update Contract (Intempus, admin)',
    description: 'Employment contract: work model (fastansat/vikar …), working-hours agreement, start/end date. Time can only be registered within a contract.',
    risk: 'write',
    examples: [{ action: 'create', employeeId: 1001, workModelId: 8001, startDate: '2026-10-01' }],
    identifierFormats: ['workModelId from intempus_list_reference_data kind=work_models'],
    safetyNotes: [ADMIN_NOTE, WRITE_NOTE, 'Changing locked_date is intempus_prepare_admin_change.'],
    keywords: ['kontrakt', 'arbejdsmodel', 'ansættelse', 'contract', 'work model'],
  },
  {
    id: 'intempus_manage_user_access',
    title: 'Set Login Access (Intempus, admin)',
    description: 'Allow or revoke an employee\'s login to the Intempus backend and the approval app.',
    risk: 'write',
    examples: [{ employeeId: 1001, mayLogIntoApproval: true }],
    identifierFormats: ['employeeId'],
    safetyNotes: [ADMIN_NOTE, WRITE_NOTE],
    keywords: ['adgang', 'login', 'backend', 'godkendelsesapp', 'rettigheder', 'access'],
  },
  {
    id: 'intempus_list_responsibilities',
    title: 'List Approvers & Responsibilities (Intempus, admin)',
    description: 'Who is second/final approver, and which employees, departments and cases each is responsible for.',
    risk: 'read',
    examples: [{}],
    identifierFormats: [],
    safetyNotes: [ADMIN_NOTE],
    keywords: ['godkendere', 'ansvarlige', 'ansvar', 'approvers', 'responsible'],
  },
  {
    id: 'intempus_manage_responsibility',
    title: 'Manage Approvers & Responsibilities (Intempus, admin)',
    description: 'Give/remove an approver level, and assign/unassign the employees, departments or cases an approver covers. This is what scopes the approver endpoint.',
    risk: 'write',
    examples: [
      { action: 'add_level', employeeId: 1002, level: 'final_approver' },
      { action: 'assign', responsibleId: 7001, targetType: 'employee', targetId: 1001 },
    ],
    identifierFormats: ['action: add_level | remove_level | assign | unassign; targetType: employee | department | case'],
    safetyNotes: [ADMIN_NOTE, WRITE_NOTE],
    keywords: ['godkender', 'ansvarlig', 'tildel', 'approver', 'responsible', 'scope'],
  },
  {
    id: 'intempus_list_work_reports',
    title: 'List Work Reports (Intempus, admin)',
    description: 'Time registrations of anyone, filtered by period, employee, case and approval.',
    risk: 'read',
    examples: [{ caseId: 2001, from: '2026-09-01' }, { approved: false }],
    identifierFormats: [DATE],
    safetyNotes: [ADMIN_NOTE],
    keywords: ['timer', 'registreringer', 'work reports', 'sagstimer', 'rapport'],
  },
  {
    id: 'intempus_manage_work_report',
    title: 'Create/Update/Delete Work Report (Intempus, admin)',
    description: 'Register, correct or delete time on behalf of any employee.',
    risk: 'write',
    examples: [{ action: 'create', employeeId: 1001, date: '2026-09-29', workTypeId: 3001, hours: 7.5 }],
    identifierFormats: ['action: create | update | delete'],
    safetyNotes: [ADMIN_NOTE, WRITE_NOTE, 'Contract, locked date, work type and case are checked like self-service.'],
    keywords: ['registrer for', 'ret timer', 'slet timer', 'på vegne af', 'on behalf'],
  },
  {
    id: 'intempus_manage_case',
    title: 'Create/Update Case (Intempus, admin)',
    description: 'Create or update a case/project: name, number, customer, open/closed, budget, responsible. Same naming as bpc ("<projektnr> - <navn>") when projectNumber is given.',
    risk: 'write',
    examples: [{ action: 'create', projectNumber: '2640', name: 'Skovvej 3', customerId: 5001 }],
    identifierFormats: ['action: create | update'],
    safetyNotes: [ADMIN_NOTE, WRITE_NOTE, 'Refuses a create when a case with the same number or name already exists.'],
    keywords: ['opret sag', 'ny sag', 'luk sag', 'projekt', 'case'],
  },
  {
    id: 'intempus_list_customers',
    title: 'List Customers (Intempus, admin)',
    description: 'Search customers.',
    risk: 'read',
    examples: [{ query: 'ApS' }],
    identifierFormats: [],
    safetyNotes: [ADMIN_NOTE],
    keywords: ['kunder', 'kunde', 'customers'],
  },
  {
    id: 'intempus_manage_customer',
    title: 'Create/Update Customer (Intempus, admin)',
    description: 'Create or update a customer.',
    risk: 'write',
    examples: [{ action: 'create', name: 'Eksempel Byg ApS', number: '12' }],
    identifierFormats: ['action: create | update'],
    safetyNotes: [ADMIN_NOTE, WRITE_NOTE],
    keywords: ['opret kunde', 'kunde', 'customer'],
  },
  {
    id: 'intempus_list_balances',
    title: 'List Balance Definitions (Intempus, admin)',
    description: 'The balance definitions (ferie 2026-2027, timebank, sygdom …) with unit and visibility.',
    risk: 'read',
    examples: [{}],
    identifierFormats: [],
    safetyNotes: [ADMIN_NOTE],
    keywords: ['saldi', 'saldotyper', 'balance', 'ferieår'],
  },
  {
    id: 'intempus_get_employee_balances',
    title: 'Employee Balances (Intempus, admin)',
    description: 'Balances of one, several or all employees over a period.',
    risk: 'read',
    examples: [{ employeeIds: [1001] }, {}],
    identifierFormats: [DATE],
    safetyNotes: [ADMIN_NOTE],
    keywords: ['saldo', 'saldi', 'ferie', 'flex', 'timebank', 'overtid'],
  },
  {
    id: 'intempus_list_schedules',
    title: 'List Schedules (Intempus, admin)',
    description: 'Planning schedules (recurring or one-off plans that generate planned work).',
    risk: 'read',
    examples: [{ from: '2026-10-01' }],
    identifierFormats: [DATE],
    safetyNotes: [ADMIN_NOTE],
    keywords: ['planlægning', 'skema', 'vagtplan', 'schedule'],
  },
  {
    id: 'intempus_manage_schedule',
    title: 'Create/Update/Delete Schedule (Intempus, admin)',
    description: 'Plan work for employees on a case: dates, times, weekdays, recurrence.',
    risk: 'write',
    examples: [{ action: 'create', employeeIds: [1001], caseId: 2001, startDate: '2026-10-05', endDate: '2026-10-09', startTime: '07:00', endTime: '15:00' }],
    identifierFormats: ['action: create | update | delete'],
    safetyNotes: [ADMIN_NOTE, WRITE_NOTE],
    keywords: ['planlæg', 'planlægning', 'vagt', 'bemanding', 'schedule', 'plan'],
  },
  {
    id: 'intempus_list_planned_work',
    title: 'List Planned Work (Intempus, admin)',
    description: 'Planned work (materialised plan lines) for anyone in a period.',
    risk: 'read',
    examples: [{ from: '2026-10-01', to: '2026-10-31' }],
    identifierFormats: [DATE],
    safetyNotes: [ADMIN_NOTE],
    keywords: ['planlagt', 'planlægning', 'kapacitet', 'planned'],
  },
  {
    id: 'intempus_list_reference_data',
    title: 'Reference Data (Intempus, admin)',
    description: 'Departments, employee groups, work models, work categories, working-hours agreements, case states/groups, holidays, pay types, shifts, company.',
    risk: 'read',
    examples: [{ kind: 'work_models' }],
    identifierFormats: ['kind'],
    safetyNotes: [ADMIN_NOTE],
    keywords: ['afdelinger', 'arbejdsmodeller', 'overenskomst', 'løntyper', 'helligdage', 'reference'],
  },
  {
    id: 'intempus_get_resource',
    title: 'Read Any Resource (Intempus, admin)',
    description: 'Generic read-only access to allowlisted Intempus resources not covered by a dedicated tool (history, rules, anomalies, webhooks …).',
    risk: 'read',
    examples: [{ resource: 'historical_work_report', filters: { id__in: '4001' } }],
    identifierFormats: ['resource name as in the Intempus API; filters use tastypie syntax (field__gte …)'],
    safetyNotes: [ADMIN_NOTE, 'GET only. Credential-bearing resources (api_key, outlook_credential) are not readable.'],
    keywords: ['rå', 'generisk', 'historik', 'raw', 'resource', 'api'],
  },
  {
    id: 'intempus_prepare_admin_change',
    title: 'Prepare Irreversible Change (Intempus, admin)',
    description: 'Step 1 of 2 for deletes (case, customer, contract, work reports, schedule, planned work, balance), moving a contract\'s locked date (period lock), and locking/unlocking work reports (needs the Intempus "work report state" feature). Returns a signed preview; nothing is changed.',
    risk: 'read',
    examples: [
      { change: { kind: 'set_contract_locked_date', contractIds: [6001], lockedDate: '2026-09-30' }, reason: 'Lønperiode september lukket' },
      { change: { kind: 'delete', resource: 'case', ids: [2002] }, reason: 'Oprettet ved fejl' },
    ],
    identifierFormats: ['change.kind: delete | lock_work_reports | set_contract_locked_date'],
    safetyNotes: [ADMIN_NOTE, 'Read-only. The preview names every affected record; expires after 15 minutes.'],
    keywords: ['slet', 'lås', 'lås periode', 'lønperiode', 'periodelås', 'delete', 'lock'],
  },
  {
    id: 'intempus_commit_prepared_operation',
    title: 'Commit Prepared Change (Intempus, admin)',
    description: 'Step 2 of 2: carry out an operation from intempus_prepare_admin_change. May require an extra duty group at the gateway.',
    risk: 'write',
    examples: [{ operation: '<from prepare>', confirmOperationHash: '<operationHash>' }],
    identifierFormats: ['operation exactly as returned by prepare; confirmOperationHash = its operationHash'],
    safetyNotes: [ADMIN_NOTE, WRITE_NOTE, 'Irreversible. Only operations signed by this server, prepared by you, within 15 minutes.'],
    keywords: ['bekræft', 'udfør', 'commit', 'confirm'],
  },
];

export function searchCapabilities(query: string, limit = 20, available?: Set<string>): IntempusCapability[] {
  const pool = available
    ? INTEMPUS_CAPABILITIES.filter(capability => available.has(capability.id))
    : INTEMPUS_CAPABILITIES;
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return pool.slice(0, limit);
  }
  return pool
    .map(capability => ({ capability, score: scoreCapability(capability, normalized) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.capability.id.localeCompare(b.capability.id))
    .slice(0, limit)
    .map(item => item.capability);
}

function scoreCapability(capability: IntempusCapability, query: string): number {
  const haystack = [
    capability.id,
    capability.title,
    capability.description,
    ...capability.identifierFormats,
    ...capability.keywords,
  ]
    .join(' ')
    .toLowerCase();
  return query
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}
