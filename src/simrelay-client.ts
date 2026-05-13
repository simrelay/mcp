import type { TokenProvider } from "./oauth.js";
import {
  normalizeSim,
  normalizeMessage,
  type NormalizedSim,
  type NormalizedMessage,
} from "./types.js";

export interface WebsocketConfig {
  broadcaster: string;
  key: string;
  ws_url?: string;
  ws_host: string;
  ws_port: number;
  ws_scheme?: string;
  force_tls: boolean;
  auth_method: string;
  auth_header?: string;
  auth_endpoint: string;
}

export interface ListSimsResult {
  sims: NormalizedSim[];
  raw: unknown;
}

export interface GetMessagesResult {
  messages: NormalizedMessage[];
  pagination: {
    page: number | null;
    per_page: number | null;
    total: number | null;
    last_page: number | null;
  };
  raw: unknown;
}

export class SimRelayApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "SimRelayApiError";
  }
}

export class SimRelayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly tokens: TokenProvider,
  ) {}

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.tokens.getAccessToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("accept", "application/json");
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });

    let body: unknown = undefined;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!res.ok) {
      const message =
        (body && typeof body === "object" && "message" in body && typeof (body as { message: unknown }).message === "string"
          ? (body as { message: string }).message
          : null) ?? `SimRelay request failed: ${res.status} ${res.statusText}`;
      throw new SimRelayApiError(message, res.status, body);
    }

    return body as T;
  }

  async listSims(): Promise<ListSimsResult> {
    const raw = await this.request<unknown>("/api/sims");
    const arr = extractArray(raw);
    return { sims: arr.map(normalizeSim), raw };
  }

  async lockSim(simId: number): Promise<unknown> {
    return this.request<unknown>(`/api/sims/${simId}/lock`, { method: "POST", body: "{}" });
  }

  async getSimLock(simId: number): Promise<{
    status: string;
    lock_id?: number;
    user_id?: number;
    user_name?: string | null;
    expires_at?: string;
  }> {
    return this.request(`/api/sims/${simId}/lock`);
  }

  async releaseSimLock(simId: number): Promise<unknown> {
    return this.request<unknown>(`/api/sims/${simId}/lock`, { method: "DELETE" });
  }

  async getMessages(
    simId: number,
    opts: { page?: number; per_page?: number } = {},
  ): Promise<GetMessagesResult> {
    const params = new URLSearchParams();
    if (opts.page != null) params.set("page", String(opts.page));
    if (opts.per_page != null) params.set("per_page", String(opts.per_page));
    const qs = params.toString();
    const path = `/api/sims/${simId}/messages${qs ? `?${qs}` : ""}`;
    const raw = await this.request<unknown>(path);
    const arr = extractArray(raw);
    const meta = extractPaginationMeta(raw);
    return {
      messages: arr.map(normalizeMessage),
      pagination: meta,
      raw,
    };
  }

  async getCurrentUser(): Promise<{ id: number; raw: unknown }> {
    const raw = await this.request<unknown>("/api/user");
    const user = unwrapUser(raw);
    const id = extractUserId(user);
    if (id == null) {
      const rootKeys =
        raw && typeof raw === "object"
          ? Object.keys(raw as Record<string, unknown>).join(",")
          : typeof raw;
      const userKeys = user ? Object.keys(user).join(",") : "(none)";
      throw new SimRelayApiError(
        `Could not determine user ID from /api/user response (root keys: ${rootKeys}; user keys: ${userKeys})`,
        200,
        raw,
      );
    }
    return { id, raw };
  }

  async getWebsocketConfig(): Promise<WebsocketConfig> {
    return this.request<WebsocketConfig>("/api/websocket-config");
  }

  async authorizeChannel(
    authEndpoint: string,
    socketId: string,
    channelName: string,
  ): Promise<{ auth: string }> {
    const token = await this.tokens.getAccessToken();
    const res = await fetch(authEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ socket_id: socketId, channel_name: channelName }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new SimRelayApiError(
        `Channel auth failed for ${channelName}`,
        res.status,
        text,
      );
    }
    return (await res.json()) as { auth: string };
  }
}

function extractArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as { data?: unknown; items?: unknown };
    if (Array.isArray(obj.data)) return obj.data;
    if (Array.isArray(obj.items)) return obj.items;
  }
  return [];
}

function unwrapUser(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  for (const key of ["data", "user"]) {
    const v = obj[key];
    if (v && typeof v === "object") return v as Record<string, unknown>;
  }
  return obj;
}

function extractUserId(user: Record<string, unknown> | null): number | null {
  if (!user) return null;
  for (const key of ["id", "user_id", "uid", "identifier"]) {
    const v = user[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    if (typeof v === "string" && v !== "") {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

function extractPaginationMeta(raw: unknown): GetMessagesResult["pagination"] {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const meta = (obj.meta ?? obj) as Record<string, unknown>;
    const numOrNull = (v: unknown) => (typeof v === "number" ? v : null);
    return {
      page: numOrNull(meta.current_page ?? meta.page),
      per_page: numOrNull(meta.per_page),
      total: numOrNull(meta.total),
      last_page: numOrNull(meta.last_page ?? meta.total_pages),
    };
  }
  return { page: null, per_page: null, total: null, last_page: null };
}
