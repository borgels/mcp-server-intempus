import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { IntempusClient, type IntempusClientOptions } from './intempus/client.js';
import { registerIntempusTools } from './tools/intempus.js';

export interface CreateServerOptions {
  client?: IntempusClient;
  clientOptions?: IntempusClientOptions;
  /** Gateway-verified end-user UPN; employee/approver tools are pinned to this person. */
  onBehalfOf?: string;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'intempus',
    version: '0.1.0',
  });

  const client = options.client ?? new IntempusClient(options.clientOptions);
  registerIntempusTools(server, client, { onBehalfOf: options.onBehalfOf });

  return server;
}
