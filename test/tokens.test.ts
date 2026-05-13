import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isExpired, loadTokens, saveTokens, clearTokens, tokenFilePath } from "../src/tokens.js";

let tmpDir: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "simrelay-tokens-"));
  prevEnv = process.env.SIMRELAY_TOKEN_FILE;
  process.env.SIMRELAY_TOKEN_FILE = join(tmpDir, "tokens.json");
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.SIMRELAY_TOKEN_FILE;
  else process.env.SIMRELAY_TOKEN_FILE = prevEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("tokens", () => {
  it("returns null when no file present", async () => {
    assert.equal(await loadTokens(), null);
  });

  it("round-trips a TokenSet and stores with 0600 perms on POSIX", async () => {
    const tokens = {
      access_token: "a",
      refresh_token: "r",
      expires_at: Date.now() + 3600_000,
      token_type: "Bearer",
    };
    await saveTokens(tokens);
    const loaded = await loadTokens();
    assert.deepEqual(loaded, tokens);
    if (process.platform !== "win32") {
      const mode = statSync(tokenFilePath()).mode & 0o777;
      assert.equal(mode, 0o600, `expected mode 0600, got ${mode.toString(8)}`);
    }
  });

  it("clearTokens removes file (idempotent)", async () => {
    await saveTokens({
      access_token: "a",
      refresh_token: "r",
      expires_at: Date.now(),
      token_type: "Bearer",
    });
    await clearTokens();
    await clearTokens(); // idempotent
    assert.equal(await loadTokens(), null);
  });

  it("isExpired uses 60s skew", () => {
    const now = Date.now();
    assert.equal(
      isExpired({
        access_token: "",
        refresh_token: "",
        token_type: "",
        expires_at: now + 30_000,
      }),
      true,
      "30s in future should be considered expired due to skew",
    );
    assert.equal(
      isExpired({
        access_token: "",
        refresh_token: "",
        token_type: "",
        expires_at: now + 120_000,
      }),
      false,
      "120s in future should be fresh",
    );
  });
});
