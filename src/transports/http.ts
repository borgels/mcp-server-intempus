import { IntempusClient } from '../intempus/client.js';
import { assertSafeHttpStartup, configWarnings, getHttpConfig, type HttpConfig } from './http-helpers.js';
import { startHttpServer } from './http-server.js';

async function main(): Promise<void> {
  let config: HttpConfig;
  try {
    config = getHttpConfig();
    assertSafeHttpStartup(process.env, config);
    // Validate the Intempus client configuration (base URL, timeout) once at
    // startup instead of on the first request.
    new IntempusClient();
  } catch (error) {
    console.error(
      `Intempus MCP HTTP server not started: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  for (const warning of configWarnings(config)) {
    console.error(warning);
  }

  const running = await startHttpServer(config);
  console.error(`Intempus MCP HTTP server listening on http://${config.host}:${running.port}/mcp`);

  const shutdown = (signal: string) => {
    console.error(`Received ${signal}, shutting down`);
    void running.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
