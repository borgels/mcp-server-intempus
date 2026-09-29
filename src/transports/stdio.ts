#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../server.js';

async function main(): Promise<void> {
  // Local use only: stdio has no gateway, so the acting user comes from
  // INTEMPUS_DEFAULT_USER (e.g. your own UPN) when set.
  const server = createServer({ onBehalfOf: process.env.INTEMPUS_DEFAULT_USER || undefined });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
