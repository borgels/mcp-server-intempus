import { readEnvInteger } from '../config-env.js';
import { IntempusHttpError, IntempusToolError, KNOWN_PROBLEMS, requestIdFrom } from '../errors.js';

export interface IntempusClientOptions {
  username?: string;
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Longest Retry-After (seconds) the client waits out once before failing. Default 10. */
  maxRetryAfterSeconds?: number;
  /**
   * False for a gateway instance: no INTEMPUS_* variable is read (omitted options take their defaults), and an
   * error response is not read into the error (only its status, our own hint and a parsed Retry-After; a 400 body is
   * only compared with a fixed list of known validation messages, see KNOWN_PROBLEMS). Default true.
   */
  fromEnvironment?: boolean;
}

export type QueryValue = string | number | boolean | null | undefined | ReadonlyArray<string | number>;
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ListMeta {
  limit?: number;
  next?: string | null;
  previous?: string | null;
  offset?: number;
  total_count?: number;
}

export interface ListResponse<T> {
  meta?: ListMeta;
  objects: T[];
}

export type IntempusObject = Record<string, unknown> & { id?: number; resource_uri?: string };

export interface ListAllResult<T> {
  items: T[];
  /** True when more rows existed than maxItems allowed. */
  truncated: boolean;
  totalCount?: number;
}

export const DEFAULT_BASE_URL = 'https://intempus.dk/web/v1';
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Resources that reject cursor pagination (verified); each client learns more at runtime. */
const OFFSET_ONLY_RESOURCES: readonly string[] = ['explored_employee_balance', 'schedule'];

/** Bytes of a 400 body a gateway instance compares with KNOWN_PROBLEMS; the rest is discarded. */
const MAX_PROBLEM_BODY_BYTES = 16 * 1024;

/**
 * Client for the Intempus REST API (Django + tastypie).
 *
 * Auth is `Authorization: ApiKey <username>:<key>`. The key belongs to an
 * Intempus user and every call runs with that user's rights; the username
 * is case-sensitive (verified 2026-09-29: "User@…" works, "user@…" is 401).
 *
 * Relations travel as resource URIs ("/web/v1/employee/12/"); `path()`
 * accepts either a relative resource path ("employee/12/") or such a URI.
 * Rate limit is 500 req/min per Intempus user — shared with every other
 * integration using the same key — so a 429 with a short Retry-After is
 * waited out once instead of failing the tool call.
 */
export class IntempusClient {
  private readonly username?: string;
  private readonly apiKey?: string;
  readonly baseUrl: string;
  /** Path prefix of resource URIs, e.g. "/web/v1/". */
  readonly uriPrefix: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetryAfterSeconds: number;
  /** False for a gateway instance (see IntempusClientOptions.fromEnvironment). */
  private readonly errorDetail: boolean;
  /** Resources this client pages by offset; per client, so nothing is shared between instances. */
  private readonly offsetOnly = new Set(OFFSET_ONLY_RESOURCES);

  constructor(options: IntempusClientOptions = {}) {
    const env = options.fromEnvironment === false ? {} : process.env;
    this.errorDetail = options.fromEnvironment !== false;
    this.username = options.username ?? env.INTEMPUS_API_USER;
    this.apiKey = options.apiKey ?? env.INTEMPUS_API_KEY;
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? env.INTEMPUS_BASE_URL ?? DEFAULT_BASE_URL);
    assertSafeBaseUrl(this.baseUrl);
    this.uriPrefix = `${new URL(this.baseUrl).pathname.replace(/\/+$/, '')}/`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs =
      options.timeoutMs ??
      (options.fromEnvironment === false
        ? DEFAULT_TIMEOUT_MS
        : readEnvInteger('INTEMPUS_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, { min: 1, max: 600_000 }));
    this.maxRetryAfterSeconds = options.maxRetryAfterSeconds ?? 10;
  }

  async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('GET', path, query);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, undefined, body);
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, undefined, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  async send<T>(method: HttpMethod, path: string, body?: unknown, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>(method, path, query, body);
  }

