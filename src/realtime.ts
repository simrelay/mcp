import { WebSocket } from "ws";

import type { SimRelayClient, WebsocketConfig } from "./simrelay-client.js";
import { extractMessageEventPayload, type RealtimeSmsEvent } from "./types.js";

const CHANNEL_TEMPLATES = [
  "private-App.Models.User.{userId}",
  "private-user.{userId}",
  "private-user-{userId}",
];

const EVENTS = {
  PING: "pusher:ping",
  PONG: "pusher:pong",
  CONNECTION_ESTABLISHED: "pusher:connection_established",
  SUBSCRIBE: "pusher:subscribe",
  SUBSCRIPTION_SUCCEEDED: "pusher_internal:subscription_succeeded",
  SUBSCRIPTION_SUCCEEDED_ALT: "pusher:subscription_succeeded",
  SUBSCRIPTION_ERROR: "pusher:subscription_error",
  SUBSCRIPTION_ERROR_ALT: "pusher_internal:subscription_error",
  SMS_RECEIVED: "sms.received",
  MESSAGE_RECEIVED: "message.received",
} as const;

const TIMING = {
  CONNECT_TIMEOUT_MS: 10_000,
  RECONNECT_BASE_MS: 5_000,
  RECONNECT_MAX_MS: 60_000,
} as const;

export type RealtimeState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "SUBSCRIBING"
  | "READY"
  | "ERROR";

export interface RealtimeOptions {
  /** Filter — only forward events whose sim_id matches. */
  simIdFilter?: number;
}

export interface DebugFrame {
  kind: "ws_frame" | "ws_open" | "ws_close" | "ws_error" | "filter_skip" | "subscribe_attempt" | "subscribe_ok" | "subscribe_fail";
  event?: string;
  channel?: string;
  payload_keys?: string[];
  sim_id?: number | null;
  filter_sim_id?: number | null;
  detail?: string;
}

export type SmsListener = (event: RealtimeSmsEvent) => void;
export type StateListener = (next: RealtimeState, prev: RealtimeState) => void;
export type DebugListener = (frame: DebugFrame) => void;

export function buildWsUrl(cfg: WebsocketConfig, apiBaseUrl: string): string {
  const query = `protocol=7&client=js&version=8.4.0&flash=false`;
  const path = `/reverb/app/${cfg.key}`;

  // Preferred: use ws_url from /api/websocket-config when it's a usable public
  // origin. SimRelay publishes the right edge URL there (e.g. wss://simrelay.com).
  if (cfg.ws_url) {
    try {
      const u = new URL(cfg.ws_url);
      const isLoopback = u.hostname === "localhost" || u.hostname === "127.0.0.1";
      if (!isLoopback && (u.protocol === "ws:" || u.protocol === "wss:")) {
        // Strip any existing path/query — we always append our own.
        return `${u.protocol}//${u.host}${path}?${query}`;
      }
    } catch {
      // fall through to legacy construction
    }
  }

  // Fallback: stitch from ws_host/ws_port/force_tls. Mirror chrome extension's
  // localhost override — but only when the API base URL is *not* also on
  // localhost. That preserves "everything-on-localhost" dev setups while
  // still rewriting internal Reverb bind addresses to the public API host in
  // production.
  let scheme: "ws" | "wss" = cfg.force_tls || cfg.ws_scheme === "https" ? "wss" : "ws";
  let host = cfg.ws_host;
  let port: number | null = cfg.ws_port;

  const apiHost = new URL(apiBaseUrl).hostname;
  const apiIsLocal = apiHost === "localhost" || apiHost === "127.0.0.1";

  if ((host === "localhost" || host === "127.0.0.1") && !apiIsLocal) {
    host = apiHost;
    scheme = "wss";
    port = null;
  }

  const isDefaultPort =
    (scheme === "wss" && port === 443) || (scheme === "ws" && port === 80);
  const portSuffix = port == null || isDefaultPort ? "" : `:${port}`;

  return `${scheme}://${host}${portSuffix}${path}?${query}`;
}

