#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { buildServer } from "./server.js";
import { loadOAuthConfig, login } from "./oauth.js";
import { clearTokens, tokenFilePath } from "./tokens.js";

const command = process.argv[2];

async function main(): Promise<void> {
  switch (command) {
    case "login":
      await runLogin();
      return;
    case "logout":
      await runLogout();
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case undefined:
      await serve();
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

async function runLogin(): Promise<void> {
  const config = loadOAuthConfig();
  console.error("Starting SimRelay OAuth login...");
  await login(config);
  console.error(`Login complete. Tokens stored at ${tokenFilePath()}`);
}

async function runLogout(): Promise<void> {
  await clearTokens();
  console.error(`Tokens cleared (${tokenFilePath()}).`);
}

async function serve(): Promise<void> {
  const { server, cleanup } = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SimRelay MCP server running on stdio");

  const shutdown = () => {
    cleanup();
    server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function printHelp(): void {
  console.error(`simrelay-mcp — MCP server for SimRelay

Usage:
  simrelay-mcp            Start the MCP server on stdio (default)
  simrelay-mcp login      Sign in with SimRelay via OAuth (opens browser)
  simrelay-mcp logout     Forget saved tokens
  simrelay-mcp help       Show this help

Environment:
  SIMRELAY_OAUTH_CLIENT_ID   (required) OAuth client ID registered at SimRelay
  SIMRELAY_API_BASE_URL      Override API base URL (default: https://simrelay.com)
  SIMRELAY_OAUTH_SCOPES      Space-separated scopes (default: mobile:device)
  SIMRELAY_TOKEN_FILE        Override token storage path

Token file: ${tokenFilePath()}
`);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
