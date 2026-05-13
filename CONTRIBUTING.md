# Contributing

Thanks for helping out. This guide covers how to run, test, and submit changes.

## Setup

```bash
npm install
npm run build
npm test
```

You need Node 20+. The `dist/` directory is a build artifact (gitignored).

## Running locally

For most development you don't need a real SimRelay OAuth client. The unit + integration tests stub the API and a dummy client ID env var is enough:

```bash
SIMRELAY_OAUTH_CLIENT_ID=dummy npm test
```

If you want to exercise the server end-to-end against a real SimRelay account, register your own **public (PKCE) OAuth client** at SimRelay → API → OAuth clients. Add `http://127.0.0.1:*/callback` to its allowed redirect URIs. Then:

```bash
# Point at test.simrelay.com (or your local dev API)
export SIMRELAY_OAUTH_CLIENT_ID="<your-own-client-id>"
export SIMRELAY_API_BASE_URL="https://test.simrelay.com"

# Sign in once
npm run build
node dist/index.js login

# Talk to the server over stdio
node dist/index.js
```

Never commit a real client ID. The committed defaults in `src/build-config.ts` are deliberately `null` — CI rewrites them with secrets at build time.

## Branch / PR workflow

1. Fork the repo and create a feature branch.
2. Make your changes — follow the existing style (`strict` TypeScript, no console.log spam, narrow exports).
3. Run `npm test` locally before pushing.
4. Open a PR against `main`. CI runs on Ubuntu/macOS/Windows × Node 20/22.
5. PR CI never has access to maintainer secrets.

## Tests

- `test/types.test.ts` — pure normalizers (sim/message/event)
- `test/tokens.test.ts` — token store + 0600 perms
- `test/simrelay-client.test.ts` — REST shape with `fetch` mocked
- `test/oauth.test.ts` — token refresh, error paths
- `test/realtime.test.ts` — Reverb state machine against an in-process WS server
- `test/mcp-integration.test.ts` — spawns the built MCP server over stdio and drives `tools/list` + `tools/call list_sims` against a mock API

Run a single suite:

```bash
node --test --import tsx ./test/realtime.test.ts
```

Run in watch mode:

```bash
npm run test:watch
```

## Releasing (maintainers)

See [`docs/release-architecture.md`](./docs/release-architecture.md) for the full two-repo build + publish + mirror pipeline. TL;DR:

```bash
npm version patch    # or minor/major
git push --follow-tags
```

The `release.yml` workflow handles npm publishing (via Trusted Publishing) and mirroring to the public repo.

## Security

If you find a security issue, please email the maintainer directly rather than opening a public issue. See `SECURITY.md` for details.

## Code of conduct

Be kind. No harassment. No spam. Maintainers may remove anything that violates this.
