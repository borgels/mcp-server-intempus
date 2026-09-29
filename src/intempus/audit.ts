import { createHash, randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { formatUnknownError } from '../errors.js';

export interface IntempusAuditEvent {
  requestId?: string;
  actingAs?: string;
  profile?: string;
  tool: string;
  action: 'start' | 'finish' | 'error' | 'policy_denied';
  target?: unknown;
  status?: string;
  reason?: string;
  error?: unknown;
  /** Prepared-operation hash, so a commit can be tied to its prepare. */
  operationHash?: string;
}

/**
 * Intempus' own history records every change as the API user, so this log
 * is what ties a change to the Entra user who actually made it. Arguments
 * are hashed, never stored.
 */
export async function writeAuditEvent(event: IntempusAuditEvent): Promise<void> {
  const auditPath = process.env.INTEMPUS_AUDIT_LOG;
  if (!auditPath) {
    return;
  }

  const record = {
    timestamp: new Date().toISOString(),
    requestId: event.requestId ?? randomUUID(),
    actingAs: event.actingAs,
    profile: event.profile,
    tool: event.tool,
    action: event.action,
    targetHash: event.target === undefined ? undefined : hashValue(JSON.stringify(event.target)),
    operationHash: event.operationHash,
    status: event.status,
    reason: event.reason,
    error: event.error === undefined ? undefined : formatUnknownError(event.error),
  };

  await appendFile(auditPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
