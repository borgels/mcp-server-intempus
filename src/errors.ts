const SECRET_PATTERNS = [
  /authorization:\s*(apikey|basic|bearer)\s*[^,\s}]+/gi,
  /apikey\s+[^\s:,"']+:[A-Za-z0-9]+/gi,
  /(INTEMPUS_API_KEY|api_key|apiKey|password)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
];

export class IntempusHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly payload?: unknown;
  readonly retryAfter?: string;

  constructor(input: { status: number; url: string; payload?: unknown; retryAfter?: string; fallbackMessage?: string }) {
    super(formatIntempusHttpError(input));
    this.name = 'IntempusHttpError';
    this.status = input.status;
    this.url = redactSecrets(input.url);
    this.payload = input.payload;
    this.retryAfter = input.retryAfter;
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }

  return redactSecrets(String(error));
}

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        const separator = /^apikey\s/i.test(match) ? ' ' : match.includes(':') ? ':' : '=';
        const key = match.split(separator)[0]?.trim() ?? 'secret';
        return `${key}${separator} [REDACTED]`;
      }),
    value,
  );
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
