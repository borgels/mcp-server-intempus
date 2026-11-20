import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { GATEWAY_FAILED_TEXT, gatewayErrorText, redactSecrets } from './errors.js';
import { fixedOutputs, withheldResult } from './fallbacks.js';
import { admitsKey, keyRefusedText, leaksSecret, sealedError } from './key-admission.js';
import { writeAuditEvent } from './intempus/audit.js';
import {
  canonicalToolName,
  GatewayConfigError,
  resolveInstancePolicy,
  runInCallScope,
  type CallContext,
  type InstancePolicy,
  type ResolvedInstancePolicy,
} from './intempus/call-scope.js';
import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, IntempusClient } from './intempus/client.js';
import { REDACTION_MARKER, SecretRedactor } from './secret-redactor.js';
import { registerIntempusTools } from './tools/intempus.js';

/**
 * Embeddable entry point (package export `./gateway`): an embedding host,
 * such as an MCP gateway that does its own per-user authorization, lists
 * `tools` and invokes `callTool`. Handlers, input schemas, policy checks and
 * audit are shared with the MCP server in src/tools/intempus.ts.
 *
 * Several gateway instances (for example one per tenant) can run in one
 * process. Each instance uses only the API user and key passed to
 * createIntempusGateway, sends the key only to intempus.dk, and redacts
 * results, errors and audit records with its own key only.
 *
 * A gateway instance reads no INTEMPUS_* variable: not INTEMPUS_API_USER,
 * INTEMPUS_API_KEY, INTEMPUS_BASE_URL or INTEMPUS_TIMEOUT_MS (options and
 * defaults instead), not INTEMPUS_ENABLE_WRITES or INTEMPUS_AUDIT_LOG (the
 * host's `policy` instead; without one, writes are off and nothing is
 * audited), and not INTEMPUS_PROFILE, INTEMPUS_IDENTITY_MAP,
 * INTEMPUS_TRUST_FORWARDED_USER or INTEMPUS_OPERATION_SECRET. The host does
 * not know the person's Intempus employee, so the gateway offers only
 * company-wide tools that need no identity, run as the admin role, and not
 * the two-step irreversible changes (prepare/commit).
 *
 * Every call runs in a call scope of its own (AsyncLocalStorage), so a call
 * made from inside another instance's call (from its audit sink or its fetch)
 * never inherits that instance's policy, sink, redactor or caller.
 */

export type { AuditSink, InstancePolicy } from './intempus/call-scope.js';
export { GatewayConfigError } from './intempus/call-scope.js';

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue =
  | string
  | number
  | boolean
  | null
  | GatewayJsonValue[]
  | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
}

/** Who and which request a call belongs to (written to the audit records of the call, the caller only as a pseudonym). */
export type GatewayCallContext = CallContext;

/** Deeply read-only JSON, as found in the frozen tool catalog. */
export type GatewayReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly GatewayReadonlyJsonValue[]
  | { readonly [key: string]: GatewayReadonlyJsonValue };

/**
 * One Intempus API request a tool may make: the method and the path template relative to the base URL
 * (`https://intempus.dk/web/v1`). `{id}` is a numeric Intempus id, `{resource}` one of the resources
 * `get_resource` may read. List requests carry query parameters (filters, paging), which are not part of the path.
 */
export interface GatewayUpstreamOperation {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
}

/** A tool catalog entry: the gateway definition plus the upstream requests the tool may make. */
export interface GatewayToolCatalogEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly riskLevel: GatewayRiskLevel;
  readonly enabledByDefault: boolean;
  readonly inputSchema: { readonly [key: string]: GatewayReadonlyJsonValue };
  /** Every Intempus request the tool may make. Empty for a tool that does not call Intempus. */
  readonly upstream: readonly GatewayUpstreamOperation[];
  /**
   * True when the tool can read more than its name says (anything in the
   * system, chosen by the input). A host that grants tools per role gives a
   * broad tool only to roles that may read everything. Only `get_resource`
   * is broad: it reads any of a list of Intempus resources by name.
   */
  readonly broad: boolean;
}

