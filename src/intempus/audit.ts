import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { auditErrorCode, redactSecrets } from '../errors.js';
import { withheldAuditRecord } from '../fallbacks.js';
import { leaksSecret } from '../key-admission.js';
import { currentCallContext, currentInstancePolicy, currentRedactor } from './call-scope.js';

export interface IntempusAuditEvent {
  requestId?: string;
  actingAs?: string;
  profile?: string;
  tool: string;
  action: 'start' | 'finish' | 'error' | 'policy_denied' | 'rejected';
  target?: unknown;
  status?: string;
  reason?: string;
  error?: unknown;
  /** Prepared-operation hash, so a commit can be tied to its prepare. */
  operationHash?: string;
}

/** The key of the caller pseudonyms: random per process, never written anywhere. */
const CALLER_KEY = randomBytes(32);

/** The caller as `hmac:` and 16 hex characters: the same caller gives the same pseudonym within the process. */
export function callerPseudonym(caller: string | undefined): string | undefined {
  if (caller === undefined || caller === '') return undefined;
  return `hmac:${createHmac('sha256', CALLER_KEY).update(caller, 'utf8').digest('hex').slice(0, 16)}`;
}

/**
 * Intempus' own history records every change as the API user, so this log
 * is what ties a change to the signed-in user who actually made it. Arguments
 * are hashed, never stored, and an error is written as a fixed code (the HTTP
 * status, `timeout`, `refused` or `error`), never as its message.
 *
 * Outside a gateway call the record is appended to INTEMPUS_AUDIT_LOG (no-op
 * when unset). Inside one it goes to the host policy's `audit` sink instead
 * (no-op without one), INTEMPUS_AUDIT_LOG is not read, the caller is written
 * only as a pseudonym, and the record is redacted with the instance's key and
 * checked at the sink: a record that still holds a piece of the key is
 * replaced by a fixed one.
 *
 * A failing sink or file throws, so a tool whose start record cannot be
 * written does not run.
 */
export async function writeAuditEvent(event: IntempusAuditEvent): Promise<void> {
  const hosted = currentInstancePolicy();
  const sink = hosted?.audit;
  const auditPath = hosted ? undefined : process.env.INTEMPUS_AUDIT_LOG;
  if (!sink && !auditPath) {
    return;
  }

  const context = currentCallContext();
  const record = {
    timestamp: new Date().toISOString(),
    requestId: event.requestId ?? context.requestId ?? randomUUID(),
    ...(hosted ? { caller: callerPseudonym(context.caller) } : { actingAs: event.actingAs }),
    profile: event.profile,
    tool: event.tool,
    action: event.action,
    targetHash: event.target === undefined ? undefined : hashValue(JSON.stringify(event.target) ?? ''),
    operationHash: event.operationHash,
    status: event.status,
    reason: event.reason,
    error: event.error === undefined ? undefined : auditErrorCode(event.error),
  };
  // Every string redacted (credential patterns, and inside a gateway call the instance's key), then copied through
  // JSON: plain data, without undefined fields.
  const safe = JSON.parse(
    JSON.stringify(record, (_key, value: unknown) => (typeof value === 'string' ? redactSecrets(value) : value)),
  ) as Record<string, unknown>;

  // The sink check (src/key-admission.ts) on the record and the line in their final form.
  const redactor = currentRedactor();
  const leaks = (value: unknown) => redactor !== undefined && leaksSecret(value, redactor);
  if (sink) {
    await sink(leaks(safe) ? withheldAuditRecord() : safe);
  } else if (auditPath) {
    const line = JSON.stringify(safe);
    await appendFile(auditPath, `${leaks(line) ? JSON.stringify(withheldAuditRecord()) : line}\n`, 'utf8');
  }
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
