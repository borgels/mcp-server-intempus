import { IntempusHttpError } from '../errors.js';

export interface IntempusClientOptions {
  username?: string;
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Longest Retry-After (seconds) the client waits out once before failing. Default 10. */
  maxRetryAfterSeconds?: number;
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

const DEFAULT_BASE_URL = 'https://intempus.dk/web/v1';

/** Resources that reject cursor pagination; learned at runtime, seeded with the verified ones. */
const OFFSET_ONLY_RESOURCES = new Set(['explored_employee_balance', 'schedule']);

/**
 * Client for the Intempus REST API (Django + tastypie).
 *
 * Auth is `Authorization: ApiKey <username>:<key>`. The key belongs to an
 * Intempus user and every call runs with that user's rights; the username
 * is case-sensitive (verified 2026-09-29: "Abo@…" works, "abo@…" is 401).
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

  constructor(options: IntempusClientOptions = {}) {
    this.username = options.username ?? process.env.INTEMPUS_API_USER;
    this.apiKey = options.apiKey ?? process.env.INTEMPUS_API_KEY;
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? process.env.INTEMPUS_BASE_URL ?? DEFAULT_BASE_URL);
    assertSafeBaseUrl(this.baseUrl);
    this.uriPrefix = `${new URL(this.baseUrl).pathname.replace(/\/+$/, '')}/`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.INTEMPUS_TIMEOUT_MS ?? 30_000);
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
    const cursor = !OFFSET_ONLY_RESOURCES.has(key);
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
          OFFSET_ONLY_RESOURCES.add(key);
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
    return `${this.uriPrefix}${resource}/${id}/`;
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
        throw new Error(`Refusing to follow a link outside ${base.origin}: ${target.origin}`);
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
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl(url, init);
    const retryAfter = response.headers.get('retry-after') ?? undefined;

    if (response.status === 429 && !isRetry) {
      const seconds = Number(retryAfter ?? 1);
      if (Number.isFinite(seconds) && seconds <= this.maxRetryAfterSeconds) {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, seconds) * 1000));
        return this.request<T>(method, url, undefined, body, true);
      }
    }

    const responseBody = await readBody(response);

    if (!response.ok) {
      throw new IntempusHttpError({
        status: response.status,
        url,
        payload: responseBody,
        retryAfter,
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

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
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