export interface IntempusGatewayOptions {
  /** The Intempus API user (its user name, case-sensitive). Required; never read from the environment. */
  apiUser: string;
  /** The API key of that user. Required; never read from the environment. */
  apiKey: string;
  /** Intempus API base URL. Default https://intempus.dk/web/v1/; must be an https address on intempus.dk. */
  baseUrl?: string;
  /** Request timeout in milliseconds (1-600000). Default 30000; never read from the environment. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Longest Retry-After (seconds) waited out once on HTTP 429 before failing. Default 10. */
  maxRetryAfterSeconds?: number;
  /**
   * Instance policy from the host (see InstancePolicy). Without it the
   * instance has writes off, no disabled tools and no audit.
   */
  policy?: InstancePolicy;
}

/** The only host the key is sent to. */
const INTEMPUS_HOST = 'intempus.dk';

const get = (path: string): GatewayUpstreamOperation => ({ method: 'GET', path });
const post = (path: string): GatewayUpstreamOperation => ({ method: 'POST', path });
const patch = (path: string): GatewayUpstreamOperation => ({ method: 'PATCH', path });
const del = (path: string): GatewayUpstreamOperation => ({ method: 'DELETE', path });

/** The resources list_reference_data reads (src/intempus/resources.ts, REFERENCE_KINDS). */
const REFERENCE_RESOURCES = [
  'department',
  'employee_group',
  'work_model',
  'work_category',
  'working_hours_agreement',
  'case_state',
  'case_group',
  'customer_group',
  'holiday',
  'pay_type',
  'shift',
  'company',
];

/**
 * The gateway's tools: the company-wide subset of the MCP server's admin
 * tools that needs no identity, with their own titles and descriptions. Not
 * here: whoami, the my_* and team_* tools and register_time (they act as the
 * signed-in person's own Intempus employee, which the host does not know),
 * and prepare_admin_change / commit_prepared_operation (a two-step
 * confirmation the host has no tool for).
 */
