import { currentRedactor } from './intempus/call-scope.js';

const SECRET_PATTERNS = [
  /authorization:\s*(apikey|basic|bearer)\s*[^,\s}]+/gi,
  /apikey\s+[^\s:,"']+:[A-Za-z0-9]+/gi,
  /(INTEMPUS_API_KEY|api_key|apiKey|password)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
];

/**
 * An error in our own words, thrown by this server's checks (missing fields,
 * locked periods, duplicates, invalid parameters). Its message is built only
 * from fixed text, numbers and the caller's own input, never from text that
 * Intempus returned, so the gateway passes it on (redacted) to the host.
 */
export class IntempusToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntempusToolError';
  }
}

export interface IntempusHttpErrorInput {
  status: number;
  url: string;
  payload?: unknown;
  retryAfter?: string;
  fallbackMessage?: string;
  /**
   * False for a gateway instance: the message is only the status, our own hint for it and a parsed Retry-After
   * (see gatewayHttpErrorText), and no payload is kept. Default true (the MCP server, which shows Intempus'
   * validation messages so a failed write says what to fix).
   */
  detail?: boolean;
  /** Index into KNOWN_PROBLEMS of a validation message Intempus returned (gateway only). */
  knownProblem?: number;
}

export class IntempusHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly payload?: unknown;
  readonly retryAfter?: string;
  /** Index into KNOWN_PROBLEMS, when the error came from a gateway instance and matched one. */
  readonly knownProblem?: number;

  constructor(input: IntempusHttpErrorInput) {
    const detail = input.detail !== false;
    super(
      detail
        ? formatIntempusHttpError(input)
        : gatewayHttpErrorText(input.status, parseRetryAfter(input.retryAfter), input.knownProblem),
    );
    this.name = 'IntempusHttpError';
    this.status = input.status;
    this.url = detail ? redactSecrets(input.url) : describeUrl(input.url);
    if (detail) this.payload = input.payload;
    this.retryAfter = detail ? input.retryAfter : parseRetryAfter(input.retryAfter);
    if (!detail && isKnownProblem(input.knownProblem)) {
      this.knownProblem = input.knownProblem;
    }
  }
}

/**
 * Validation messages Intempus is known to answer with (HTTP 400), each with
 * our own text. A gateway instance looks for these phrases in a 400 body,
 * keeps only the index of the first one found and discards the body: nothing
 * Intempus wrote reaches the host, only the text in the second column.
 */
export const KNOWN_PROBLEMS: ReadonlyArray<readonly [phrase: string, text: string]> = [
  ['skal tilhøre samme arbejdsmodel', 'The work type does not belong to the work model of the employee’s contract.'],
  ['skal være tilknyttet et projekt', 'This work type is project work and needs a case.'],
  ['sluttid skal være angivet', 'This work type needs a start and an end time.'],
  ['does not allow filtering', 'Intempus does not allow filtering on one of the given fields.'],
];

function isKnownProblem(index: number | undefined): index is number {
  return index !== undefined && Number.isInteger(index) && index >= 0 && index < KNOWN_PROBLEMS.length;
}

/** Our own guidance per HTTP status, for a gateway instance. */
const GATEWAY_STATUS_HINTS: Readonly<Record<number, string>> = {
  400: 'Intempus refused the request as invalid. Check the ids, dates and required fields.',
  401: 'Intempus refused the API user or key, or the API user may not do this.',
  403: 'The Intempus API user has no access to this.',
  404: 'Intempus found nothing at this address, or the API user cannot see it. Check the ids.',
  405: 'Intempus does not allow this operation on this kind of data.',
  409: 'Intempus reported a conflict with existing data.',
  429: 'Intempus is throttling requests (the limit is shared by every integration using this API user). Wait and retry.',
  500: 'Intempus failed with an internal error. Retry later.',
  502: 'Intempus is not reachable right now. Retry later.',
  503: 'Intempus is not reachable right now. Retry later.',
  504: 'Intempus did not answer in time. Retry later.',
};

/** The redirect hint: a gateway never follows a redirect, and never quotes its Location. */
const GATEWAY_REDIRECT_HINT = 'Intempus answered with a redirect, which is not followed.';

/**
 * The text of an HTTP error from a gateway instance: the status, our own hint
 * (or our text for a known validation message) and the parsed Retry-After.
 * Always starts with "Intempus API request failed with HTTP <status>".
 */
export function gatewayHttpErrorText(status: number, retryAfter?: string, knownProblem?: number): string {
  const code = Number.isInteger(status) ? status : 0;
  const hint = isKnownProblem(knownProblem)
    ? KNOWN_PROBLEMS[knownProblem]![1]
    : Object.hasOwn(GATEWAY_STATUS_HINTS, code)
      ? GATEWAY_STATUS_HINTS[code]
      : code >= 300 && code < 400
        ? GATEWAY_REDIRECT_HINT
        : undefined;
  return [`Intempus API request failed with HTTP ${code}`, hint, retryAfter === undefined ? undefined : `retry-after=${retryAfter}`]
    .filter(Boolean)
    .join(' | ');
}