export class RealtimeManager {
  private ws: WebSocket | null = null;
  private state: RealtimeState = "DISCONNECTED";
  private socketId: string | null = null;
  private subscribedChannel: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private intentionallyClosed = false;
  private readonly listeners = new Set<SmsListener>();
  /** Bypass the global filter — used by waitForNextSms which applies its own. */
  private readonly rawListeners = new Set<SmsListener>();
  private readonly stateListeners = new Set<StateListener>();
  private readonly debugListeners = new Set<DebugListener>();
  private options: RealtimeOptions = {};
  private connectPromise: Promise<void> | null = null;

  constructor(private readonly client: SimRelayClient) {}

  onDebug(listener: DebugListener): () => void {
    this.debugListeners.add(listener);
    return () => this.debugListeners.delete(listener);
  }

  private emitDebug(frame: DebugFrame): void {
    for (const l of this.debugListeners) {
      try {
        l(frame);
      } catch {
        // ignore
      }
    }
  }

  getState(): RealtimeState {
    return this.state;
  }

  getSubscribedChannel(): string | null {
    return this.subscribedChannel;
  }

  onSms(listener: SmsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  setFilter(simIdFilter: number | undefined): void {
    this.options.simIdFilter = simIdFilter;
  }

  /** Register a listener that receives every SMS event (bypasses global filter). */
  onAnySms(listener: SmsListener): () => void {
    this.rawListeners.add(listener);
    return () => this.rawListeners.delete(listener);
  }

  /**
   * Resolve with the next SMS event matching `simIdFilter` (or any SMS if
   * the filter is undefined). Rejects with `timeout` if nothing matches
   * within `timeoutMs`. Independent of the global subscription filter.
   */
  waitForNextSms(
    simIdFilter: number | undefined,
    timeoutMs: number,
  ): Promise<RealtimeSmsEvent> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        settle(() => reject(new Error("timeout")));
      }, timeoutMs);

      const unsubscribe = this.onAnySms((event) => {
        if (simIdFilter != null && event.sim_id !== simIdFilter) return;
        settle(() => resolve(event));
      });
    });
  }

  private setState(next: RealtimeState): void {
    const prev = this.state;
    if (prev === next) return;
    this.state = next;
    for (const l of this.stateListeners) l(next, prev);
  }

  async start(options: RealtimeOptions = {}): Promise<void> {
    this.options = options;
    this.intentionallyClosed = false;
    if (this.state === "READY") return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.establish().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  stop(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.socketId = null;
    this.subscribedChannel = null;
    this.setState("DISCONNECTED");
    this.reconnectAttempts = 0;
  }

  private async establish(): Promise<void> {
    this.setState("CONNECTING");

    const [cfg, user] = await Promise.all([
      this.client.getWebsocketConfig(),
      this.client.getCurrentUser(),
    ]);

    const wsUrl = buildWsUrl(cfg, this.client.getBaseUrl());
    this.emitDebug({ kind: "subscribe_attempt", detail: `ws_url=${wsUrl}` });
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      const connectTimeout = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // ignore
        }
        reject(new Error("WebSocket connection timed out"));
      }, TIMING.CONNECT_TIMEOUT_MS);

      ws.on("open", () => {
        this.setState("CONNECTED");
        this.emitDebug({ kind: "ws_open" });
      });

      ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
        this.handleMessage(raw, cfg, user.id, connectTimeout, resolve, reject).catch((err) => {
          // eslint-disable-next-line no-console
          console.error("realtime: message handler error", err);
          this.emitDebug({ kind: "ws_error", detail: `handler: ${err instanceof Error ? err.message : String(err)}` });
        });
      });

      ws.on("close", (code) => {
        clearTimeout(connectTimeout);
        this.ws = null;
        this.socketId = null;
        const wasReady = this.state === "READY";
        this.setState("DISCONNECTED");
        this.emitDebug({ kind: "ws_close", detail: `code=${code} wasReady=${wasReady}` });
        if (!this.intentionallyClosed && code !== 1000) {
          this.scheduleReconnect();
        }
        if (!wasReady) {
          reject(new Error(`WebSocket closed during setup (code ${code})`));
        }
      });

      ws.on("error", (err) => {
        // eslint-disable-next-line no-console
        console.error("realtime: socket error", err.message);
        this.setState("ERROR");
        this.emitDebug({ kind: "ws_error", detail: err.message });
      });
    });
  }

  private async handleMessage(
    raw: Buffer | ArrayBuffer | Buffer[],
    cfg: WebsocketConfig,
    userId: number,
    connectTimeout: NodeJS.Timeout,
    resolveStart: () => void,
    rejectStart: (err: Error) => void,
  ): Promise<void> {
    const text = Array.isArray(raw)
      ? Buffer.concat(raw).toString("utf8")
      : Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : Buffer.from(raw as ArrayBuffer).toString("utf8");

    let data: { event?: string; channel?: string; data?: string };
    try {
      data = JSON.parse(text);
    } catch {
      this.emitDebug({ kind: "ws_frame", detail: "non-JSON frame" });
      return;
    }

    // Trace every frame except pings (too noisy). Keeps the surface minimal:
    // only event/channel names, no message contents.
    if (data.event !== EVENTS.PING) {
      this.emitDebug({
        kind: "ws_frame",
        event: data.event,
        channel: data.channel,
      });
    }

    if (data.event === EVENTS.PING) {
      this.ws?.send(JSON.stringify({ event: EVENTS.PONG }));
      return;
    }

    if (data.event === EVENTS.CONNECTION_ESTABLISHED) {
      clearTimeout(connectTimeout);
      try {
        const conn = JSON.parse(data.data ?? "{}") as { socket_id: string };
        this.socketId = conn.socket_id;
        await this.subscribeToUserChannel(cfg, userId);
      } catch (err) {
        rejectStart(err as Error);
      }
      return;
    }

    if (
      data.event === EVENTS.SUBSCRIPTION_SUCCEEDED ||
      data.event === EVENTS.SUBSCRIPTION_SUCCEEDED_ALT
    ) {
      this.subscribedChannel = data.channel ?? null;
      this.reconnectAttempts = 0;
      this.setState("READY");
      resolveStart();
      return;
    }

    if (
      data.event === EVENTS.SUBSCRIPTION_ERROR ||
      data.event === EVENTS.SUBSCRIPTION_ERROR_ALT
    ) {
      rejectStart(new Error("Reverb subscription failed"));
      try {
        this.ws?.close();
      } catch {
        // ignore
      }
      return;
    }

    if (
      data.channel?.startsWith("private-") &&
      (data.event === EVENTS.SMS_RECEIVED || data.event === EVENTS.MESSAGE_RECEIVED)
    ) {
      try {
        const payload = JSON.parse(data.data ?? "{}") as Record<string, unknown>;
        const event = extractMessageEventPayload(payload);
        // Raw listeners always see every event (used by waitForNextSms and the
        // ring buffer so they're filter-independent).
        for (const l of this.rawListeners) l(event);
        if (this.options.simIdFilter != null && event.sim_id !== this.options.simIdFilter) {
          this.emitDebug({
            kind: "filter_skip",
            event: data.event,
            channel: data.channel,
            sim_id: event.sim_id,
            filter_sim_id: this.options.simIdFilter,
            payload_keys: Object.keys(payload),
          });
          return;
        }
        for (const l of this.listeners) l(event);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("realtime: failed to parse SMS payload", err);
      }
    }
  }

  private async subscribeToUserChannel(cfg: WebsocketConfig, userId: number): Promise<void> {
    this.setState("SUBSCRIBING");
    for (const tpl of CHANNEL_TEMPLATES) {
      const channelName = tpl.replace("{userId}", String(userId));
      try {
        if (!this.socketId) throw new Error("Missing socket_id");
        const { auth } = await this.client.authorizeChannel(
          cfg.auth_endpoint,
          this.socketId,
          channelName,
        );
        this.ws?.send(
          JSON.stringify({
            event: EVENTS.SUBSCRIBE,
            data: { channel: channelName, auth },
          }),
        );
        return;
      } catch {
        // try next template
      }
    }
    throw new Error("Failed to authorize any user channel template");
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      TIMING.RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
      TIMING.RECONNECT_MAX_MS,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start(this.options).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("realtime: reconnect failed", err);
        this.scheduleReconnect();
      });
    }, delay);
  }
}
