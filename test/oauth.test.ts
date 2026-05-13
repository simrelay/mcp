import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TokenProvider, loadOAuthConfig, resolveOAuthConfig } from "../src/oauth.js";
import { saveTokens } from "../src/tokens.js";

let tmpDir: string;
let prevTokenFile: string | undefined;
let prevClientId: string | undefined;
let prevBase: string | undefined;
const realFetch = globalThis.fetch;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "simrelay-oauth-"));
  prevTokenFile = process.env.SIMRELAY_TOKEN_FILE;
  prevClientId = process.env.SIMRELAY_OAUTH_CLIENT_ID;
  prevBase = process.env.SIMRELAY_API_BASE_URL;
  process.env.SIMRELAY_TOKEN_FILE = join(tmpDir, "tokens.json");
  process.env.SIMRELAY_OAUTH_CLIENT_ID = "test-client";
  process.env.SIMRELAY_API_BASE_URL = "https://example.test";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (prevTokenFile === undefined) delete process.env.SIMRELAY_TOKEN_FILE;
  else process.env.SIMRELAY_TOKEN_FILE = prevTokenFile;
  if (prevClientId === undefined) delete process.env.SIMRELAY_OAUTH_CLIENT_ID;
  else process.env.SIMRELAY_OAUTH_CLIENT_ID = prevClientId;
  if (prevBase === undefined) delete process.env.SIMRELAY_API_BASE_URL;
  else process.env.SIMRELAY_API_BASE_URL = prevBase;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveOAuthConfig", () => {
  const NO_BUILTINS = { clientId: null, apiBaseUrl: null };

  it("env override wins over build-time builtins", () => {
    const cfg = resolveOAuthConfig(
      { SIMRELAY_OAUTH_CLIENT_ID: "env-override" },
      { clientId: "builtin-id", apiBaseUrl: "https://builtin.example" },
    );
    assert.equal(cfg.clientId, "env-override");
  });

  it("falls back to build-time builtin when env is unset", () => {
    const cfg = resolveOAuthConfig(
      {},
      { clientId: "builtin-id", apiBaseUrl: "https://builtin.example" },
    );
    assert.equal(cfg.clientId, "builtin-id");
    assert.equal(cfg.apiBaseUrl, "https://builtin.example");
  });

  it("strips trailing slash on the resolved base URL", () => {
    const cfg = resolveOAuthConfig(
      { SIMRELAY_OAUTH_CLIENT_ID: "x", SIMRELAY_API_BASE_URL: "https://simrelay.com/" },
      NO_BUILTINS,
    );
    assert.equal(cfg.apiBaseUrl, "https://simrelay.com");
  });

  it("defaults scopes to mobile:device", () => {
    assert.equal(
      resolveOAuthConfig({ SIMRELAY_OAUTH_CLIENT_ID: "x" }, NO_BUILTINS).scopes,
      "mobile:device",
    );
  });

  it("uses https://simrelay.com when neither env nor builtin sets the base URL", () => {
    assert.equal(
      resolveOAuthConfig({ SIMRELAY_OAUTH_CLIENT_ID: "x" }, NO_BUILTINS).apiBaseUrl,
      "https://simrelay.com",
    );
  });

  it("throws an actionable error when neither build-time nor env client id is set", () => {
    assert.throws(
      () => resolveOAuthConfig({}, NO_BUILTINS),
      /OAuth client ID is not configured/,
    );
  });
});

describe("loadOAuthConfig (process.env wrapper)", () => {
  it("does not throw when SIMRELAY_OAUTH_CLIENT_ID is set", () => {
    process.env.SIMRELAY_OAUTH_CLIENT_ID = "wrapper-test";
    assert.doesNotThrow(() => loadOAuthConfig());
  });
});

describe("TokenProvider", () => {
  it("returns cached access_token when not expired", async () => {
    await saveTokens({
      access_token: "good-token",
      refresh_token: "r",
      expires_at: Date.now() + 600_000,
      token_type: "Bearer",
    });
    const provider = new TokenProvider(loadOAuthConfig());
    assert.equal(await provider.getAccessToken(), "good-token");
  });

  it("refreshes when expired and persists rotated refresh token", async () => {
    await saveTokens({
      access_token: "old",
      refresh_token: "old-refresh",
      expires_at: Date.now() - 1000,
      token_type: "Bearer",
    });

    let calledWith: { url: string; body: string } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calledWith = { url: String(input), body: String(init?.body ?? "") };
      return new Response(
        JSON.stringify({
          access_token: "new",
          refresh_token: "new-refresh",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const provider = new TokenProvider(loadOAuthConfig());
    assert.equal(await provider.getAccessToken(), "new");
    assert.ok(calledWith);
    assert.equal((calledWith as { url: string }).url, "https://example.test/oauth/token");
    assert.match((calledWith as { body: string }).body, /grant_type=refresh_token/);
    assert.match((calledWith as { body: string }).body, /refresh_token=old-refresh/);
  });

  it("throws helpful error when no tokens stored", async () => {
    const provider = new TokenProvider(loadOAuthConfig());
    await assert.rejects(() => provider.getAccessToken(), /simrelay-mcp login/);
  });
});