const GATEWAY_TOOLS: ReadonlyArray<{
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  /** The first line of a successful result's text. */
  summary: string;
  upstream: readonly GatewayUpstreamOperation[];
  broad?: boolean;
}> = [
  {
    name: 'search_capabilities',
    title: 'Search Intempus capabilities',
    description: 'Find the Intempus tool for cases, work types, employees, time registrations, balances or planning.',
    riskLevel: 'read',
    summary: 'Intempus capabilities.',
    upstream: [],
  },
  {
    name: 'list_cases',
    title: 'List cases',
    description: 'Search cases (projects) by number, name or customer. Only cases open for time registrations unless includeInactive.',
    riskLevel: 'read',
    summary: 'Intempus cases.',
    upstream: [get('/case/')],
  },
  {
    name: 'list_work_types',
    title: 'List work types',
    description:
      'Work types (project hours, holiday, sickness, mileage …): all active ones, or those of one work model or of the work model of one employee.',
    riskLevel: 'read',
    summary: 'Intempus work types.',
    upstream: [get('/work_type/'), get('/employee/{id}/')],
  },
  {
    name: 'list_employees',
    title: 'List employees',
    description: 'Search all employees by name, number, username, initials or email.',
    riskLevel: 'read',
    summary: 'Intempus employees.',
    upstream: [get('/employee/')],
  },
  {
    name: 'get_employee',
    title: 'Get employee',
    description: 'One employee with contracts, approver levels and login access.',
    riskLevel: 'read',
    summary: 'Intempus employee.',
    upstream: [get('/employee/{id}/'), get('/userprofile/')],
  },
  {
    name: 'list_responsibilities',
    title: 'List approvers and responsibilities',
    description: 'Approver levels (second or final) and which employees, departments and cases each approver covers.',
    riskLevel: 'read',
    summary: 'Intempus approvers and responsibilities.',
    upstream: [
      get('/responsible/'),
      get('/responsible_for_employee/'),
      get('/responsible_for_department/'),
      get('/responsible_for_case/'),
      get('/employee/'),
    ],
  },
  {
    name: 'list_work_reports',
    title: 'List time registrations',
    description:
      'Time registrations of any employee in a period (default the last 31 days), optionally by employees, case and approval, with the total.',
    riskLevel: 'read',
    summary: 'Intempus time registrations.',
    upstream: [get('/work_report/')],
  },
  {
    name: 'list_customers',
    title: 'List customers',
    description: 'Search customers by number or name.',
    riskLevel: 'read',
    summary: 'Intempus customers.',
    upstream: [get('/customer/')],
  },
  {
    name: 'list_balances',
    title: 'List balance definitions',
    description: 'Balance definitions (holiday, days off, time bank, sickness …) with unit, period and visibility.',
    riskLevel: 'read',
    summary: 'Intempus balance definitions.',
    upstream: [get('/balance/')],
  },
  {
    name: 'get_employee_balances',
    title: 'Employee balances',
    description:
      'Balances of the given employees (default: every employee with an active contract) up to a date (default today), as Intempus computes them.',
    riskLevel: 'read',
    summary: 'Intempus employee balances.',
    upstream: [get('/employee/'), get('/balance/'), get('/explored_employee_balance/')],
  },
  {
    name: 'list_schedules',
    title: 'List schedules',
    description: 'Planning schedules overlapping a period, optionally for one employee or case.',
    riskLevel: 'read',
    summary: 'Intempus schedules.',
    upstream: [get('/schedule/')],
  },
  {
    name: 'list_planned_work',
    title: 'List planned work',
    description: 'Planned work of any employee in a period (default the next 14 days).',
    riskLevel: 'read',
    summary: 'Intempus planned work.',
    upstream: [get('/planned_work_report/')],
  },
  {
    name: 'list_reference_data',
    title: 'Reference data',
    description:
      'Reference lists: departments, employee groups, work models, work categories, working-hours agreements, case states, case groups, customer groups, holidays, pay types, shifts and the company.',
    riskLevel: 'read',
    summary: 'Intempus reference data.',
    upstream: REFERENCE_RESOURCES.map(resource => get(`/${resource}/`)),
  },
  {
    name: 'get_resource',
    title: 'Read an Intempus resource',
    description:
      'Read-only access to an allowlisted Intempus resource without its own tool (for example historical_work_report, employee_work_type_rule or daily_rest_violation): one object by id, or a list with filters. Passwords and PINs are never returned.',
    riskLevel: 'read',
    summary: 'Intempus resource.',
    upstream: [get('/{resource}/'), get('/{resource}/{id}/')],
    broad: true,
  },
  {
    name: 'manage_work_report',
    title: 'Create or update a time registration',
    description:
      'Register or correct time for any employee. The contract, the locked period (of both the current and the new date), the case and the work type are checked; locked registrations are refused. Deleting is not offered here.',
    riskLevel: 'write',
    summary: 'Intempus time registration saved.',
    upstream: [
      get('/employee/{id}/'),
      get('/work_type/{id}/'),
      get('/case/{id}/'),
      get('/work_report/{id}/'),
      post('/work_report/'),
      patch('/work_report/{id}/'),
    ],
  },
  {
    name: 'manage_case',
    title: 'Create or update a case',
    description:
      'Create or update a case (project). With projectNumber the name becomes "<projectNumber> - <name>". Close a case with active=false or permitNewWorkReports=false. A create is refused when the number or name already exists.',
    riskLevel: 'write',
    summary: 'Intempus case saved.',
    upstream: [get('/case/'), post('/case/'), patch('/case/{id}/'), get('/case/{id}/')],
  },
  {
    name: 'manage_customer',
    title: 'Create or update a customer',
    description: 'Create or update a customer.',
    riskLevel: 'write',
    summary: 'Intempus customer saved.',
    upstream: [get('/company/'), post('/customer/'), patch('/customer/{id}/'), get('/customer/{id}/')],
  },
  {
    name: 'manage_schedule',
    title: 'Create or update a schedule',
    description:
      'Plan work: employees, case, work type, date range, times, weekdays and recurrence. Intempus generates planned work from it. Deleting is not offered here.',
    riskLevel: 'write',
    summary: 'Intempus schedule saved.',
    upstream: [get('/company/'), post('/schedule/'), patch('/schedule/{id}/'), get('/schedule/{id}/')],
  },
  {
    name: 'manage_employee',
    title: 'Create, update or offboard an employee',
    description:
      'create: a new employee, optionally with a first contract (workModelId and contractStartDate). update: change master data. offboard: end open contracts on `date` and revoke logins, which is how an employee is removed. Set username or email to the sign-in address. A password Intempus or this server generates is never returned.',
    riskLevel: 'write',
    summary: 'Intempus employee saved.',
    upstream: [
      get('/employee/'),
      get('/company/'),
      post('/employee/'),
      post('/contract/'),
      get('/employee/{id}/'),
      patch('/employee/{id}/'),
      patch('/contract/{id}/'),
      get('/userprofile/'),
      patch('/userprofile/{id}/'),
    ],
  },
  {
    name: 'manage_contract',
    title: 'Create or update a contract',
    description:
      'Employment contract: work model, working-hours agreement, start and end date, hourly wage. Time can only be registered inside a contract. The locked date (period lock) is not changed here.',
    riskLevel: 'write',
    summary: 'Intempus contract saved.',
    upstream: [post('/contract/'), patch('/contract/{id}/'), get('/contract/{id}/')],
  },
  {
    name: 'manage_user_access',
    title: 'Set login access',
    description: 'Allow or revoke an employee’s login to the Intempus backend and to the approval app.',
    riskLevel: 'write',
    summary: 'Intempus login access saved.',
    upstream: [get('/userprofile/'), post('/userprofile/'), patch('/userprofile/{id}/'), get('/employee/{id}/')],
  },
  {
    name: 'manage_responsibility',
    title: 'Manage approvers and responsibilities',
    description:
      'add_level (employeeId and level) or remove_level (responsibleId): make someone second or final approver, or stop it. assign (responsibleId, targetType, targetId) or unassign (targetType, assignmentId): which employees, departments or cases an approver approves.',
    riskLevel: 'write',
    summary: 'Intempus responsibility saved.',
    upstream: [
      post('/responsible/'),
      del('/responsible/{id}/'),
      post('/responsible_for_employee/'),
      post('/responsible_for_department/'),
      post('/responsible_for_case/'),
      del('/responsible_for_employee/{id}/'),
      del('/responsible_for_department/{id}/'),
      del('/responsible_for_case/{id}/'),
    ],
  },
];

