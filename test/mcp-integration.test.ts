import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { AddressInfo } from "node:net";
import { join, resolve } from "node:path";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

async function startMockApi() {
  const server = createServer((req, res) => {
    if (req.url === "/api/sims" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          data: [
            { id: 1, seven_system_number: "+49111", status: "active", country: "DE" },
            { id: 2, seven_system_number: "+44222", status: "locked", country: "GB" },
          ],
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

describe("MCP stdio integration", () => {
  it("initializes, lists 11 tools, and calls list_sims against mock API", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "simrelay-mcp-it-"));
    const tokensPath = join(tmp, "tokens.json");
    writeFileSync(
      tokensPath,
      JSON.stringify({
        access_token: "fake",
        refresh_token: "fake-refresh",
        expires_at: Date.now() + 3_600_000,
        token_type: "Bearer",
      }),
      { mode: 0o600 },
    );

    const mock = await startMockApi();
    const entry = resolve("dist/index.js");

    const child = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        SIMRELAY_OAUTH_CLIENT_ID: "test-client",
        SIMRELAY_API_BASE_URL: mock.url,
        SIMRELAY_TOKEN_FILE: tokensPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stderr: Buffer[] = [];
    child.stderr.on("data", (c) => stderr.push(c));

    const lines: string[] = [];
    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) lines.push(line);
      }
    });

    const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + "\n");

    const readResponse = async (id: number, timeoutMs = 5000): Promise<JsonRpcResponse> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          try {
            const parsed = JSON.parse(line) as JsonRpcResponse;
            if (parsed.id === id) {
              lines.splice(i, 1);
              return parsed;
            }
          } catch {
            // ignore non-JSON
          }
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(
        `Timed out waiting for response id=${id}.\nstderr: ${Buffer.concat(stderr).toString("utf8")}`,
      );
    };

    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0" },
        },
      });
      const initRes = await readResponse(1);
      assert.ok(initRes.result, `init result missing: ${JSON.stringify(initRes)}`);

      send({ jsonrpc: "2.0", method: "notifications/initialized" });

      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const listRes = await readResponse(2);
      const tools = (listRes.result as { tools: { name: string }[] }).tools;
      const names = tools.map((t) => t.name).sort();
      assert.deepEqual(names, [
        "get_recent_sms",
        "get_sim_messages",
        "get_subscription_status",
        "list_sims",
        "lock_sim",
        "release_sim_lock",
        "simrelay_login",
        "simrelay_logout",
        "subscribe_to_messages",
        "unsubscribe_from_messages",
        "wait_for_next_sms",
      ]);

      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_sims", arguments: {} },
      });
      const callRes = await readResponse(3);
      assert.ok(callRes.result, `list_sims result missing: ${JSON.stringify(callRes)}`);
      const structured = (callRes.result as { structuredContent: { sims: { phone_number: string }[] } })
        .structuredContent;
      assert.equal(structured.sims.length, 2);
      assert.equal(structured.sims[0]!.phone_number, "+49111");
    } finally {
      child.kill("SIGTERM");
      mock.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
