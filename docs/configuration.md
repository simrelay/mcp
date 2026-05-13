# Configuration

The SimRelay MCP server is configured entirely via environment variables. No tool argument ever carries credentials.

## Environment variables

### `SIMRELAY_OAUTH_CLIENT_ID` *(required)*

The public OAuth 2.0 client ID issued by SimRelay. You can register a client from your SimRelay dashboard → API → OAuth clients. Use a **public** (PKCE) client — no client secret.

The MCP server uses Authorization Code grant with PKCE (S256), the same flow as the SimRelay mobile and Chrome extension clients. Register the redirect URI pattern `http://127.0.0.1:*/callback` (loopback redirect per RFC 8252) so the local callback server can receive the authorization code on whatever port it grabs.

### `SIMRELAY_API_BASE_URL` *(optional)*

Default `https://simrelay.com`. Override to point at staging (`https://test.simrelay.com`) or a self-hosted instance. Trailing slashes are stripped.

### `SIMRELAY_OAUTH_SCOPES` *(optional)*

Default `mobile:device`. Space-separated list of OAuth scopes to request. The default matches the mobile client and grants access to `numbers.read`, `numbers.lock`, `messages.read`, and the broadcasting auth endpoint. If you register a narrower client just for this MCP server, set the scopes that match.

### `SIMRELAY_TOKEN_FILE` *(optional)*

Override the path used to persist tokens. Defaults:

- macOS / Linux: `$XDG_CONFIG_HOME/simrelay-mcp/tokens.json` (or `~/.config/simrelay-mcp/tokens.json` when `XDG_CONFIG_HOME` is unset)
- Windows: `%APPDATA%\simrelay-mcp\tokens.json`

The file is written with mode `0600` on POSIX systems.

## OAuth login flow

When you run `simrelay-mcp login`:

1. A loopback HTTP server starts on `127.0.0.1` on an ephemeral port.
2. Your default browser is opened to `https://simrelay.com/oauth/authorize?...` with PKCE challenge and CSRF `state`.
3. After you sign in (and complete 2FA if enabled), SimRelay redirects to `http://127.0.0.1:<port>/callback?code=...&state=...`.
4. The MCP server validates the `state`, exchanges the code for `access_token` + `refresh_token` at `/oauth/token`, and writes them to the token file.
5. From then on the MCP server reads tokens from that file and refreshes the access token automatically (60 s before expiry).

If the browser does not open, the URL is printed to stderr — copy it manually.

## Token lifecycle

- Access tokens expire (typically minutes to hours, depending on SimRelay config).
- The MCP server refreshes silently using the stored refresh token whenever a request is made within 60 s of expiry.
- If a refresh fails (refresh token expired or revoked), the server surfaces an error pointing at `simrelay-mcp login`.

## Resetting

```bash
simrelay-mcp logout         # deletes the token file
simrelay-mcp login          # interactive re-auth
```

## Putting it in your shell

```bash
# ~/.zshrc or ~/.bashrc
export SIMRELAY_OAUTH_CLIENT_ID="019d29b2-b9e8-7125-8cdc-5f8a5ecd1d66"
```

Or set it inside your MCP client's config (`env` block in `claude_desktop_config.json`, etc.) so it only applies to that server.
