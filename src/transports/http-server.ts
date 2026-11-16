import {
  createServer as createNodeServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { type IntempusRole, parseRoles, rolesFromGateway } from '../intempus/policy.js';
import { createServer as createDefaultMcpServer } from '../server.js';
import {
  assertAllowedHost,
  assertAllowedOrigin,
  assertAuthorized,
  assertSecureConfig,
  AuthFailureLimiter,
  corsHeaders,
  DEFAULT_AUTH_FAILURE_LIMIT,
  DEFAULT_AUTH_FAILURE_WINDOW_MS,
  forwardedHeadersTrusted,
  type HttpConfig,
  HttpRequestError,
  readJsonBody,
  sendJson,
} from './http-helpers.js';

export interface HttpServerOptions {
  /** Factory for the per-request MCP server (tests inject one with a fake upstream client). */
  createMcpServer?: (req: IncomingMessage) => McpServer;
  /** Defaults to console.error. */
  log?: (line: string) => void;
  /** Time in-flight requests get on close() before connections are destroyed. */
  shutdownGraceMs?: number;
}

export interface RunningHttpServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

export function createHttpRequestHandler(config: HttpConfig, options: HttpServerOptions = {}): RequestListener {
  const createMcpServer = options.createMcpServer ?? gatewayMcpServerFactory(config);
  const log = options.log ?? ((line: string) => console.error(line));
  const failureLimit = config.authFailureLimit ?? DEFAULT_AUTH_FAILURE_LIMIT;
  const limiter = failureLimit > 0
    ? new AuthFailureLimiter(failureLimit, config.authFailureWindowMs ?? DEFAULT_AUTH_FAILURE_WINDOW_MS)
    : undefined;

  return async (req: IncomingMessage, res: ServerResponse) => {
    const remote = req.socket.remoteAddress ?? 'unknown';
    const describeRequest = () => `${req.method ?? '-'} ${(req.url ?? '').slice(0, 200)} from ${remote}`;
    try {
      const path = (req.url ?? '/').split('?')[0];

      if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
        sendJson(res, 200, { status: 'ok' });
        return;
      }

      if (path !== '/mcp') {
        throw new HttpRequestError(404, 'Not found');
      }

      assertAllowedHost(req, config);
      assertAllowedOrigin(req, config);

      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req, config));
        res.end();
        return;
      }

      if (req.method !== 'POST') {
        throw new HttpRequestError(405, 'Method not allowed', { headers: { Allow: 'POST, OPTIONS' } });
      }

      try {
        assertAuthorized(req, config);
      } catch (error) {
        // Only failing requests are counted and throttled; a valid token is never blocked.
        if (limiter) {
          const retryAfter = limiter.retryAfterSeconds(remote);
          if (retryAfter > 0) {
            sendJson(res, 429, { error: 'Too many failed authentication attempts' }, req, {
              'Retry-After': String(retryAfter),
            }, config);
            return;
          }
          if (limiter.recordFailure(remote)) {
            log(`[http] ${remote} reached ${failureLimit} failed authentication attempts; further failures get 429`);
          }
        }
        throw error;
      }

      const body = await readJsonBody(req, config.maxBodyBytes);
      const mcpServer = createMcpServer(req);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      res.on('close', () => {
        void transport.close();
        void mcpServer.close();
      });

      for (const [name, value] of Object.entries(corsHeaders(req, config))) {
        res.setHeader(name, value);
      }

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (error instanceof HttpRequestError) {
        log(`[http] ${error.status} ${describeRequest()}: ${error.message}`);
        if (!res.headersSent && !res.destroyed) {
          const payload = error.jsonRpcCode === undefined
            ? { error: error.message }
            : { jsonrpc: '2.0', error: { code: error.jsonRpcCode, message: error.message }, id: null };
          sendJson(res, error.status, payload, req, error.headers, config);
        }
        return;
      }

      log(`[http] 500 ${describeRequest()}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 500, {
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        }, req, {}, config);
      }
    }
  };
}

/**
 * Per-request MCP server for a deployment behind an authenticating gateway.
 * The gateway forwards the verified user as X-MCP-User; the stateless server
 * binds it as the Intempus acting identity. With INTEMPUS_PROFILE=roles the
 * gateway also sends the user's roles in X-MCP-Roles. Both headers are only
 * honoured with INTEMPUS_TRUST_FORWARDED_USER=true and MCP_HTTP_TOKEN, so only
 * the gateway holding the token can assert them.
 */
export function gatewayMcpServerFactory(config: HttpConfig): (req: IncomingMessage) => McpServer {
  return req => {
    const trusted = forwardedHeadersTrusted(config);
    const forwardedUser = trusted ? firstHeaderValue(req.headers['x-mcp-user']) : undefined;
    // Every Intempus change is recorded as the one API user, so a request
    // without the acting user would be unattributable: refuse it.
    if (trusted && !forwardedUser) {
      throw new HttpRequestError(401, 'Missing X-MCP-User from the gateway');
    }

    // INTEMPUS_PROFILE=roles: one endpoint for everyone; the gateway maps the
    // user's groups to role names (X-MCP-Roles) and the tools offered are the
    // union of those roles. Without a trusted gateway, no roles.
    let roles: IntempusRole[] | undefined;
    if (rolesFromGateway()) {
      roles = trusted ? parseRoles(firstHeaderValue(req.headers['x-mcp-roles'])) : [];
      if (roles.length === 0) {
        throw new HttpRequestError(403, 'No Intempus role for this user (X-MCP-Roles from the gateway)');
      }
    }

    return createDefaultMcpServer({ onBehalfOf: forwardedUser, roles });
  };
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Starts the HTTP transport. `config.port` 0 picks an ephemeral port. Throws
 * ConfigError for configurations refused by assertSecureConfig.
 */
export async function startHttpServer(
  config: HttpConfig,
  options: HttpServerOptions = {},
): Promise<RunningHttpServer> {
  assertSecureConfig(config);
  const server = createNodeServer(createHttpRequestHandler(config, options));
  const graceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  let closing: Promise<void> | undefined;

  // While shutting down, let in-flight requests finish and then drop their
  // keep-alive sockets instead of waiting for the force-close timer.
  server.on('request', (_req, res) => {
    res.on('finish', () => {
      if (closing) {
        server.closeIdleConnections();
      }
    });
  });

  return {
    server,
    port,
    close() {
      closing ??= new Promise<void>(resolve => {
        server.on('request', (_req, res) => res.setHeader('Connection', 'close'));
        const force = setTimeout(() => server.closeAllConnections(), graceMs);
        force.unref();
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}