type RegisteredHandler = (input: Record<string, unknown>) => Promise<unknown>;
interface RegisteredTool {
  inputSchema: z.ZodType;
  handler: RegisteredHandler;
}

/** A tool's zod input schema, strict: an unknown field is refused, not dropped. */
function strictSchema(inputSchema: unknown): z.ZodType {
  if (inputSchema instanceof z.ZodObject) {
    return inputSchema.strict();
  }
  if (inputSchema instanceof z.ZodType) {
    return inputSchema;
  }
  return z.strictObject((inputSchema ?? {}) as z.ZodRawShape);
}

/** Who the audit and Intempus creation ids name for gateway calls (the host's caller goes to the audit separately). */
const GATEWAY_ACTOR = 'embedding host';

/**
 * The MCP server's tools as registered for the admin role: the strict zod
 * input schema and the handler bound to `client`. Write tools are always
 * registered; the policy check refuses them unless the host enabled writes.
 */
function registeredTools(client: IntempusClient): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool(name: string, config: { inputSchema?: unknown }, handler: RegisteredHandler): void {
      tools.set(name, { inputSchema: strictSchema(config.inputSchema), handler });
    },
  };
  registerIntempusTools(server as never, client, { roles: ['admin'], actingAs: GATEWAY_ACTOR });
  return tools;
}

/**
 * JSON Schema for a gateway tool, derived from the same zod schema the call
 * is validated with. `format` is dropped: validators such as Ajv reject
 * unknown formats in strict mode, and zod checks the values when the call runs.
 */
function toJsonSchema(schema: z.ZodType): GatewayJsonObject {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, {
    io: 'input',
    override: ctx => {
      delete (ctx.jsonSchema as Record<string, unknown>).format;
    },
  }) as Record<string, unknown>;
  return json as GatewayJsonObject;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

/** The MCP server name of a gateway tool. */
const registeredName = (name: string): string => canonicalToolName(name);

// Schemas only: registration binds the handlers to a client but never calls it.
const schemas = registeredTools(
  new IntempusClient({ username: 'schema-only', apiKey: 'schema-only', fromEnvironment: false, timeoutMs: 1 }),
);

function definition(tool: (typeof GATEWAY_TOOLS)[number]): GatewayToolDefinition {
  const registered = schemas.get(registeredName(tool.name));
  if (!registered) {
    throw new Error(`Intempus gateway tool is not registered: ${tool.name}`);
  }
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    riskLevel: tool.riskLevel,
    enabledByDefault: tool.riskLevel === 'read',
    inputSchema: toJsonSchema(registered.inputSchema),
  };
}

/** All gateway tools, as definitions (names without the `intempus_` prefix). */
export const intempusGatewayTools: GatewayToolDefinition[] = GATEWAY_TOOLS.map(definition);

/**
 * The tool catalog: every gateway tool with its definition, the upstream
 * requests it may make and the broad mark. Generated from the same table as
 * `intempusGatewayTools` and deeply frozen. Hosts can use it to build their
 * own permission model without creating a gateway instance.
 */