  /**
   * Read a list endpoint to the end (or maxItems), following meta.next.
   * Cursor pagination is Intempus' recommended mode; offset paging is
   * deprecated.
   */
  async listAll<T = IntempusObject>(
    resource: string,
    query: Record<string, QueryValue> = {},
    maxItems = 5000,
  ): Promise<ListAllResult<T>> {
    const items: T[] = [];
    const pageSize = Math.min(1000, Math.max(1, maxItems));
    const key = resource.replace(/^\/+|\/+$/g, '');
    const cursor = !this.offsetOnly.has(key);
    let next: string | undefined = this.buildUrl(resource, { limit: pageSize, ...(cursor ? { pagination_type: 'cursor' } : {}), ...query });
    let totalCount: number | undefined;
    while (next && items.length < maxItems) {
      let page: ListResponse<T>;
      try {
        page = await this.request<ListResponse<T>>('GET', next);
      } catch (error) {
        // Some resources (explored_employee_balance, schedule — verified
        // 2026-09-29) answer HTTP 500 to pagination_type=cursor. Fall back
        // to offset paging for them and remember it for this process.
        if (cursor && items.length === 0 && error instanceof IntempusHttpError && error.status === 500) {
          this.offsetOnly.add(key);
          return this.listAll<T>(resource, query, maxItems);
        }
        throw error;
      }
      totalCount ??= page.meta?.total_count;
      items.push(...(page.objects ?? []));
      next = page.meta?.next ? page.meta.next : undefined;
    }
    return { items: items.slice(0, maxItems), truncated: Boolean(next) || items.length > maxItems, totalCount };
  }

  /** "/web/v1/employee/12/" for ("employee", 12). */
  uri(resource: string, id: number | string): string {
    return `${this.uriPrefix}${pathSegment(resource)}/${pathSegment(id)}/`;
  }

  buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(this.resolvePath(path));
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      if (Array.isArray(value)) {
        // tastypie's __in filters take one comma-separated value.
        url.searchParams.set(key, value.join(','));
        continue;
      }
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private resolvePath(path: string): string {
    if (/^https?:\/\//i.test(path)) {
      const target = new URL(path);
      const base = new URL(this.baseUrl);
      if (target.origin !== base.origin) {
        // Neither address is quoted: the link is Intempus' text, the base URL configuration.
        throw new IntempusToolError('Refusing to follow a link outside the configured Intempus address.');
      }
      return target.toString();
    }
    const origin = new URL(this.baseUrl).origin;
    if (path.startsWith(this.uriPrefix)) {
      return `${origin}${path}`;
    }
    const relative = path.replace(/^\/+/, '');
    return `${this.baseUrl}/${relative}`;
  }

  private authorization(): string {
    if (!this.username || !this.apiKey) {
      throw new Error('Missing INTEMPUS_API_USER / INTEMPUS_API_KEY. Set them in the MCP server environment.');
    }
    return `ApiKey ${this.username}:${this.apiKey}`;
  }