/** Fixed texts for failures that are not an HTTP answer. */
export const GATEWAY_TIMEOUT_TEXT = 'Intempus did not answer within the time limit. Retry later.';
export const GATEWAY_NETWORK_TEXT = 'Intempus could not be reached.';
export const GATEWAY_FAILED_TEXT = 'The Intempus call failed.';

/** System error codes a network failure may be named by; any other code is not repeated. */
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

/**
 * The text a gateway returns for an error: our own words only. An HTTP error
 * is its status and fixed hint; one of this server's own checks
 * (IntempusToolError) keeps its message; a timeout or network failure is a
 * fixed text (with a system error code from a fixed list); anything else is
 * a fixed text. The message of any other error is never used: it can carry
 * text Intempus controls.
 */
export function gatewayErrorText(error: unknown): string {
  if (error instanceof IntempusHttpError) {
    return gatewayHttpErrorText(error.status, parseRetryAfter(error.retryAfter), error.knownProblem);
  }
  if (error instanceof IntempusToolError) {
    return error.message;
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return GATEWAY_TIMEOUT_TEXT;
  }
  if (error instanceof TypeError) {
    const code = (error.cause as { code?: unknown } | undefined)?.code;
    return typeof code === 'string' && NETWORK_CODES.has(code) ? `${GATEWAY_NETWORK_TEXT} (${code})` : GATEWAY_NETWORK_TEXT;
  }
  return GATEWAY_FAILED_TEXT;
}

/**
 * The audit's code for an error: the HTTP status of an Intempus error, `timeout`, `refused` (one of our own checks)
 * or `error`. Only codes from this fixed set are written; the error's message never is.
 */
export function auditErrorCode(error: unknown): string {
  if (error instanceof IntempusHttpError && Number.isInteger(error.status)) return `http_${error.status}`;
  if (error instanceof IntempusToolError) return 'refused';
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timeout';
  return 'error';
}

/** Retry-After as whole seconds ("12s") or a normalised HTTP date; anything else is dropped. */
export function parseRetryAfter(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\d{1,9}s?$/.test(trimmed)) return `${Number(trimmed.replace(/s$/, ''))}s`;
  if (trimmed.length > 64) return undefined;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? new Date(ms).toUTCString() : undefined;
}

/** Origin and path of a URL, without query string or fragment. */
export function describeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }

  return redactSecrets(String(error));
}

export function redactSecrets(value: string): string {
  const patterned = SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        const separator = /^apikey\s/i.test(match) ? ' ' : match.includes(':') ? ':' : '=';
        const key = match.split(separator)[0]?.trim() ?? 'secret';
        return `${key}${separator} [REDACTED]`;
      }),
    value,
  );
  // Inside a gateway call also the key of that instance (src/intempus/call-scope.ts).
  return currentRedactor()?.redact(patterned) ?? patterned;
}

function formatIntempusHttpError(input: {
  status: number;
  url: string;
  payload?: unknown;
  retryAfter?: string;
  fallbackMessage?: string;
}): string {
  const details = problems(input.payload);
  const parts = [
    `Intempus API request failed with HTTP ${input.status}`,
    ...details,
    // A bare 401 is bad credentials; a 401 with a reason is a feature/permission refusal.
    input.status === 401 && details.length === 0 ? 'check INTEMPUS_API_USER (case-sensitive) and INTEMPUS_API_KEY' : undefined,
    input.retryAfter ? `retry-after=${input.retryAfter}s` : undefined,
    input.fallbackMessage,
  ].filter(Boolean);

  return redactSecrets(parts.join(' | '));
}

/**
 * Tastypie answers in several shapes — {"error": "…"}, {"error": ["…"]},
 * and validation errors keyed by resource then field:
 * {"work_report": {"amount": ["…"]}}. All are flattened to readable
 * "field: message" lines so a failed write says what to fix.
 */
function problems(payload: unknown, prefix = '', depth = 0): string[] {
  if (payload === null || payload === undefined || depth > 3) return [];
  if (typeof payload === 'string') {
    // HTML error pages (500s) are noise; keep only short plain-text bodies.
    return payload.length > 0 && payload.length <= 300 && !payload.trimStart().startsWith('<')
      ? [`${prefix}${payload}`]
      : [];
  }
  if (Array.isArray(payload)) {
    return payload.flatMap(item => problems(item, prefix, depth + 1));
  }
  if (typeof payload === 'object') {
    return Object.entries(payload as Record<string, unknown>).flatMap(([key, value]) => {
      if (key === 'traceback') return [];
      const label = key === 'error' || key === 'error_message' || key === '__all__' ? prefix : `${prefix}${key}: `;
      return problems(value, label, depth + 1);
    });
  }
  return [`${prefix}${String(payload)}`];
}