export const intempusToolCatalog: readonly GatewayToolCatalogEntry[] = deepFreeze(
  GATEWAY_TOOLS.map(tool => ({
    ...definition(tool),
    upstream: tool.upstream.map(operation => ({ ...operation })),
    broad: tool.broad === true,
  })),
);

/** The MCP server names of the gateway tools. */
const GATEWAY_TOOL_NAMES: readonly string[] = GATEWAY_TOOLS.map(tool => registeredName(tool.name));
const SUMMARIES: ReadonlyMap<string, string> = new Map(GATEWAY_TOOLS.map(tool => [registeredName(tool.name), tool.summary]));
const GATEWAY_NAMES: ReadonlyMap<string, string> = new Map(GATEWAY_TOOLS.map(tool => [registeredName(tool.name), tool.name]));

const MISSING_CREDENTIALS =
  'createIntempusGateway requires options.apiUser and options.apiKey. Embedded instances do not read credentials from the environment.';

function requiredKey(options: IntempusGatewayOptions | undefined): string {
  const value: unknown = options?.apiKey;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GatewayConfigError(MISSING_CREDENTIALS);
  }
  // Key admission (src/key-admission.ts): printable ASCII of 16 characters or more, sharing no piece with any text of
  // ours. Checked before anything is built from the key; the refusal is a fixed text that holds no piece of it.
  if (!admitsKey(value.trim())) {
    throw new GatewayConfigError(keyRefusedText(value.trim()));
  }
  return value.trim();
}

/** The API user: Intempus' user name, case-sensitive, without spaces, control characters or a colon. */
function requiredUser(options: IntempusGatewayOptions): string {
  const value: unknown = options.apiUser;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GatewayConfigError(MISSING_CREDENTIALS);
  }
  const user = value.trim();
  // eslint-disable-next-line no-control-regex
  if (user.length > 254 || /[\s:\u0000-\u001f\u007f]/.test(user)) {
    throw new GatewayConfigError('options.apiUser must be an Intempus user name without spaces or colons.');
  }
  return user;
}

/** The base URL: https on intempus.dk, without credentials, query or fragment. Never quoted in an error. */
function baseUrlOf(options: IntempusGatewayOptions): string {
  const value: unknown = options.baseUrl;
  if (value === undefined) return DEFAULT_BASE_URL;
  let url: URL | undefined;
  try {
    url = typeof value === 'string' ? new URL(value.trim()) : undefined;
  } catch {
    url = undefined;
  }
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.hostname !== INTEMPUS_HOST ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new GatewayConfigError('options.baseUrl must be an https address on intempus.dk.');
  }
  return url.toString();
}

function timeoutOf(options: IntempusGatewayOptions): number {
  const value: unknown = options.timeoutMs;
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 600_000) {
    throw new GatewayConfigError('options.timeoutMs must be a whole number of milliseconds from 1 to 600000.');
  }
  return value;
}

/** A caller or request id from the host: redacted before it is cut short, so no part of a key survives. */
function contextValue(value: unknown, redactor: SecretRedactor): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? redactor.redact(value.trim()).slice(0, 200) : undefined;
}

/**
 * Create one gateway instance. `apiUser` and `apiKey` are required and are
 * the only credentials the instance uses; a missing or refused credential
 * fails here, before anything is built or sent.
 */
export function createIntempusGateway(options: IntempusGatewayOptions) {
  let apiKey: string | undefined;
  let guard: SecretRedactor | undefined;
  // What the host gave, admitted or not: every error is masked against it.
  const given: unknown = (options as Partial<IntempusGatewayOptions> | undefined)?.apiKey;
  const secrets = typeof given === 'string' ? [given, given.trim()] : [];
  try {
    // Admission first, before a redactor is built from the key.
    apiKey = requiredKey(options);
    guard = new SecretRedactor().addSecret(apiKey);
    // The fixed outputs of the sink check (src/fallbacks.ts) must hold no piece of the key.
    if (leaksSecret(fixedOutputs(), guard)) {
      throw new GatewayConfigError(keyRefusedText(apiKey));
    }
    const gateway = buildIntempusGateway(options, apiKey, guard);
    // The tool list leaves the gateway as it is: a key that shares a piece with it is refused.
    if (leaksSecret(gateway.tools, guard)) {
      throw new GatewayConfigError(keyRefusedText(apiKey));
    }
    return gateway;
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (guard && apiKey !== undefined) {
      // Redacted, then checked whole as the very last step: a message that still holds a piece of the key becomes
      // the fixed refusal.
      message = guard.redact(message);
      if (leaksSecret(message, guard)) message = keyRefusedText(apiKey);
    }
    // A fresh error in final form (src/key-admission.ts, sealedError): no cause, a stack without frames, and name,
    // message and stack masked against the key. Then the sink check on the finished object.
    const final = sealedError(new GatewayConfigError(message), ...secrets);
    if (guard && apiKey !== undefined && leaksSecret(final, guard)) {
      throw sealedError(new GatewayConfigError(keyRefusedText(apiKey)), ...secrets);
    }
    throw final;
  }
}