  private async request<T>(
    method: HttpMethod,
    path: string,
    query?: Record<string, QueryValue>,
    body?: unknown,
    isRetry = false,
  ): Promise<T> {
    const url = /^https?:\/\//i.test(path) && !query ? this.resolvePath(path) : this.buildUrl(path, query);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: this.authorization(),
    };
    // Never follow a redirect: the Authorization header carries the API key.
    const init: RequestInit = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl(url, init);
    const retryAfter = response.headers.get('retry-after') ?? undefined;
    const requestId = requestIdFrom(response.headers);

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new IntempusHttpError({
        status: response.status,
        url,
        retryAfter,
        requestId,
        fallbackMessage: 'redirect not followed (check INTEMPUS_BASE_URL)',
        detail: this.errorDetail,
      });
    }

    if (response.status === 429 && !isRetry) {
      const seconds = Number(retryAfter ?? 1);
      if (Number.isFinite(seconds) && seconds <= this.maxRetryAfterSeconds) {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, seconds) * 1000));
        return this.request<T>(method, url, undefined, body, true);
      }
    }

    if (!response.ok && !this.errorDetail) {
      // A gateway instance never reads an error body into the error: Intempus' text can quote the request or the
      // key. A 400 body is only compared with a fixed list of known validation messages.
      const knownProblem = response.status === 400 ? await knownProblemOf(response) : undefined;
      await response.body?.cancel().catch(() => undefined);
      throw new IntempusHttpError({ status: response.status, url, retryAfter, requestId, detail: false, knownProblem });
    }

    const responseBody = await readBody(response);

    if (!response.ok) {
      throw new IntempusHttpError({
        status: response.status,
        url,
        payload: responseBody,
        retryAfter,
        requestId,
        fallbackMessage: response.status === 404 ? 'not found (or not visible to the API user)' : undefined,
      });
    }

    return responseBody as T;
  }
}

/**
 * Id of a related object. List endpoints give relations as resource URIs
 * ("/web/v1/case/42/" → 42) while detail endpoints may embed the whole
 * object ({id: 42, resource_uri: …}) — verified 2026-09-29 on
 * work_type.work_model — so both shapes are accepted.
 */
export function idFromUri(ref: unknown): number | undefined {
  if (ref && typeof ref === 'object') {
    const nested = ref as { id?: unknown; resource_uri?: unknown };
    if (typeof nested.id === 'number') return nested.id;
    return idFromUri(nested.resource_uri);
  }
  if (typeof ref !== 'string') return undefined;
  const match = /\/(\d+)\/?$/.exec(ref);
  return match ? Number(match[1]) : undefined;
}

/** Error bodies are read up to this many bytes; the rest is discarded. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

async function readBody(response: Response): Promise<unknown> {
  let text: string;
  if (response.ok) {
    text = await response.text();
  } else {
    const capped = await readTextUpTo(response, MAX_ERROR_BODY_BYTES);
    if (capped.truncated) {
      return `${capped.text}... [truncated]`;
    }
    text = capped.text;
  }
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** The index of the first KNOWN_PROBLEMS phrase in the body (read up to MAX_PROBLEM_BODY_BYTES), if any. */
async function knownProblemOf(response: Response): Promise<number | undefined> {
  let text: string;
  try {
    text = (await readTextUpTo(response, MAX_PROBLEM_BODY_BYTES)).text;
  } catch {
    return undefined;
  }
  const index = KNOWN_PROBLEMS.findIndex(([phrase]) => text.includes(phrase));
  return index >= 0 ? index : undefined;
}

/** Reads at most `limit` bytes of the body as text and cancels the rest. */
async function readTextUpTo(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    return { text: '', truncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (total + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - total));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

function assertSafeBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`INTEMPUS_BASE_URL is not a valid URL: ${baseUrl}`);
  }
  if (parsed.protocol === 'https:') {
    return;
  }
  if (parsed.protocol === 'http:' && isLocalHost(parsed.hostname)) {
    return;
  }
  throw new Error(
    `Refusing to send Intempus credentials over ${parsed.protocol}//. Use https:// (loopback http:// is allowed for local mocks).`,
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/**
 * Validate one caller-influenced URL path segment and encode it. Rejects
 * empty values, dot segments and anything that could change the path or
 * start a query/fragment (including their percent-encoded forms).
 */
export function pathSegment(value: string | number): string {
  const text = String(value);
  if (
    text.trim() === '' ||
    text === '.' ||
    text === '..' ||
    /[/\\?#]/.test(text) ||
    /%(2e|2f|5c|3f|23)/i.test(text) ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(text)
  ) {
    throw new IntempusToolError(`Invalid path parameter: ${JSON.stringify(text.slice(0, 60))}`);
  }
  return encodeURIComponent(text);
}
