import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { IntempusClient, type IntempusClientOptions } from './intempus/client.js';
import type { IntempusRole } from './intempus/policy.js';
import { registerIntempusTools } from './tools/intempus.js';

export interface CreateServerOptions {
  client?: IntempusClient;
  clientOptions?: IntempusClientOptions;
  /** Gateway-verified end-user UPN; employee/approver tools are pinned to this person. */
  onBehalfOf?: string;
  /** The user's roles; defaults to the roles configured by INTEMPUS_PROFILE. */
  roles?: readonly IntempusRole[];
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'intempus',
    version: '0.2.0',
  });

  const client = options.client ?? new IntempusClient(options.clientOptions);
  registerIntempusTools(server, client, { onBehalfOf: options.onBehalfOf, roles: options.roles });

  return server;
}
