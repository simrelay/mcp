import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import open from "open";

import { loadTokens, saveTokens, isExpired, type TokenSet } from "./tokens.js";
import { BUILDTIME_API_BASE_URL, BUILDTIME_CLIENT_ID } from "./build-config.js";

export interface OAuthConfig {
  clientId: string;
  apiBaseUrl: string;
  scopes: string;
}

export interface OAuthBuiltins {
  clientId: string | null;
  apiBaseUrl: string | null;
}

/**
 * Pure resolution function — easy to unit-test without manipulating the
 * committed build-config.ts (which CI rewrites on every release).
 */
export function resolveOAuthConfig(
  env: NodeJS.ProcessEnv,
  builtins: OAuthBuiltins,
): OAuthConfig {
  const clientId = env.SIMRELAY_OAUTH_CLIENT_ID ?? builtins.clientId;
  if (!clientId) {
    throw new Error(
      "OAuth client ID is not configured. Either run a CI build that injects BUILDTIME_CLIENT_ID via scripts/inject-build-config.mjs, or set SIMRELAY_OAUTH_CLIENT_ID for local dev.",
    );
  }
  const apiBaseUrl =
    env.SIMRELAY_API_BASE_URL ?? builtins.apiBaseUrl ?? "https://simrelay.com";
  return {
    clientId,
    apiBaseUrl: apiBaseUrl.replace(/\/$/, ""),
    scopes: env.SIMRELAY_OAUTH_SCOPES ?? "mobile:device",
  };
}

export function loadOAuthConfig(): OAuthConfig {
  return resolveOAuthConfig(process.env, {
    clientId: BUILDTIME_CLIENT_ID,
    apiBaseUrl: BUILDTIME_API_BASE_URL,
  });
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(32));
}

function generateCodeChallenge(verifier: string): string {
  return base64UrlEncode(createHash("sha256").update(verifier).digest());
}

function generateState(): string {
  return base64UrlEncode(randomBytes(16));
}

interface CallbackServer {
  port: number;
  codePromise: Promise<string>;
  close: () => void;
}

async function startCallbackServer(expectedState: string): Promise<CallbackServer> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }

    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");
    const state = url.searchParams.get("state");

    if (state !== expectedState) {
      res.writeHead(400, { "content-type": "text/plain" }).end("Invalid state parameter");
      rejectCode(new Error("OAuth state mismatch — possible CSRF"));
      return;
    }

    if (error) {
      const body = `<!doctype html><meta charset="utf-8"><title>SimRelay login failed</title><body style="font-family:system-ui;padding:2rem"><h1>Login failed</h1><p>${escapeHtml(errorDescription ?? error)}</p><p>You can close this tab.</p></body>`;
      res.writeHead(400, { "content-type": "text/html" }).end(body);
      rejectCode(new Error(errorDescription ?? error));
      return;
    }

    if (!code) {
      res.writeHead(400, { "content-type": "text/plain" }).end("No authorization code");
      rejectCode(new Error("No authorization code received"));
      return;
    }

    const html = `<!doctype html><meta charset="utf-8"><title>SimRelay login complete</title><body style="font-family:system-ui;padding:2rem;text-align:center"><h1>You are signed in</h1><p>You can close this tab and return to your terminal.</p></body>`;
    res.writeHead(200, { "content-type": "text/html" }).end(html);
    resolveCode(code);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const port = (server.address() as AddressInfo).port;

  return {
    port,
    codePromise,
    close: () => server.close(),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

export async function login(config: OAuthConfig): Promise<TokenSet> {
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = generateState();

  const callback = await startCallbackServer(state);
  const redirectUri = `http://127.0.0.1:${callback.port}/callback`;
  const authorizeUrl = new URL(`${config.apiBaseUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", config.scopes);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", state);

  // eslint-disable-next-line no-console
  console.error(`\nOpening browser to: ${authorizeUrl.toString()}\n`);
  // eslint-disable-next-line no-console
  console.error("If the browser does not open, copy the URL above into your browser.\n");

  try {
    await open(authorizeUrl.toString());
  } catch {
    // ignore — user can open manually
  }

  // Wait for callback. (state validation happens inside awaitCallback)
  const code = await callback.codePromise.finally(() => callback.close());

  const tokens = await exchangeCodeForTokens(config, code, verifier, redirectUri);
  await saveTokens(tokens);
  return tokens;
}

async function exchangeCodeForTokens(
  config: OAuthConfig,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  });

  const res = await fetch(`${config.apiBaseUrl}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${res.statusText} — ${text}`);
  }

  const json = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
    scope?: string;
  };

  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + json.expires_in * 1000,
    token_type: json.token_type ?? "Bearer",
    scope: json.scope,
  };
}

async function refreshTokens(config: OAuthConfig, current: TokenSet): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    refresh_token: current.refresh_token,
  });

  const res = await fetch(`${config.apiBaseUrl}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${res.statusText} — ${text}. Run \`simrelay-mcp login\` again.`);
  }

  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
    scope?: string;
  };

  const next: TokenSet = {
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? current.refresh_token,
    expires_at: Date.now() + json.expires_in * 1000,
    token_type: json.token_type ?? "Bearer",
    scope: json.scope ?? current.scope,
  };
  await saveTokens(next);
  return next;
}

export class TokenProvider {
  private cache: TokenSet | null = null;
  private inflight: Promise<TokenSet> | null = null;

  constructor(private config: OAuthConfig) {}

  async getAccessToken(): Promise<string> {
    if (this.inflight) return (await this.inflight).access_token;

    if (!this.cache) this.cache = await loadTokens();
    if (!this.cache) {
      throw new Error(
        "Not authenticated. Run `simrelay-mcp login` first to authorize with SimRelay.",
      );
    }

    if (!isExpired(this.cache)) return this.cache.access_token;

    this.inflight = refreshTokens(this.config, this.cache).finally(() => {
      this.inflight = null;
    });
    this.cache = await this.inflight;
    return this.cache.access_token;
  }
}
