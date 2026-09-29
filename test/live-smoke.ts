/**
 * Read-only smoke test against the real Intempus API.
 *
 *   INTEMPUS_API_USER=… INTEMPUS_API_KEY=… INTEMPUS_PROFILE=employee|approver|admin \
 *   SMOKE_USER=<upn> npm run smoke:live
 *
 * Calls only read tools; writes stay disabled (INTEMPUS_ENABLE_WRITES is
 * forced off) so nothing in Intempus changes.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

process.env.INTEMPUS_ENABLE_WRITES = 'false';

const READ_CALLS: Record<string, Array<[string, Record<string, unknown>]>> = {
  employee: [
    ['intempus_whoami', {}],
    ['intempus_get_my_profile', {}],
    ['intempus_list_cases', {}],
    ['intempus_list_work_types', {}],
    ['intempus_list_my_work_reports', {}],
    ['intempus_get_my_balances', {}],
    ['intempus_get_my_planning', {}],
  ],
  approver: [
    ['intempus_whoami', {}],
    ['intempus_list_team', {}],
    ['intempus_list_team_work_reports', { status: 'all' }],
    ['intempus_get_team_balances', {}],
  ],
  admin: [
    ['intempus_whoami', {}],
    ['intempus_list_employees', {}],
    ['intempus_list_responsibilities', {}],
    ['intempus_list_work_reports', { from: '2026-01-01' }],
    ['intempus_list_balances', {}],
    ['intempus_get_employee_balances', {}],
    ['intempus_list_reference_data', { kind: 'work_models' }],
    ['intempus_list_schedules', {}],
    ['intempus_get_resource', { resource: 'historical_work_report', limit: 2 }],
  ],
};

async function main(): Promise<void> {
  const profile = process.env.INTEMPUS_PROFILE ?? 'employee';
  const server = createServer({ onBehalfOf: process.env.SMOKE_USER });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'live-smoke', version: '0.0.0' });
  await client.connect(clientTransport);

  const tools = await client.listTools();
  console.log(`profile=${profile} tools=${tools.tools.length}`);

  let failures = 0;
  for (const [name, args] of READ_CALLS[profile] ?? []) {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    const ok = !result.isError;
    if (!ok) failures += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${summarize(text)}`);
  }
  await client.close();
  process.exit(failures ? 1 : 0);
}

/** Shape only — counts and keys, never names or other personal data. */
function summarize(text: string): string {
  try {
    const value = JSON.parse(text) as unknown;
    if (Array.isArray(value)) return `[${value.length} items]`;
    if (value && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>)
        .map(([key, nested]) => (Array.isArray(nested) ? `${key}[${nested.length}]` : typeof nested === 'number' || typeof nested === 'boolean' ? `${key}=${String(nested)}` : key))
        .join(' ');
    }
    return String(value);
  } catch {
    return text.slice(0, 200);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