function buildIntempusGateway(options: IntempusGatewayOptions, apiKey: string, redactor: SecretRedactor) {
  const apiUser = requiredUser(options);
  const baseUrl = baseUrlOf(options);
  const timeoutMs = timeoutOf(options);
  // Always a resolved policy, so a gateway call never falls back to the environment.
  const policy: ResolvedInstancePolicy = resolveInstancePolicy(options.policy ?? {}, GATEWAY_TOOL_NAMES);
  const client = new IntempusClient({
    username: apiUser,
    apiKey,
    baseUrl,
    timeoutMs,
    fromEnvironment: false,
    ...(typeof options.fetchImpl === 'function' ? { fetchImpl: options.fetchImpl } : {}),
    ...(typeof options.maxRetryAfterSeconds === 'number' ? { maxRetryAfterSeconds: options.maxRetryAfterSeconds } : {}),
  });
  const handlers = registeredTools(client);
  const offeredTools: ReadonlySet<string> = new Set(GATEWAY_TOOL_NAMES.filter(name => !policy.disabledTools.has(name)));

  return {
    /** Tools enabled on this instance (tools the host's policy disables are left out). */
    tools: intempusGatewayTools.filter(tool => !policy.disabledTools.has(registeredName(tool.name))),
    callTool(toolName: string, input: GatewayJsonObject = {}, context?: GatewayCallContext): Promise<GatewayToolResult> {
      // Every call in a scope of its own.
      return runInCallScope(
        {
          policy,
          redactor,
          caller: contextValue(context?.caller, redactor),
          // Our own id for the call: the host's request id is its text, and is not written to the audit.
          requestId: randomUUID(),
          offeredTools,
        },
        // A successful result is already redacted as data by normalizeResult, and its JSON text is built from that
        // data. An error result is our own text, and is redacted as a whole.
        () =>
          runCall(toolName, input).then(result => {
            const final = result.isError ? (redactDeep(result, redactor) as GatewayToolResult) : result;
            // The sink check, as the very last step: a result that holds a piece of the key anywhere, outer fields
            // and the JSON text included, is withheld whole.
            return leaksSecret(final, redactor) ? withheldResult() : final;
          }),
      );
    },
  };

  async function runCall(toolName: string, input: GatewayJsonObject): Promise<GatewayToolResult> {
    try {
      const name = typeof toolName === 'string' ? canonicalToolName(toolName) : '';
      const tool = GATEWAY_TOOL_NAMES.includes(name) ? handlers.get(name) : undefined;
      if (!tool) {
        // Neither the audit record nor the answer repeats the name: it is the caller's text, not ours.
        await writeAuditEvent({ tool: UNKNOWN_TOOL, action: 'rejected', reason: 'unsupported tool' });
        return errorResult('Unsupported Intempus gateway tool.');
      }

      const parsed = tool.inputSchema.safeParse(input ?? {});
      if (!parsed.success) {
        await writeAuditEvent({ tool: name, action: 'rejected', reason: 'invalid input' });
        const short = GATEWAY_NAMES.get(name) ?? name;
        return errorResult(redactSecrets(`Invalid input for ${short}: ${z.prettifyError(parsed.error)}`));
      }

      const result = await tool.handler(parsed.data as Record<string, unknown>);
      return normalizeResult(result, redactor, SUMMARIES.get(name) ?? 'Intempus gateway result.');
    } catch (error) {
      // Our own words only (src/errors.ts, gatewayErrorText): never the text of an Intempus answer.
      return errorResult(redactSecrets(gatewayErrorText(error)));
    }
  }
}

