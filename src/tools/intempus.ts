import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { formatUnknownError } from '../errors.js';
import { writeAuditEvent } from '../intempus/audit.js';
import {
  DESTRUCTIVE_TOOL_ANNOTATIONS,
  READ_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  searchCapabilities,
} from '../intempus/capabilities.js';
import { idFromUri, type IntempusClient, type IntempusObject, type QueryValue } from '../intempus/client.js';
import { caseView, customerView, employeeView, normalizeTime, sanitizeRaw, today, workReportView } from '../intempus/format.js';
import {
  clearEmployeeCache,
  contractOn,
  contractsOf,
  listEmployeesCached,
  resolveEmployee,
  type ResolvedEmployee,
} from '../intempus/identity.js';
import {
  commitPreparedOperation,
  DELETABLE_RESOURCES,
  prepareAdminChange,
  verifyPreparedOperation,
  type PreparedOperation,
} from '../intempus/operations.js';
import { assertWritesEnabled, checkToolPolicy, configuredRoles, toolNamesFor, type IntempusRole } from '../intempus/policy.js';
import {
  assertEditableBySelf,
  createOrUpdate,
  createTime,
  deleteTime,
  employeeBalances,
  getEmployee,
  getWorkReport,
  listBalanceDefinitions,
  listCases,
  listCustomers,
  listEmployees,
  listReferenceData,
  listResponsibilities,
  listWorkReports,
  listWorkTypes,
  plannedWork,
  READABLE_RESOURCES,
  REFERENCE_KINDS,
  updateTime,
  userProfileOf,
  type ReferenceKind,
  type TimeTarget,
} from '../intempus/resources.js';
import { ApproverScope } from '../intempus/scope.js';

export interface RegisterOptions {
  /** Gateway-verified UPN of the requesting user. */
  onBehalfOf?: string;
  /** The user's roles (from X-MCP-Roles via the gateway); defaults to the configured roles. */
  roles?: readonly IntempusRole[];
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const timeSchema = z.string().trim().regex(/^\d{1,2}:\d{2}(:\d{2})?$/, 'HH:MM');
const idSchema = z.number().int().positive();
const levelSchema = z.enum(['second_approver', 'final_approver']);
const periodShape = { from: dateSchema.optional(), to: dateSchema.optional() };

const timeFields = {
  date: dateSchema.describe('Work date (start date).'),
  endDate: dateSchema.optional().describe('Only for registrations spanning several days (e.g. holiday).'),
  caseId: idSchema.optional().describe('Case/project id from intempus_list_cases. Omit for time without a case (e.g. absence).'),
  workTypeId: idSchema.describe('Work type id from intempus_list_work_types.'),
  startTime: timeSchema.optional(),
  endTime: timeSchema.optional(),
  hours: z.number().min(0).max(24).optional().describe('Amount in the work type unit (hours for time). Derived from start/end minus break when omitted.'),
  breakHours: z.number().min(0).max(12).optional(),
  remarks: z.string().trim().max(2000).optional(),
  additionalRemarks: z.string().trim().max(2000).optional(),
};

export function registerIntempusTools(server: McpServer, client: IntempusClient, options: RegisterOptions = {}): void {
  const roles = options.roles ?? configuredRoles();
  const available = toolNamesFor(roles);
  const isAdmin = roles.includes('admin');
  const isApprover = roles.includes('approver');
  const actingAs = options.onBehalfOf ?? '(no forwarded identity)';

  let selfPromise: Promise<ResolvedEmployee> | undefined;
  const self = (): Promise<ResolvedEmployee> => {
    if (!options.onBehalfOf) {
      return Promise.reject(
        new Error('No requesting user identity available. This tool requires the gateway to forward the verified user (X-MCP-User).'),
      );
    }
    selfPromise ??= resolveEmployee(client, options.onBehalfOf);
    return selfPromise;
  };

  let scopePromise: Promise<ApproverScope> | undefined;
  const scope = (): Promise<ApproverScope> => {
    scopePromise ??= self().then(me => new ApproverScope(client, me));
    return scopePromise;
  };

  const register: typeof server.registerTool = (name, config, handler) => {
    if (!available.has(name)) {
      return undefined as never;
    }
    return server.registerTool(name, config, handler);
  };

  const audited = <T>(tool: string, input: unknown, call: () => Promise<T>, extra?: { operationHash?: string }) =>
    run(tool, { actingAs, roles, ...extra }, input, call);

  // ------------------------------------------------------------ common

  register(
    'intempus_search_capabilities',
    {
      title: 'Search Intempus Capabilities',
      description: 'Search the Intempus MCP server capabilities and examples. Use this first when deciding which tool to call.',
      inputSchema: {
        query: z.string().trim().default(''),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_search_capabilities', input, async () => jsonResult(searchCapabilities(input.query, input.limit, available))),
  );

  register(
    'intempus_whoami',
    {
      title: 'Who Am I (Intempus)',
      description: 'Show your roles here (employee/approver/admin, from your Entra groups) and the Intempus employee (and approver levels) you are linked to.',
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_whoami', input, async () => {
        const result: Record<string, unknown> = { roles, actingAs };
        try {
          const me = await self();
          result.employee = { id: me.employeeId, number: me.number, name: me.name, matchedBy: me.matchedBy };
          if (isApprover) {
            const snapshot = await (await scope()).load();
            result.approver = snapshot;
          }
        } catch (error) {
          if (!isAdmin) throw error;
          result.employee = null;
          result.note = `Not linked to an Intempus employee (${formatUnknownError(error)}). Admin tools work regardless.`;
        }
        return jsonResult(result);
      }),
  );

  register(
    'intempus_list_cases',
    {
      title: 'List Cases (Intempus)',
      description: 'Search cases/projects that accept time registrations, by number, name or customer.',
      inputSchema: {
        query: z.string().trim().optional(),
        includeInactive: z.boolean().optional().describe('Admin only: include closed cases.'),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_list_cases', input, async () =>
        jsonResult(await listCases(client, { ...input, includeInactive: isAdmin && input.includeInactive === true })),
      ),
  );

  register(
    'intempus_list_work_types',
    {
      title: 'List Work Types (Intempus)',
      description:
        'Work types (projekttimer, ferie, sygdom, kørsel …). Employees and approvers get the types of their own work model; admins may filter by work model or employee.',
      inputSchema: {
        query: z.string().trim().optional(),
        workModelId: idSchema.optional().describe('Admin only.'),
        employeeId: idSchema.optional().describe('Admin only: the work types valid for this employee today.'),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_list_work_types', input, async () => {
        let workModelIds: number[] | undefined;
        if (isAdmin && input.workModelId) {
          workModelIds = [input.workModelId];
        } else if (isAdmin && input.employeeId) {
          workModelIds = currentWorkModels(contractsOf(await client.get<IntempusObject>(`employee/${input.employeeId}/`)));
        } else if (roles.includes('employee') || isApprover) {
          // Your own work model; an admin who is not linked to an employee gets all types.
          try {
            workModelIds = currentWorkModels((await self()).contracts);
          } catch (error) {
            if (!isAdmin) throw error;
          }
        }
        return jsonResult(await listWorkTypes(client, { workModelIds, query: input.query }));
      }),
  );

  // ------------------------------------------------------ self-service

  register(
    'intempus_get_my_profile',
    {
      title: 'My Profile (Intempus)',
      description: 'Your Intempus employee record, contracts (work model, locked date) and approver levels.',
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_get_my_profile', input, async () => {
        const me = await self();
        const row = await client.get<IntempusObject>(`employee/${me.employeeId}/`);
        return jsonResult({ ...employeeView(row, true), contractToday: contractOn(me.contracts, today()) ?? null });
      }),
  );

  register(
    'intempus_list_my_work_reports',
    {
      title: 'My Time Registrations (Intempus)',
      description: 'Your time registrations in a period (default: last 31 days), with approval status and total.',
      inputSchema: { ...periodShape, approved: z.boolean().optional(), limit: z.number().int().min(1).max(2000).optional() },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_list_my_work_reports', input, async () => {
        const me = await self();
        return jsonResult(await listWorkReports(client, { ...input, employeeIds: [me.employeeId] }));
      }),
  );

  register(
    'intempus_register_time',
    {
      title: 'Register Time (Intempus)',
      description:
        'Register time for yourself. Give a work type, optional case, a date and either startTime+endTime (optionally breakHours) or hours. ' +
        'Checks that you have a contract on the date, that the work type belongs to your work model and that the case is open. ' +
        'Pass idempotencyKey to make a retry safe.',
      inputSchema: { ...timeFields, idempotencyKey: z.string().trim().min(8).max(200).optional() },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_register_time', input, async () => {
        const me = await self();
        return jsonResult(await createTime(client, selfTarget(me, actingAs), input));
      }),
  );

