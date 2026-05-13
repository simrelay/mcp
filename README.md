# SimRelay MCP Server

An [MCP](https://modelcontextprotocol.io) server that lets AI agents work with [SimRelay](https://simrelay.com) SIMs: list them, lock and release them, read message history, and stream incoming SMS in real time over WebSocket.

Built for Claude Desktop, Claude Code, Cursor, and any other MCP-compatible client.

## Tools

| Tool | What it does |
|---|---|
| `simrelay_login` | Open a browser to sign in to SimRelay (run on first use) |
| `simrelay_logout` | Forget saved tokens |
| `list_sims` | List every SIM the user can access (id, phone number, status, country, provider, lock state, …) |
| `lock_sim` | Acquire an exclusive lock on a SIM by `hosted_sim_id` |
| `release_sim_lock` | Release a lock — idempotent |
| `get_sim_messages` | Paginated SMS history for a SIM (`page`, `per_page` up to 100) |
| `subscribe_to_messages` | Open a WebSocket subscription; new SMS are pushed to the MCP client as `notifications/message` (logger `simrelay-sms`) |
| `unsubscribe_from_messages` | Stop the WebSocket subscription |

See [`docs/tools.md`](./docs/tools.md) for full input/output schemas and examples, and [`docs/realtime.md`](./docs/realtime.md) for how the real-time stream works.

## Install

### As a Claude Desktop extension (recommended)

Install the bundled `.mcpb` extension. The first time you ask the assistant to do anything with SimRelay, it will call `simrelay_login`, which opens your browser. Sign in once; tokens persist to `~/.config/simrelay-mcp/tokens.json` (chmod `0600`) and refresh automatically.

### As an npm package (Claude Code / Cursor / generic MCP)

```bash
npm install -g simrelay-mcp-server
```

Claude Code:

```bash
claude mcp add simrelay -- simrelay-mcp
```

Generic MCP client: configure an stdio server with command `simrelay-mcp`. From inside any conversation, ask the assistant to "log in to SimRelay" — or run `simrelay-mcp login` in a terminal beforehand.

## Configuration (advanced)

End users don't need to set anything — the OAuth client ID is baked into the build. The following env vars are available for development and self-hosted deployments:

| Env var | Default | Notes |
|---|---|---|
| `SIMRELAY_OAUTH_CLIENT_ID` | built-in | Override the bundled OAuth client (dev/staging only). |
| `SIMRELAY_API_BASE_URL` | `https://simrelay.com` | Point at staging or a self-hosted instance. |
| `SIMRELAY_OAUTH_SCOPES` | `mobile:device` | Space-separated scopes. |
| `SIMRELAY_TOKEN_FILE` | `~/.config/simrelay-mcp/tokens.json` | Override token storage path. |

See [`docs/configuration.md`](./docs/configuration.md) for the full reference.

## Real-time messages

After calling `subscribe_to_messages`, each new SMS is delivered to the MCP client as an `info`-level logging notification with the structured payload:

```json
{
  "event": "sms.received",
  "sim_id": 42,
  "from": "+491701234567",
  "text": "Your verification code is 123456",
  "received_at": "2026-05-12T10:00:00Z",
  "raw": { /* full SimRelay event payload */ }
}
```

In Claude Desktop these surface inline in the conversation. Agents can react to them within the same session — e.g. extract an OTP and submit it. Details: [`docs/realtime.md`](./docs/realtime.md).

## CLI

```
simrelay-mcp          Start the MCP server on stdio (default)
simrelay-mcp login    Sign in with SimRelay via OAuth (opens browser)
simrelay-mcp logout   Forget saved tokens
simrelay-mcp help     Show help
```

## Security

- Credentials never travel through tool arguments. OAuth happens out-of-band in your browser; tokens stay on disk.
- Token file is created with `0600` permissions on POSIX (`~/.config/simrelay-mcp/tokens.json` by default).
- All requests use `Authorization: Bearer <access_token>`. Tokens are refreshed automatically before expiry.

## Development

```bash
git clone https://github.com/simrelay/mcp.git
cd mcp
npm install
npm run build
npm test                # node:test suite
npm run dev             # tsx watch entry point
```

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for how to develop against a personal SimRelay OAuth client without any secrets.

## Troubleshooting

- **`Not authenticated. Run \`simrelay-mcp login\` first.`** — your token file is missing or empty. Run `simrelay-mcp login`.
- **`Token refresh failed: 401`** — your refresh token expired or was revoked. Run `simrelay-mcp logout && simrelay-mcp login`.
- **`SIMRELAY_OAUTH_CLIENT_ID is not set`** — export the env var before starting the server / running login.
- **Browser does not open during login** — the URL is printed to stderr. Copy it into a browser manually.
- **WebSocket disconnects repeatedly** — the server auto-reconnects with exponential backoff (5s → 60s). If it never reaches `READY`, check that the registered OAuth scopes include broadcasting permissions.

## License

ISC
