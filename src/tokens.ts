import { homedir, platform } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, unlink, chmod } from "node:fs/promises";

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
  scope?: string;
}

const APP_NAME = "simrelay-mcp";

function defaultTokenDir(): string {
  if (process.env.SIMRELAY_TOKEN_FILE) {
    return ""; // overridden — direct file path
  }
  if (platform() === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, APP_NAME);
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, APP_NAME);
}

export function tokenFilePath(): string {
  if (process.env.SIMRELAY_TOKEN_FILE) return process.env.SIMRELAY_TOKEN_FILE;
  return join(defaultTokenDir(), "tokens.json");
}

export async function loadTokens(): Promise<TokenSet | null> {
  try {
    const buf = await readFile(tokenFilePath(), "utf8");
    const parsed = JSON.parse(buf) as TokenSet;
    if (!parsed.access_token || !parsed.refresh_token) return null;
    return parsed;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw err;
  }
}

export async function saveTokens(tokens: TokenSet): Promise<void> {
  const path = tokenFilePath();
  const dir = path.substring(0, path.lastIndexOf("/")) || path.substring(0, path.lastIndexOf("\\"));
  if (dir) await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  if (platform() !== "win32") {
    try {
      await chmod(path, 0o600);
    } catch {
      // best-effort
    }
  }
}

export async function clearTokens(): Promise<void> {
  try {
    await unlink(tokenFilePath());
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw err;
  }
}

export function isExpired(tokens: TokenSet, skewSeconds = 60): boolean {
  return Date.now() >= tokens.expires_at - skewSeconds * 1000;
}