  register(
    'intempus_update_my_work_report',
    {
      title: 'Edit My Time Registration (Intempus)',
      description: 'Change one of your own time registrations. Only possible while it is neither approved nor locked.',
      inputSchema: { workReportId: idSchema, ...partial(timeFields) },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_update_my_work_report', input, async () => {
        const me = await self();
        const report = await ownReport(client, me, input.workReportId);
        assertEditableBySelf(report);
        const { workReportId, ...changes } = input;
        void workReportId;
        return jsonResult(await updateTime(client, selfTarget(me, actingAs), report, changes));
      }),
  );

  register(
    'intempus_delete_my_work_report',
    {
      title: 'Delete My Time Registration (Intempus)',
      description: 'Delete one of your own time registrations. Only possible while it is neither approved nor locked.',
      inputSchema: { workReportId: idSchema },
      annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_delete_my_work_report', input, async () => {
        const me = await self();
        const report = await ownReport(client, me, input.workReportId);
        assertEditableBySelf(report);
        return jsonResult(await deleteTime(client, report));
      }),
  );

  register(
    'intempus_get_my_balances',
    {
      title: 'My Balances (Intempus)',
      description: 'Your balances (ferie, feriefri, timebank/flex, sygdom …) as computed by Intempus up to a date (default today). Holiday accrues at month end, so pass to = the end of the holiday year to see the full entitlement. Only balances visible to employees.',
      inputSchema: periodShape,
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_get_my_balances', input, async () => {
        const me = await self();
        return jsonResult(await employeeBalances(client, { employeeIds: [me.employeeId], ...input, visibility: 'employee' }));
      }),
  );

  register(
    'intempus_get_my_planning',
    {
      title: 'My Planning (Intempus)',
      description: 'Your planned work in a period (default: the next 14 days).',
      inputSchema: periodShape,
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_get_my_planning', input, async () => {
        const me = await self();
        return jsonResult(await plannedWork(client, { employeeIds: [me.employeeId], ...input }));
      }),
  );

  // ---------------------------------------------------------- approver

  register(
    'intempus_list_team',
    {
      title: 'My Team (Intempus, approver)',
      description: 'The employees whose time you approve (from your responsibilities in Intempus) and your approver levels.',
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_list_team', input, async () => {
        const approver = await scope();
        const snapshot = await approver.load();
        return jsonResult({
          levels: snapshot.levels,
          companyWide: snapshot.all,
          cases: snapshot.caseIds,
          note: snapshot.note,
          employees: (await approver.employees()).map(row => employeeView(row)),
        });
      }),
  );

  register(
    'intempus_list_team_work_reports',
    {
      title: 'Team Time Registrations (Intempus, approver)',
      description: 'Time registrations of your team in a period (default last 31 days). status=pending shows those not yet (finally) approved.',
      inputSchema: {
        ...periodShape,
        employeeId: idSchema.optional(),
        status: z.enum(['pending', 'approved', 'all']).default('pending'),
        limit: z.number().int().min(1).max(2000).optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_list_team_work_reports', input, async () => {
        const approver = await scope();
        const snapshot = await approver.load();
        const approved = input.status === 'all' ? undefined : input.status === 'approved';
        if (input.employeeId !== undefined && !(await approver.coversEmployee(input.employeeId))) {
          throw new Error(`Employee ${input.employeeId} is not in your approval scope.`);
        }
        const base = { from: input.from, to: input.to, approved, limit: input.limit };
        if (snapshot.all || input.employeeId !== undefined) {
          return jsonResult(await listWorkReports(client, { ...base, employeeIds: input.employeeId ? [input.employeeId] : undefined }));
        }
        const byEmployee = await listWorkReports(client, { ...base, employeeIds: snapshot.employeeIds });
        const byCase = await Promise.all(snapshot.caseIds.map(caseId => listWorkReports(client, { ...base, caseId })));
        const merged = new Map<unknown, ReturnType<typeof workReportView>>();
        for (const row of [byEmployee, ...byCase].flatMap(result => result.workReports)) merged.set(row.id, row);
        const workReports = [...merged.values()].sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
        return jsonResult({
          from: byEmployee.from,
          to: byEmployee.to,
          count: workReports.length,
          truncated: byEmployee.truncated || byCase.some(result => result.truncated),
          totalHours: Math.round(workReports.reduce((sum, row) => sum + (row.amount ?? 0), 0) * 100) / 100,
          note: snapshot.note,
          workReports,
        });
      }),
  );


  register(
    'intempus_get_team_balances',
    {
      title: 'Team Balances (Intempus, approver)',
      description: 'Balances of your team members (or one of them) up to a date (default today).',
      inputSchema: { employeeId: idSchema.optional(), ...periodShape },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_get_team_balances', input, async () => {
        const employeeIds = await teamEmployeeIds(await scope(), input.employeeId);
        return jsonResult(await employeeBalances(client, { employeeIds, from: input.from, to: input.to, visibility: 'approver' }));
      }),
  );

  register(
    'intempus_get_team_planning',
    {
      title: 'Team Planning (Intempus, approver)',
      description: 'Planned work of your team (or one member) in a period (default: next 14 days).',
      inputSchema: { employeeId: idSchema.optional(), ...periodShape },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_get_team_planning', input, async () => {
        const employeeIds = await teamEmployeeIds(await scope(), input.employeeId);
        return jsonResult(await plannedWork(client, { employeeIds, from: input.from, to: input.to }));
      }),
  );

  // ------------------------------------------------------------- admin

  register(
    'intempus_list_employees',
    {
      title: 'List Employees (Intempus, admin)',
      description: 'Search all employees by name, number, username, initials or email.',
      inputSchema: { query: z.string().trim().optional(), activeOnly: z.boolean().optional() },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => audited('intempus_list_employees', input, async () => jsonResult(await listEmployees(client, input))),
  );

  register(
    'intempus_get_employee',
    {
      title: 'Get Employee (Intempus, admin)',
      description: 'One employee with contracts, approver levels and login access.',
      inputSchema: { employeeId: idSchema },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => audited('intempus_get_employee', input, async () => jsonResult(await getEmployee(client, input.employeeId))),
  );

  register(
    'intempus_manage_employee',
    {
      title: 'Create/Update/Offboard Employee (Intempus, admin)',
      description:
        'create: new employee (optionally with a first contract via workModelId + contractStartDate). update: change master data. ' +
        'offboard: end open contracts on `date` (no time can be registered after it) and revoke backend/approval logins — this is how an employee is removed: ' +
        'Intempus refuses to delete an employee that has a user profile, and every employee gets one. ' +
        'Set username or email to the Entra sign-in address so self-service can find the employee.',
      inputSchema: {
        action: z.enum(['create', 'update', 'offboard']),
        employeeId: idSchema.optional().describe('Required for update/offboard.'),
        name: z.string().trim().min(1).optional(),
        number: z.string().trim().regex(/^[1-9]\d{0,5}$/, 'a positive whole number below 1,000,000').optional(),
        initial: z.string().trim().optional(),
        username: z.string().trim().optional(),
        email: z.string().trim().email().optional(),
        phone: z.string().trim().optional(),
        departmentId: idSchema.nullable().optional(),
        employeeGroupId: idSchema.nullable().optional(),
        seniorityDate: dateSchema.optional(),
        password: z.string().min(8).optional().describe('Initial app password. Omit to let Intempus generate one and email it (needs email); never returned.'),
        workModelId: idSchema.optional().describe('create: also create a contract with this work model.'),
        contractStartDate: dateSchema.optional(),
        date: dateSchema.optional().describe('offboard: last day (default today).'),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_manage_employee', input, async () => {
        assertWritesEnabled(`${input.action} employee`);
        const master = {
          name: input.name,
          number: input.number,
          initial: input.initial,
          username: input.username,
          email: input.email,
          phone: input.phone,
          department: nullableUri(client, 'department', input.departmentId),
          employee_group: nullableUri(client, 'employee_group', input.employeeGroupId),
          seniority_date: input.seniorityDate,
        };
        try {
          if (input.action === 'create') {
            if (!input.name) throw new Error('name is required to create an employee.');
            const username = input.username ?? input.email;
            if (!username) throw new Error('username (or email, used as username) is required to create an employee — use the Entra sign-in address.');
            await assertUniqueEmployee(client, input);
            const generated = input.password === undefined;
            const created = await createOrUpdate(
              client,
              'employee',
              undefined,
              {
                ...master,
                username,
                company: await companyUri(client),
                // password_generation (verified 2026-09-29): 0 is only valid for existing
                // users (also the default, so it must be sent), 1 = Intempus generates a
                // password and emails it (needs email), 2 = use the given password.
                ...(input.password === undefined && input.email
                  ? { password: randomPassword(), password_generation: 1 }
                  : { password: input.password ?? randomPassword(), password_generation: 2 }),
              },
              'create employee',
            );
            const createdId = Number(created?.id ?? (await findEmployeeId(client, input)));
            let contract: unknown;
            if (input.workModelId) {
              contract = await createOrUpdate(
                client,
                'contract',
                undefined,
                {
                  employee: client.uri('employee', createdId),
                  work_model: client.uri('work_model', input.workModelId),
                  start_date: input.contractStartDate ?? today(),
                },
                'create contract',
              );
            }
            return jsonResult({
              created: await getEmployee(client, createdId),
              contract: contract ?? null,
              note: generated
                ? input.email
                  ? `Intempus generated a password and emailed it to ${input.email}.`
                  : 'A random app password was set and is not shown (no email to send one to). An admin sets a password in Intempus.'
                : undefined,
            });
          }
          const employeeId = requireId(input.employeeId, 'employeeId');
          if (input.action === 'update') {
            await createOrUpdate(client, 'employee', employeeId, { ...master, password: input.password }, 'update employee');
            return jsonResult({ updated: await getEmployee(client, employeeId) });
          }
          return jsonResult(await offboardEmployee(client, employeeId, input.date ?? today()));
        } finally {
          clearEmployeeCache();
        }
      }),
  );

  register(
    'intempus_manage_contract',
    {
      title: 'Create/Update Contract (Intempus, admin)',
      description:
        'Employment contract: work model (e.g. Fastansatte, Vikar / Løsansatte), working-hours agreement, start/end, hourly wage. ' +
        'Time can only be registered inside a contract. locked_date is changed via intempus_prepare_admin_change.',
      inputSchema: {
        action: z.enum(['create', 'update']),
        contractId: idSchema.optional().describe('Required for update.'),
        employeeId: idSchema.optional().describe('Required for create.'),
        workModelId: idSchema.optional(),
        workingHoursAgreementId: idSchema.optional(),
        startDate: dateSchema.optional(),
        endDate: dateSchema.nullable().optional(),
        hourlyWage: z.number().min(0).nullable().optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_manage_contract', input, async () => {
        const body = {
          employee: input.employeeId ? client.uri('employee', input.employeeId) : undefined,
          work_model: input.workModelId ? client.uri('work_model', input.workModelId) : undefined,
          working_hours_agreement: input.workingHoursAgreementId ? client.uri('working_hours_agreement', input.workingHoursAgreementId) : undefined,
          start_date: input.startDate,
          end_date: input.endDate,
          hourly_wage: input.hourlyWage,
        };
        try {
          if (input.action === 'create') {
            if (!input.employeeId || !input.workModelId || !input.startDate) {
              throw new Error('employeeId, workModelId and startDate are required to create a contract.');
            }
            return jsonResult(await createOrUpdate(client, 'contract', undefined, body, 'create contract'));
          }
          const contractId = requireId(input.contractId, 'contractId');
          await createOrUpdate(client, 'contract', contractId, { ...body, employee: undefined }, 'update contract');
          return jsonResult(await client.get(`contract/${contractId}/`));
        } finally {
          clearEmployeeCache();
        }
      }),
  );

  register(
    'intempus_manage_user_access',
    {
      title: 'Set Login Access (Intempus, admin)',
      description: 'Allow or revoke an employee\'s login to the Intempus backend and to the approval app.',
      inputSchema: {
        employeeId: idSchema,
        mayLogIntoBackend: z.boolean().optional(),
        mayLogIntoApproval: z.boolean().optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_manage_user_access', input, async () => {
        const profileRow = await userProfileOf(client, input.employeeId);
        await createOrUpdate(
          client,
          'userprofile',
          profileRow ? Number(profileRow.id) : undefined,
          {
            employee: profileRow ? undefined : client.uri('employee', input.employeeId),
            may_log_into_backend: input.mayLogIntoBackend,
            may_log_into_approval: input.mayLogIntoApproval,
          },
          'set login access',
        );
        return jsonResult((await getEmployee(client, input.employeeId)).access);
      }),
  );

  register(
    'intempus_list_responsibilities',
    {
      title: 'List Approvers & Responsibilities (Intempus, admin)',
      description: 'Approver levels (second/final) and which employees, departments and cases each approver covers.',
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => audited('intempus_list_responsibilities', input, async () => jsonResult(await listResponsibilities(client))),
  );

  register(
    'intempus_manage_responsibility',
    {
      title: 'Manage Approvers & Responsibilities (Intempus, admin)',
      description:
        'add_level (employeeId + level) / remove_level (responsibleId): make someone second or final approver. ' +
        'assign (responsibleId + targetType + targetId) / unassign (targetType + assignmentId): which employees, departments or cases they approve. ' +
        'This is exactly what scopes the approver endpoint.',
      inputSchema: {
        action: z.enum(['add_level', 'remove_level', 'assign', 'unassign']),
        employeeId: idSchema.optional(),
        level: levelSchema.optional(),
        responsibleId: idSchema.optional(),
        targetType: z.enum(['employee', 'department', 'case']).optional(),
        targetId: idSchema.optional(),
        assignmentId: idSchema.optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_manage_responsibility', input, async () => {
        assertWritesEnabled(`responsibility ${input.action}`);
        switch (input.action) {
          case 'add_level':
            return jsonResult(
              await createOrUpdate(
                client,
                'responsible',
                undefined,
                { employee: client.uri('employee', requireId(input.employeeId, 'employeeId')), level: required(input.level, 'level') },
                'add approver level',
              ),
            );
          case 'remove_level':
            await client.delete(`responsible/${requireId(input.responsibleId, 'responsibleId')}/`);
            return jsonResult({ removed: true, responsibleId: input.responsibleId });
          case 'assign': {
            const type = required(input.targetType, 'targetType');
            return jsonResult(
              await createOrUpdate(
                client,
                `responsible_for_${type}`,
                undefined,
                {
                  responsible: client.uri('responsible', requireId(input.responsibleId, 'responsibleId')),
                  [type]: client.uri(type, requireId(input.targetId, 'targetId')),
                },
                'assign responsibility',
              ),
            );
          }
          case 'unassign': {
            const type = required(input.targetType, 'targetType');
            await client.delete(`responsible_for_${type}/${requireId(input.assignmentId, 'assignmentId')}/`);
            return jsonResult({ removed: true, targetType: type, assignmentId: input.assignmentId });
          }
        }
      }),
  );

  register(
    'intempus_list_work_reports',
    {
      title: 'List Work Reports (Intempus, admin)',
      description: 'Time registrations of anyone, by period (default last 31 days), employees, case and approval.',
      inputSchema: {
        ...periodShape,
        employeeIds: z.array(idSchema).min(1).max(500).optional(),
        caseId: idSchema.optional(),
        approved: z.boolean().optional(),
        limit: z.number().int().min(1).max(5000).optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => audited('intempus_list_work_reports', input, async () => jsonResult(await listWorkReports(client, input))),
  );

  register(
    'intempus_manage_work_report',
    {
      title: 'Create/Update/Delete Work Report (Intempus, admin)',
      description:
        'Register, correct or delete time on behalf of any employee. Contract, locked date, case and work type are checked; locked reports are refused.',
      inputSchema: {
        action: z.enum(['create', 'update', 'delete']),
        workReportId: idSchema.optional().describe('Required for update/delete.'),
        employeeId: idSchema.optional().describe('Required for create.'),
        ...partial(timeFields),
        idempotencyKey: z.string().trim().min(8).max(200).optional(),
      },
      annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_manage_work_report', input, async () => {
        const { action, workReportId, employeeId, ...fields } = input;
        if (action === 'create') {
          const target = await adminTarget(client, requireId(employeeId, 'employeeId'), actingAs);
          if (!fields.date || !fields.workTypeId) throw new Error('date and workTypeId are required to create a work report.');
          return jsonResult(await createTime(client, target, { ...fields, date: fields.date, workTypeId: fields.workTypeId }));
        }
        const report = await getWorkReport(client, requireId(workReportId, 'workReportId'));
        if (report.isimmutable === true) {
          throw new Error(`Work report ${String(report.id)} is locked; unlock it with intempus_prepare_admin_change first.`);
        }
        if (action === 'delete') {
          return jsonResult(await deleteTime(client, report));
        }
        const target = await adminTarget(client, idFromUri(report.employee) ?? Number(report.employee_id), actingAs);
        return jsonResult(await updateTime(client, target, report, fields));
      }),
  );

  register(
    'intempus_manage_case',
    {
      title: 'Create/Update Case (Intempus, admin)',
      description:
        'Create or update a case/project. With projectNumber the name becomes "<projectNumber> - <name>", the convention bpc (projekt.onedanmark.dk) matches on. ' +
        'Close a case with active=false or permitNewWorkReports=false. A create is refused when the number or name already exists.',
      inputSchema: {
        action: z.enum(['create', 'update']),
        caseId: idSchema.optional().describe('Required for update.'),
        name: z.string().trim().min(1).optional(),
        projectNumber: z.string().trim().optional().describe('bpc/ONE project number to prefix the name with.'),
        number: z.string().trim().optional().describe('Intempus case number.'),
        customerId: idSchema.optional().describe('Required for create.'),
        active: z.boolean().optional(),
        permitNewWorkReports: z.boolean().optional(),
        allEmployeesMayReport: z.boolean().optional(),
        startDate: dateSchema.nullable().optional(),
        endDate: dateSchema.nullable().optional(),
        hourBudget: z.number().min(0).nullable().optional(),
        responsibleEmployeeId: idSchema.nullable().optional(),
        parentCaseId: idSchema.nullable().optional(),
        departmentId: idSchema.nullable().optional(),
        streetAddress: z.string().trim().optional(),
        zipCode: z.string().trim().optional(),
        city: z.string().trim().optional(),
        notes: z.string().optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_manage_case', input, async () => {
        const name = input.name && input.projectNumber ? `${input.projectNumber} - ${input.name}` : input.name;
        const body = {
          name,
          number: input.number,
          customer: input.customerId ? client.uri('customer', input.customerId) : undefined,
          active: input.active,
          permit_new_workreports: input.permitNewWorkReports,
          all_employees_may_add_work_reports: input.allEmployeesMayReport,
          start_date: input.startDate,
          end_date: input.endDate,
          hour_budget: input.hourBudget,
          responsible: nullableUri(client, 'employee', input.responsibleEmployeeId),
          parent: nullableUri(client, 'case', input.parentCaseId),
          department: nullableUri(client, 'department', input.departmentId),
          street_address: input.streetAddress,
          zip_code: input.zipCode,
          city: input.city,
          notes: input.notes,
        };
        if (input.action === 'create') {
          if (!name || !input.customerId) throw new Error('name and customerId are required to create a case.');
          await assertUniqueCase(client, name, input.number);
          const created = await createOrUpdate(client, 'case', undefined, { ...body, active: body.active ?? true, permit_new_workreports: body.permit_new_workreports ?? true }, 'create case');
          return jsonResult(created ? caseView(created) : { created: true, name });
        }
        const caseId = requireId(input.caseId, 'caseId');
        await createOrUpdate(client, 'case', caseId, body, 'update case');
        return jsonResult(caseView(await client.get<IntempusObject>(`case/${caseId}/`)));
      }),
  );

  register(
    'intempus_list_customers',
    {
      title: 'List Customers (Intempus, admin)',
      description: 'Search customers by number or name.',
      inputSchema: { query: z.string().trim().optional(), includeInactive: z.boolean().optional() },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => audited('intempus_list_customers', input, async () => jsonResult(await listCustomers(client, input))),
  );

  register(
    'intempus_manage_customer',
    {
      title: 'Create/Update Customer (Intempus, admin)',
      description: 'Create or update a customer.',
      inputSchema: {
        action: z.enum(['create', 'update']),
        customerId: idSchema.optional().describe('Required for update.'),
        name: z.string().trim().min(1).optional(),
        number: z.string().trim().optional(),
        active: z.boolean().optional(),
        streetAddress: z.string().trim().optional(),
        zipCode: z.string().trim().optional(),
        city: z.string().trim().optional(),
        country: z.string().trim().optional(),
        email: z.string().trim().email().optional(),
        phone: z.string().trim().optional(),
        vatNumber: z.string().trim().optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_manage_customer', input, async () => {
        const body = {
          name: input.name,
          number: input.number,
          active: input.active,
          street_address: input.streetAddress,
          zip_code: input.zipCode,
          city: input.city,
          country: input.country,
          email: input.email,
          phone: input.phone,
          vat_registration_number: input.vatNumber,
        };
        if (input.action === 'create') {
          if (!input.name) throw new Error('name is required to create a customer.');
          const created = await createOrUpdate(client, 'customer', undefined, { company: await companyUri(client), ...body }, 'create customer');
          return jsonResult(created ? customerView(created) : { created: true, name: input.name });
        }
        const customerId = requireId(input.customerId, 'customerId');
        await createOrUpdate(client, 'customer', customerId, body, 'update customer');
        return jsonResult(customerView(await client.get<IntempusObject>(`customer/${customerId}/`)));
      }),
  );

  register(
    'intempus_list_balances',
    {
      title: 'List Balance Definitions (Intempus, admin)',
      description: 'Balance definitions (ferie, feriefri, timebank, sygdom …) with unit, period and visibility.',
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_list_balances', input, async () =>
        jsonResult(
          (await listBalanceDefinitions(client)).map(row => ({
            id: row.id,
            name: row.name,
            unit: row.unit,
            startDate: row.start_date,
            endDate: row.end_date,
            recurringMode: row.recurring_mode,
            visibleToEmployees: row.visible,
            visibleToApprovers: row.visible_for_admins_and_approvers,
            threshold: row.threshold,
            minimumThreshold: row.minimum_threshold,
          })),
        ),
      ),
  );

  register(
    'intempus_get_employee_balances',
    {
      title: 'Employee Balances (Intempus, admin)',
      description: 'Balances of the given employees (default: all employees with an active contract) up to a date (default today).',
      inputSchema: { employeeIds: z.array(idSchema).min(1).max(500).optional(), ...periodShape },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_get_employee_balances', input, async () => {
        const employeeIds =
          input.employeeIds ?? (await listEmployeesCached(client)).filter(row => row.active_contract === true).map(row => Number(row.id));
        return jsonResult(await employeeBalances(client, { employeeIds, from: input.from, to: input.to, visibility: 'admin' }));
      }),
  );

  register(
    'intempus_list_schedules',
    {
      title: 'List Schedules (Intempus, admin)',
      description: 'Planning schedules overlapping a period, optionally for one employee or case.',
      inputSchema: { ...periodShape, employeeId: idSchema.optional(), caseId: idSchema.optional() },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_list_schedules', input, async () => {
        const query: Record<string, QueryValue> = {
          start_date__lte: input.to,
          employee__id: input.employeeId,
          case__id: input.caseId,
        };
        const result = await client.listAll('schedule/', query, 2000);
        const from = input.from;
        return jsonResult({
          truncated: result.truncated,
          schedules: result.items.filter(row => !from || !row.end_date || String(row.end_date) >= from),
        });
      }),
  );

  register(
    'intempus_manage_schedule',
    {
      title: 'Create/Update/Delete Schedule (Intempus, admin)',
      description: 'Plan work: employees, case, work type, date range, times, weekdays and recurrence. Intempus generates planned work from it.',
      inputSchema: {
        action: z.enum(['create', 'update', 'delete']),
        scheduleId: idSchema.optional().describe('Required for update/delete.'),
        employeeIds: z.array(idSchema).min(1).max(200).optional(),
        caseId: idSchema.nullable().optional(),
        workTypeId: idSchema.nullable().optional(),
        workCategoryId: idSchema.nullable().optional(),
        startDate: dateSchema.optional(),
        endDate: dateSchema.nullable().optional(),
        startTime: timeSchema.optional(),
        endTime: timeSchema.optional(),
        amount: z.number().min(0).max(24).optional(),
        weekdays: z.array(z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'])).optional(),
        recurringMode: z.string().trim().optional().describe('Intempus recurring_mode, e.g. "weekly".'),
        recurring: z.number().int().min(0).optional(),
        remarks: z.string().optional(),
        isDraft: z.boolean().optional(),
      },
      annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_manage_schedule', input, async () => {
        if (input.action === 'delete') {
          assertWritesEnabled('delete schedule');
          const scheduleId = requireId(input.scheduleId, 'scheduleId');
          await client.delete(`schedule/${scheduleId}/`);
          return jsonResult({ deleted: true, scheduleId });
        }
        const weekdays = input.weekdays
          ? Object.fromEntries(
              ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(day => [day, input.weekdays!.includes(day as never)]),
            )
          : {};
        const body = {
          employees: input.employeeIds?.map(id => client.uri('employee', id)),
          case: nullableUri(client, 'case', input.caseId),
          work_type: nullableUri(client, 'work_type', input.workTypeId),
          work_category: nullableUri(client, 'work_category', input.workCategoryId),
          start_date: input.startDate,
          end_date: input.endDate,
          start_time: input.startTime ? normalizeTime(input.startTime) : undefined,
          end_time: input.endTime ? normalizeTime(input.endTime) : undefined,
          amount: input.amount,
          recurring_mode: input.recurringMode,
          recurring: input.recurring,
          remarks: input.remarks,
          is_draft: input.isDraft,
          ...weekdays,
        };
        if (input.action === 'create') {
          if (!input.startDate || !input.employeeIds) throw new Error('employeeIds and startDate are required to create a schedule.');
          return jsonResult(await createOrUpdate(client, 'schedule', undefined, { company: await companyUri(client), ...body }, 'create schedule'));
        }
        const scheduleId = requireId(input.scheduleId, 'scheduleId');
        await createOrUpdate(client, 'schedule', scheduleId, body, 'update schedule');
        return jsonResult(await client.get(`schedule/${scheduleId}/`));
      }),
  );

  register(
    'intempus_list_planned_work',
    {
      title: 'List Planned Work (Intempus, admin)',
      description: 'Planned work lines for anyone in a period (default next 14 days).',
      inputSchema: { employeeIds: z.array(idSchema).min(1).max(500).optional(), ...periodShape },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => audited('intempus_list_planned_work', input, async () => jsonResult(await plannedWork(client, input))),
  );

  register(
    'intempus_list_reference_data',
    {
      title: 'Reference Data (Intempus, admin)',
      description: `Reference lists: ${Object.keys(REFERENCE_KINDS).join(', ')}.`,
      inputSchema: { kind: z.enum(Object.keys(REFERENCE_KINDS) as [ReferenceKind, ...ReferenceKind[]]) },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => audited('intempus_list_reference_data', input, async () => jsonResult(await listReferenceData(client, input.kind))),
  );

  register(
    'intempus_get_resource',
    {
      title: 'Read Any Resource (Intempus, admin)',
      description:
        'Read-only access to allowlisted Intempus resources without a dedicated tool (e.g. historical_work_report, employee_work_type_rule, daily_rest_violation, webhook_configuration). ' +
        'Give id for one object, or filters in tastypie syntax (e.g. {"start_date__gte": "2026-09-01"}).',
      inputSchema: {
        resource: z.string().trim().refine(value => READABLE_RESOURCES.has(value), 'resource is not readable through this tool'),
        id: idSchema.optional(),
        filters: z.record(z.string().regex(/^[a-z_]+(__[a-z_]+)*$/), z.union([z.string(), z.number(), z.boolean()])).optional(),
        limit: z.number().int().min(1).max(1000).default(100),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_get_resource', input, async () => {
        if (input.id !== undefined) {
          return jsonResult(sanitizeRaw(await client.get<IntempusObject>(`${input.resource}/${input.id}/`)));
        }
        const result = await client.listAll<IntempusObject>(`${input.resource}/`, input.filters ?? {}, input.limit);
        return jsonResult({ resource: input.resource, totalCount: result.totalCount, truncated: result.truncated, objects: result.items.map(sanitizeRaw) });
      }),
  );

  register(
    'intempus_prepare_admin_change',
    {
      title: 'Prepare Irreversible Change (Intempus, admin)',
      description:
        'Step 1 of 2 for irreversible changes: delete (employee, case, customer, contract, work_report, schedule, planned_work_report, balance), ' +
        'lock_work_reports (lock/unlock), set_contract_locked_date (close or reopen a period). Reads the targets and returns a signed preview; changes nothing. ' +
        'Show the preview to the user, then call intempus_commit_prepared_operation with the operation and its operationHash.',
      inputSchema: {
        change: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('delete'), resource: z.enum(DELETABLE_RESOURCES), ids: z.array(idSchema).min(1).max(50) }),
          z.object({ kind: z.literal('lock_work_reports'), ids: z.array(idSchema).min(1).max(500), locked: z.boolean() }),
          z.object({ kind: z.literal('set_contract_locked_date'), contractIds: z.array(idSchema).min(1).max(200), lockedDate: dateSchema.nullable() }),
        ]),
        reason: z.string().trim().min(3).max(500),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('intempus_prepare_admin_change', input, async () =>
        jsonResult(await prepareAdminChange(client, input.change, { reason: input.reason, actingAs })),
      ),
  );

  register(
    'intempus_commit_prepared_operation',
    {
      title: 'Commit Prepared Change (Intempus, admin)',
      description:
        'Step 2 of 2: carry out an operation returned by intempus_prepare_admin_change, after the user confirmed the preview. Irreversible. ' +
        'Pass the operation object unchanged and confirmOperationHash = its operationHash.',
      inputSchema: {
        operation: z.looseObject({ operationHash: z.string() }),
        confirmOperationHash: z.string().regex(/^[0-9a-f]{64}$/),
      },
      annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
    },
    async input =>
      audited(
        'intempus_commit_prepared_operation',
        input,
        async () => {
          const operation = verifyPreparedOperation(parseOperation(input.operation), {
            confirmOperationHash: input.confirmOperationHash,
            actingAs,
          });
          return jsonResult(await commitPreparedOperation(client, operation));
        },
        { operationHash: input.confirmOperationHash },
      ),
  );

  async function teamEmployeeIds(approver: ApproverScope, employeeId?: number): Promise<number[]> {
    if (employeeId !== undefined) {
      if (!(await approver.coversEmployee(employeeId))) {
        throw new Error(`Employee ${employeeId} is not in your approval scope.`);
      }
      return [employeeId];
    }
    return (await approver.employees()).map(row => Number(row.id));
  }
}

// ----------------------------------------------------------------- helpers

function selfTarget(me: ResolvedEmployee, actingAs: string): TimeTarget {
  return { employeeId: me.employeeId, contracts: me.contracts, strictWorkModel: true, actingAs };
}

async function adminTarget(client: IntempusClient, employeeId: number, actingAs: string): Promise<TimeTarget> {
  const row = await client.get<IntempusObject>(`employee/${employeeId}/`);
  return { employeeId, contracts: contractsOf(row), strictWorkModel: true, actingAs };
}

/** Read a report and make sure it is the caller's own — without revealing others' reports. */
async function ownReport(client: IntempusClient, me: ResolvedEmployee, workReportId: number): Promise<IntempusObject> {
  let report: IntempusObject;
  try {
    report = await getWorkReport(client, workReportId);
  } catch {
    throw new Error(`Work report ${workReportId} was not found among your registrations.`);
  }
  const owner = idFromUri(report.employee) ?? Number(report.employee_id);
  if (owner !== me.employeeId) {
    throw new Error(`Work report ${workReportId} was not found among your registrations.`);
  }
  return report;
}

/** Work models of contracts that cover today or start later. */
function currentWorkModels(contracts: ReturnType<typeof contractsOf>): number[] {
  const now = today();
  const ids = contracts
    .filter(contract => !contract.endDate || contract.endDate >= now)
    .map(contract => contract.workModelId)
    .filter((id): id is number => id !== undefined);
  return [...new Set(ids)];
}

let companyUriCache: { baseUrl: string; uri: string } | undefined;

async function companyUri(client: IntempusClient): Promise<string> {
  if (companyUriCache?.baseUrl === client.baseUrl) return companyUriCache.uri;
  const companies = (await client.listAll<IntempusObject>('company/', {}, 10)).items;
  if (companies.length !== 1) {
    throw new Error(`The API user sees ${companies.length} Intempus companies; exactly one is supported.`);
  }
  const uri = String(companies[0]!.resource_uri ?? client.uri('company', Number(companies[0]!.id)));
  companyUriCache = { baseUrl: client.baseUrl, uri };
  return uri;
}

async function assertUniqueEmployee(client: IntempusClient, input: { number?: string; username?: string; email?: string }) {
  const lower = (value: unknown) => String(value ?? '').trim().toLowerCase();
  for (const row of await listEmployeesCached(client)) {
    if (input.number && String(row.number ?? '') === input.number) {
      throw new Error(`Employee number ${input.number} is already used by employee ${String(row.id)}.`);
    }
    if (input.username && lower(row.username) === lower(input.username)) {
      throw new Error(`Username ${input.username} is already used by employee ${String(row.id)}.`);
    }
    if (input.email && lower(row.email) === lower(input.email)) {
      throw new Error(`Email ${input.email} is already used by employee ${String(row.id)}; self-service identity must be unique.`);
    }
  }
}

async function findEmployeeId(client: IntempusClient, input: { number?: string; username?: string; name?: string }): Promise<number> {
  clearEmployeeCache();
  const rows = await listEmployeesCached(client);
  const match = rows.find(row =>
    (input.number && String(row.number ?? '') === input.number) ||
    (input.username && String(row.username ?? '') === input.username),
  );
  if (!match) throw new Error('Employee was created but could not be read back; look it up with intempus_list_employees.');
  return Number(match.id);
}

async function assertUniqueCase(client: IntempusClient, name: string, number?: string) {
  const rows = (await client.listAll<IntempusObject>('case/', {}, 10_000)).items;
  const clash = rows.find(row =>
    (number && String(row.number ?? '') === number) || String(row.name ?? '').trim().toLowerCase() === name.trim().toLowerCase(),
  );
  if (clash) {
    throw new Error(`Case ${String(clash.id)} "${String(clash.name)}" (number ${String(clash.number)}) already exists; update it instead.`);
  }
}


async function offboardEmployee(client: IntempusClient, employeeId: number, date: string) {
  const row = await client.get<IntempusObject>(`employee/${employeeId}/`);
  const ended: Array<{ contractId: number; endDate: string }> = [];
  for (const contract of contractsOf(row)) {
    if (!contract.endDate || contract.endDate > date) {
      if (contract.startDate && contract.startDate > date) {
        throw new Error(`Contract ${contract.id} starts after ${date}; end or delete it explicitly.`);
      }
      await client.patch(`contract/${contract.id}/`, { end_date: date });
      ended.push({ contractId: contract.id, endDate: date });
    }
  }
  const profileRow = await userProfileOf(client, employeeId);
  if (profileRow) {
    await client.patch(`userprofile/${String(profileRow.id)}/`, { may_log_into_backend: false, may_log_into_approval: false });
  }
  return { offboarded: employeeId, lastDay: date, endedContracts: ended, loginsRevoked: Boolean(profileRow) };
}

function parseOperation(value: Record<string, unknown>): PreparedOperation {
  const operation = value as unknown as PreparedOperation;
  if (!Array.isArray(operation.steps) || typeof operation.kind !== 'string' || typeof operation.expiresAt !== 'string') {
    throw new Error('operation is not a prepared operation; pass it exactly as intempus_prepare_admin_change returned it.');
  }
  return operation;
}

function nullableUri(client: IntempusClient, resource: string, id: number | null | undefined): string | null | undefined {
  if (id === undefined) return undefined;
  if (id === null) return null;
  return client.uri(resource, id);
}

function requireId(value: number | undefined, name: string): number {
  if (value === undefined) throw new Error(`${name} is required for this action.`);
  return value;
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is required for this action.`);
  return value;
}

function randomPassword(): string {
  return randomBytes(18).toString('base64url');
}

function partial<T extends Record<string, z.ZodType>>(shape: T): { [K in keyof T]: z.ZodOptional<T[K]> } {
  return Object.fromEntries(Object.entries(shape).map(([key, schema]) => [key, schema.optional()])) as {
    [K in keyof T]: z.ZodOptional<T[K]>;
  };
}

async function run<T>(
  tool: string,
  context: { actingAs: string; roles: readonly IntempusRole[]; operationHash?: string },
  input: unknown,
  call: () => Promise<T>,
): Promise<T> {
  const policy = checkToolPolicy(tool, context.roles);
  const target = auditTarget(input);
  const base = { tool, actingAs: context.actingAs, profile: context.roles.join('+'), operationHash: context.operationHash };

  if (!policy.allowed) {
    await writeAuditEvent({ ...base, action: 'policy_denied', target, reason: policy.reason });
    throw new Error(policy.reason);
  }

  await writeAuditEvent({ ...base, action: 'start', target, reason: policy.reason });

  try {
    const result = await call();
    await writeAuditEvent({ ...base, action: 'finish', target, status: 'ok' });
    return result;
  } catch (error) {
    await writeAuditEvent({ ...base, action: 'error', target, status: 'error', error: formatUnknownError(error) });
    throw error;
  }
}

function auditTarget(input: unknown): unknown {
  if (!input || typeof input !== 'object') {
    return input;
  }
  const value = input as Record<string, unknown>;
  return {
    action: value.action,
    employeeId: value.employeeId,
    employeeIds: value.employeeIds,
    workReportId: value.workReportId,
    workReportIds: value.workReportIds,
    caseId: value.caseId,
    customerId: value.customerId,
    contractId: value.contractId,
    scheduleId: value.scheduleId,
    responsibleId: value.responsibleId,
    resource: value.resource,
    change: value.change,
    date: value.date,
    from: value.from,
    to: value.to,
    query: value.query,
  };
}

function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}
