import { readFileSync } from 'node:fs';
import { idFromUri, type IntempusClient, type IntempusObject } from './client.js';

export interface ContractSummary {
  id: number;
  uri: string;
  startDate: string | null;
  endDate: string | null;
  lockedDate: string | null;
  workModelUri: string | null;
  workModelId?: number;
  workModelName?: string;
}

export interface ResolvedEmployee {
  employeeId: number;
  uri: string;
  number: string;
  name: string;
  username?: string;
  email?: string;
  departmentUri?: string;
  matchedBy: 'identity_map' | 'username' | 'email';
  contracts: ContractSummary[];
}

const CACHE_TTL_MS = 60_000;
const employeeCache = new Map<string, { at: number; rows: Promise<IntempusObject[]> }>();

/**
 * All employees, cached briefly per API base URL. Intempus does not allow
 * filtering employees on email ("The 'email' field does not allow
 * filtering", verified 2026-09-29) and username has no case-insensitive
 * filter, so identity is matched in memory. Companies here are small.
 */
export async function listEmployeesCached(client: IntempusClient): Promise<IntempusObject[]> {
  const key = client.baseUrl;
  const hit = employeeCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.rows;
  }
  const rows = client.listAll<IntempusObject>('employee/', {}, 10_000).then(result => result.items);
  employeeCache.set(key, { at: Date.now(), rows });
  rows.catch(() => employeeCache.delete(key));
  return rows;
}

export function clearEmployeeCache(): void {
  employeeCache.clear();
}

/**
 * Explicit Entra UPN → Intempus employee number overrides, for employees
 * whose Intempus username/email is not their UPN (many have a private
 * email in Intempus). INTEMPUS_IDENTITY_MAP holds inline JSON, or
 * INTEMPUS_IDENTITY_MAP_PATH points at a JSON file:
 *   { "jane@onedanmark.dk": "1001" }
 */
export function identityMap(): Map<string, string> {
  const raw = process.env.INTEMPUS_IDENTITY_MAP
    ?? (process.env.INTEMPUS_IDENTITY_MAP_PATH ? readFileSync(process.env.INTEMPUS_IDENTITY_MAP_PATH, 'utf8') : undefined);
  const map = new Map<string, string>();
  if (!raw) return map;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('INTEMPUS_IDENTITY_MAP is not valid JSON (expected {"upn": "employee number"}).');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('INTEMPUS_IDENTITY_MAP must be a JSON object {"upn": "employee number"}.');
  }
  for (const [upn, number] of Object.entries(parsed as Record<string, unknown>)) {
    map.set(upn.trim().toLowerCase(), String(number).trim());
  }
  return map;
}

/**
 * Resolve the gateway-verified user (UPN) to exactly one Intempus
 * employee: explicit identity map first, then username, then work email —
 * all case-insensitive. Zero or several matches fail closed; the private
 * `personal_email` field is never used for matching.
 */
export async function resolveEmployee(client: IntempusClient, upn: string): Promise<ResolvedEmployee> {
  const wanted = upn.trim().toLowerCase();
  if (!wanted) {
    throw new Error('Empty user identity; the gateway must forward the verified user (X-MCP-User).');
  }
  const employees = await listEmployeesCached(client);

  const mappedNumber = identityMap().get(wanted);
  if (mappedNumber !== undefined) {
    const matches = employees.filter(row => String(row.number ?? '') === mappedNumber);
    return pickOne(client, upn, matches, 'identity_map', `employee number ${mappedNumber} from INTEMPUS_IDENTITY_MAP`);
  }

  const byUsername = employees.filter(row => lower(row.username) === wanted);
  if (byUsername.length > 0) {
    return pickOne(client, upn, byUsername, 'username', 'Intempus username');
  }

  const byEmail = employees.filter(row => lower(row.email) === wanted);
  return pickOne(client, upn, byEmail, 'email', 'Intempus work email');
}

function pickOne(
  client: IntempusClient,
  upn: string,
  matches: IntempusObject[],
  matchedBy: ResolvedEmployee['matchedBy'],
  source: string,
): ResolvedEmployee {
  if (matches.length === 0) {
    throw new Error(
      `No Intempus employee matches ${upn}. An administrator must set the employee's Intempus username or work email to ` +
        'this sign-in address (or add it to INTEMPUS_IDENTITY_MAP) before self-service tools work.',
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} Intempus employees match ${upn} by ${source}; refusing to guess. An administrator must make it unique.`,
    );
  }
  const row = matches[0]!;
  const employeeId = Number(row.id);
  return {
    employeeId,
    uri: typeof row.resource_uri === 'string' ? row.resource_uri : client.uri('employee', employeeId),
    number: String(row.number ?? ''),
    name: String(row.name ?? ''),
    username: typeof row.username === 'string' && row.username ? row.username : undefined,
    email: typeof row.email === 'string' && row.email ? row.email : undefined,
    departmentUri: typeof row.department === 'string' ? row.department : undefined,
    matchedBy,
    contracts: contractsOf(row),
  };
}

export function contractsOf(employee: IntempusObject): ContractSummary[] {
  const raw = Array.isArray(employee.contract) ? (employee.contract as IntempusObject[]) : [];
  return raw
    .filter(contract => contract && typeof contract === 'object')
    .map(contract => {
      const workModelId = idFromUri(contract.work_model);
      const ref = contract.work_model;
      const workModelUri =
        typeof ref === 'string' ? ref : ref && typeof ref === 'object' ? String((ref as { resource_uri?: unknown }).resource_uri ?? '') || null : null;
      return {
        id: Number(contract.id),
        uri: String(contract.resource_uri ?? ''),
        startDate: (contract.start_date as string | null) ?? null,
        endDate: (contract.end_date as string | null) ?? null,
        lockedDate: (contract.locked_date as string | null) ?? null,
        workModelUri,
        workModelId,
        workModelName: typeof contract.work_model_name === 'string' ? contract.work_model_name : undefined,
      };
    });
}

/** The contract covering `date` (YYYY-MM-DD), if any. */
export function contractOn(contracts: ContractSummary[], date: string): ContractSummary | undefined {
  return contracts.find(
    contract => (!contract.startDate || contract.startDate <= date) && (!contract.endDate || contract.endDate >= date),
  );
}

function lower(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined;
}
