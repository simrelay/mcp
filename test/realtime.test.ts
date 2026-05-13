import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { once } from "node:events";
import { AddressInfo } from "node:net";

import { RealtimeManager } from "../src/realtime.js";

function startMockReverbAndAuth() {
  const httpServer = createServer((req, res) => {
    if (req.url === "/auth") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body) as { channel_name?: string };
          if (parsed.channel_name === "private-App.Models.User.7") {
            res.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({ auth: "ok-auth" }),
            );
          } else {
            res.writeHead(403).end("nope");
          }
        } catch {
          res.writeHead(400).end();
        }
      });
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    ws.send(
      JSON.stringify({
        event: "pusher:connection_established",
        data: JSON.stringify({ socket_id: "socket-xyz" }),
      }),
    );

    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { event: string; data: { channel: string; auth: string } };
      if (msg.event === "pusher:subscribe") {
        ws.send(
          JSON.stringify({
            event: "pusher_internal:subscription_succeeded",
            channel: msg.data.channel,
            data: "{}",
          }),
        );
        // Small delay so tests have a chance to register listeners after
        // `await rt.start()` returns. setImmediate fires before the awaiter
        // can continue, which masks late-bound listeners.
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              event: "message.received",
              channel: msg.data.channel,
              data: JSON.stringify({
                hosted_sim_id: 42,
                message_text: "code: 4242",
                from: "+49123",
                received_at: "2026-05-12T10:00:00Z",
              }),
            }),
          );
        }, 50);
      }
    });
  });

  return new Promise<{ port: number; close: () => void }>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const port = (httpServer.address() as AddressInfo).port;
      resolve({
        port,
        close: () => {
          wss.close();
          httpServer.close();
        },
      });
    });
  });
}

describe("RealtimeManager", () => {
  it("connects, subscribes to user channel, and emits SMS events", async () => {
    const mock = await startMockReverbAndAuth();
    const fakeClient = {
      getBaseUrl: () => `http://127.0.0.1:${mock.port}`,
      getWebsocketConfig: async () => ({
        broadcaster: "reverb",
        key: "test-key",
        ws_host: "127.0.0.1",
        ws_port: mock.port,
        force_tls: false,
        auth_method: "bearer_token",
        auth_endpoint: `http://127.0.0.1:${mock.port}/auth`,
      }),
      getCurrentUser: async () => ({ id: 7, raw: {} }),
      authorizeChannel: async (authEndpoint: string, socketId: string, channelName: string) => {
        const res = await fetch(authEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ socket_id: socketId, channel_name: channelName }),
        });
        if (!res.ok) throw new Error("auth fail");
        return (await res.json()) as { auth: string };
      },
    };

    const rt = new RealtimeManager(fakeClient as never);
    const received: unknown[] = [];
    rt.onSms((e) => received.push(e));

    const readyPromise = new Promise<void>((resolve) => {
      rt.onStateChange((next) => {
        if (next === "READY") resolve();
      });
    });

    await rt.start();
    await readyPromise;

    assert.equal(rt.getSubscribedChannel(), "private-App.Models.User.7");

    // Wait briefly for the SMS push
    for (let i = 0; i < 20 && received.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.equal(received.length, 1);
    const event = received[0] as { sim_id: number; text: string };
    assert.equal(event.sim_id, 42);
    assert.equal(event.text, "code: 4242");

    rt.stop();
    mock.close();
  });

  it("waitForNextSms resolves with the next matching SMS and times out otherwise", async () => {
    const mock = await startMockReverbAndAuth();
    const fakeClient = {
      getBaseUrl: () => `http://127.0.0.1:${mock.port}`,
      getWebsocketConfig: async () => ({
        broadcaster: "reverb",
        key: "test-key",
        ws_host: "127.0.0.1",
        ws_port: mock.port,
        force_tls: false,
        auth_method: "bearer_token",
        auth_endpoint: `http://127.0.0.1:${mock.port}/auth`,
      }),
      getCurrentUser: async () => ({ id: 7, raw: {} }),
      authorizeChannel: async (authEndpoint: string, socketId: string, channelName: string) => {
        const res = await fetch(authEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ socket_id: socketId, channel_name: channelName }),
        });
        if (!res.ok) throw new Error("auth fail");
        return (await res.json()) as { auth: string };
      },
    };

    const rt = new RealtimeManager(fakeClient as never);
    await rt.start();

    // The mock pushes a single SMS with sim_id=42 right after subscribe.
    const event = await rt.waitForNextSms(42, 2000);
    assert.equal(event.sim_id, 42);
    assert.equal(event.text, "code: 4242");

    // No more events will arrive — waiting for a non-matching filter times out.
    await assert.rejects(() => rt.waitForNextSms(999, 100), /timeout/);

    rt.stop();
    mock.close();
  });
});
