# Security Policy

## Supported versions

Only the latest `v*` release receives security fixes. Use the latest published `.mcpb` bundle from the Releases page.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security-sensitive reports.

Instead, use GitHub's private vulnerability reporting: **Repo → Security → Report a vulnerability**. Include:

- A clear description of the issue
- Steps to reproduce (or a proof-of-concept)
- The impact you believe it has
- Your suggested fix if you have one

You can expect an acknowledgement within 7 days. If the issue is confirmed, we aim to ship a fix within 30 days; critical issues get faster turnaround.

## Scope

In scope:

- The MCP server code in this repository
- The OAuth flow and token storage logic
- The Reverb WebSocket client
- The build / packaging scripts that produce the `.mcpb` bundle

Out of scope:

- Vulnerabilities in the SimRelay API itself (report those to SimRelay directly)
- Issues that require physical access to the user's machine
- Issues in the `@modelcontextprotocol/sdk` upstream (report those to Anthropic)

## What we treat as sensitive

- The token file at `~/.config/simrelay-mcp/tokens.json` is created with mode `0600`. If you find a code path that writes it more permissively, that's a vulnerability.
- OAuth tokens are never passed through MCP tool arguments. If you find a path that leaks them into tool args, responses, or log output, that's a vulnerability.
- The OAuth callback server validates the `state` parameter. If you find a way to bypass that check, that's a vulnerability.