/** The audit's tool for a call to a tool this gateway does not have. */
const UNKNOWN_TOOL = 'unknown_tool';

/** Values nested deeper than this are replaced by redactDeep, never passed on. */
const MAX_REDACT_DEPTH = 64;

/**
 * Field names whose value is a credential whatever it looks like: the value of
 * such a field is replaced whole, not only when it matches a pattern. Intempus
 * rows carry password, current_password and pin; the MCP server already
 * strips them from the rows it returns.
 */
const CREDENTIAL_NAME =
  /^x?(authorization|proxyauthorization|cookie|setcookie|(access|refresh|id|session|bearer|auth|api|private|secret|subscription|webhook)(token|key|secret)|token|apisecret|clientsecret|secret|\w*password|passwd|passcode|pin|pincode|credentials?)$/;

/**
 * Whether a field name names a credential, however it is written: case, `-`,
 * `_`, spaces and a leading `x-` do not matter (`api_key`, `X-Api-Key`,
 * `current_password`, `PIN`).
 */
function isCredentialField(name: string): boolean {
  return CREDENTIAL_NAME.test(name.toLowerCase().replace(/[-_\s.]/g, ''));
}

/** One text as a gateway may return it: credential patterns and the instance's key, until nothing changes. */
function redactText(value: string, redactor: SecretRedactor): string {
  let result = redactSecrets(value);
  for (let round = 0; round < 4; round += 1) {
    const next = redactSecrets(redactor.redact(result));
    if (next === result) break;
    result = next;
  }
  return result;
}

/**
 * A copy of a JSON value with every string, object keys included, passed
 * through the credential patterns and the redactor, the value of every
 * credential-named field (isCredentialField) replaced whole, whatever its
 * type, and every number or boolean whose string form would be redacted
 * replaced by the string "‹redacted›". Anything nested deeper than
 * MAX_REDACT_DEPTH is replaced, never passed on.
 */
function redactDeep(value: unknown, redactor: SecretRedactor, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    return '[nested too deep]';
  }
  if (typeof value === 'string') {
    return redactText(value, redactor);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    // The string form of a primitive is checked too; a match becomes the string "‹redacted›", so JSON stays valid.
    const text = String(value);
    if (redactText(text, redactor) !== text) return REDACTION_MARKER;
    return typeof value === 'bigint' ? text : value;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const json = (value as { toJSON?: unknown }).toJSON;
  if (typeof json === 'function') {
    return redactDeep(json.call(value), redactor, depth + 1);
  }
  if (Array.isArray(value)) {
    return value.map(entry => redactDeep(entry, redactor, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      redactText(key, redactor),
      // The whole value of a credential-named field, whatever its type: a list or an object under it is a credential too.
      isCredentialField(key) && entry !== null && entry !== undefined ? REDACTION_MARKER : redactDeep(entry, redactor, depth + 1),
    ]),
  );
}

/** One gateway instance, as returned by createIntempusGateway. */
export type IntempusGateway = ReturnType<typeof createIntempusGateway>;

/**
 * The handler's result as the gateway returns it. The handler's text is
 * never kept: its data is parsed, redacted twice (values, keys and numbers by
 * their string form), and only then serialised again after the summary, so a
 * key cannot survive in an escaped form.
 */
function normalizeResult(result: unknown, redactor: SecretRedactor, summary: string): GatewayToolResult {
  const content = (result as { content?: unknown } | null)?.content;
  const text = Array.isArray(content) ? (content[0] as { text?: unknown } | undefined)?.text : undefined;
  let data: unknown = null;
  if (typeof text === 'string') {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      // Every handler answers with JSON; anything else is not passed on.
      return errorResult(GATEWAY_FAILED_TEXT);
    }
  }
  // Twice: the second pass, the last step, also covers what the first inserted (the depth placeholder).
  return jsonResult(summary, redactDeep(redactDeep(data, redactor), redactor));
}

/**
 * The summary, then the same (already redacted) data as compact JSON in the text block, as the MCP spec asks of a
 * tool that returns structured content: many clients read only the text. The text holds exactly
 * `structuredContent`, and the sink check in callTool covers it.
 */
function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  const data = JSON.parse(JSON.stringify(structuredContent ?? null)) as GatewayJsonValue;
  return {
    content: [{ type: 'text', text: `${text}\n\n${JSON.stringify(data)}` }],
    structuredContent: data,
  };
}

function errorResult(text: string): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}
