import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import { SimRelayClient, SimRelayApiError } from "./simrelay-client.js";
import { RealtimeManager } from "./realtime.js";
import { TokenProvider, loadOAuthConfig, login } from "./oauth.js";
import { clearTokens, tokenFilePath } from "./tokens.js";
import {
  GetRecentSmsInputSchema,
  GetSimMessagesInputSchema,
  LockSimInputSchema,
  ReleaseSimLockInputSchema,
  SubscribeToMessagesInputSchema,
  ListSimsInputSchema,
  UnsubscribeInputSchema,
  WaitForNextSmsInputSchema,
} from "./types.js";

const SERVER_NAME = "simrelay-mcp-server";
const SERVER_VERSION = "2.0.10";

interface RingBufferItem {
  received_at: string;
  payload: unknown;
}

class RingBuffer<T> {
  private buf: T[] = [];
  constructor(private readonly capacity: number) {}
  push(item: T): void {
    this.buf.push(item);
    if (this.buf.length > this.capacity) this.buf.shift();
  }
  snapshot(): T[] {
    return [...this.buf];
  }
}

export function buildServer(): { server: McpServer; cleanup: () => void } {
  const oauthConfig = loadOAuthConfig();
  const tokenProvider = new TokenProvider(oauthConfig);
  const apiClient = new SimRelayClient(oauthConfig.apiBaseUrl, tokenProvider);
  const realtime = new RealtimeManager(apiClient);
  const recent = new RingBuffer<RingBufferItem>(100);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: { listChanged: false },
        logging: {},
      },
      instructions:
        "If any tool fails with 'Not authenticated', call simrelay_login first — it opens the user's browser to sign in to SimRelay. Then: use list_sims to discover available SIMs (id, phone_number, status, country). Use lock_sim before reading messages so other agents can't interfere; release_sim_lock when done. Use get_sim_messages for history. Use subscribe_to_messages to receive new SMS in real time — incoming messages are pushed as MCP logging notifications. Use simrelay_logout to forget tokens.",
    },
  );

  const mapApiError = (err: unknown): McpError => {
    if (err instanceof SimRelayApiError) {
      const code = err.status >= 500 ? ErrorCode.InternalError : ErrorCode.InvalidRequest;
      return new McpError(code, err.message, { status: err.status, body: err.body });
    }
    if (err instanceof Error) return new McpError(ErrorCode.InternalError, err.message);
    return new McpError(ErrorCode.InternalError, "Unknown error");
  };

  const textJson = (obj: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
    structuredContent: obj as Record<string, unknown>,
  });

  server.registerTool(
    "simrelay_login",
    {
      title: "Sign in to SimRelay",
      description:
        "Sign in to SimRelay via OAuth. Opens the user's default browser to the SimRelay authorization page; after they authorize, tokens are saved locally and refreshed automatically. Returns the path where tokens were stored. Call this when the user asks to log in or when another tool fails with 'Not authenticated'.",
      inputSchema: {},
      annotations: {
        title: "Sign in to SimRelay",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        await login(oauthConfig);
        return textJson({ status: "signed_in", token_file: tokenFilePath() });
      } catch (err) {
        throw new McpError(
          ErrorCode.InternalError,
          err instanceof Error ? err.message : "Login failed",
        );
      }
    },
  );

  server.registerTool(
    "simrelay_logout",
    {
      title: "Sign out of SimRelay",
      description:
        "Forget the saved SimRelay OAuth tokens. Idempotent — safe to call even when not signed in. After this, the next tool call that needs auth will require simrelay_login again.",
      inputSchema: {},
      annotations: {
        title: "Sign out of SimRelay",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      realtime.stop();
      await clearTokens();
      return textJson({ status: "signed_out", token_file: tokenFilePath() });
    },
  );

  server.registerTool(
    "list_sims",
    {
      title: "List SIMs",
      description:
        "List all SIMs the authenticated user can access, grouped by team. Each SIM includes id, phone_number, status, alias (organization-pivot label), organization, type, messages_received_count, and current lock state (unlocked, or locked-by-user with expiry). The response is structured as `groups: [{ team, sims: [...] }, ...]` plus a top-level flat `sims` array for convenience.",
      inputSchema: ListSimsInputSchema,
      annotations: {
        title: "List SIMs",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const { sims } = await apiClient.listSims();

        // Fan out lock-status fetches in parallel — N+1 but acceptable for the
        // typical SIM count (≤ tens). Failures don't block the listing.
        await Promise.all(
          sims.map(async (sim) => {
            try {
              const raw = await apiClient.getSimLock(sim.id);
              sim.lock =
                raw.status === "locked"
                  ? {
                      status: "locked",
                      lock_id: raw.lock_id,
                      user_id: raw.user_id,
                      user_name: raw.user_name ?? null,
                      expires_at: raw.expires_at ?? null,
                    }
                  : { status: "unlocked" };
            } catch {
              // best-effort enrichment — leave sim.lock as null on failure
            }
          }),
        );

        // Group by team. Sims with the same team_id land in the same bucket;
        // unteamed sims fall into a final null-team group.
        const buckets = new Map<string, { team: { id: number; name: string } | null; sims: typeof sims }>();
        for (const sim of sims) {
          const key = sim.team ? `t:${sim.team.id}` : "t:null";
          if (!buckets.has(key)) {
            buckets.set(key, { team: sim.team, sims: [] });
          }
          buckets.get(key)!.sims.push(sim);
        }
        const groups = [...buckets.values()].sort((a, b) => {
          if (a.team == null) return 1; // null team last
          if (b.team == null) return -1;
          return a.team.name.localeCompare(b.team.name);
        });
        // Stable secondary sort: within a team, sort sims by phone_number.
        for (const g of groups) {
          g.sims.sort((a, b) => (a.phone_number ?? "").localeCompare(b.phone_number ?? ""));
        }

        return textJson({ count: sims.length, groups, sims });
      } catch (err) {
        throw mapApiError(err);
      }
    },
  );

  server.registerTool(
    "lock_sim",
    {
      title: "Lock SIM",
      description:
        "Acquire an exclusive lock on a SIM so other users/agents cannot send or read messages on it. Locks expire automatically after the server-configured TTL (typically a few minutes). Use the integer hosted_sim_id from list_sims.",
      inputSchema: LockSimInputSchema,
      annotations: {
        title: "Lock SIM",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ sim_id }) => {
      try {
        const data = await apiClient.lockSim(sim_id);
        return textJson({ status: "locked", sim_id, lock: data });
      } catch (err) {
        throw mapApiError(err);
      }
    },
  );

  server.registerTool(
    "release_sim_lock",
    {
      title: "Release SIM Lock",
      description:
        "Release a previously acquired lock on a SIM. Idempotent — safe to call even if the lock has already expired or never existed.",
      inputSchema: ReleaseSimLockInputSchema,
      annotations: {
        title: "Release SIM Lock",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ sim_id }) => {
      try {
        await apiClient.releaseSimLock(sim_id);
        return textJson({ status: "released", sim_id });
      } catch (err) {
        throw mapApiError(err);
      }
    },
  );

  server.registerTool(
    "get_sim_messages",
    {
      title: "Get SIM Message History",
      description:
        "Retrieve historical SMS messages for a SIM, paginated. Returns a normalized list (id, sim_id, direction, from, to, text, received_at) plus pagination metadata.",
      inputSchema: GetSimMessagesInputSchema,
      annotations: {
        title: "Get SIM Message History",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ sim_id, page, per_page }) => {
      try {
        const result = await apiClient.getMessages(sim_id, { page, per_page });
        return textJson({
          sim_id,
          count: result.messages.length,
          pagination: result.pagination,
          messages: result.messages,
        });
      } catch (err) {
        throw mapApiError(err);
      }
    },
  );

  server.registerTool(
    "subscribe_to_messages",
    {
      title: "Subscribe to Incoming SMS",
      description:
        "Open (or reuse) a WebSocket subscription that streams new SMS for the authenticated user. Each incoming SMS is pushed as an MCP `notifications/message` (logger=simrelay-sms, level=info, JSON-encoded payload). Also kept in an internal ring buffer of the most recent 100. Pass sim_id to filter to a single SIM. Idempotent — calling again updates the filter and returns the current subscription state.",
      inputSchema: SubscribeToMessagesInputSchema,
      annotations: {
        title: "Subscribe to Incoming SMS",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ sim_id }) => {
      try {
        realtime.setFilter(sim_id);
        if (realtime.getState() !== "READY") {
          await realtime.start({ simIdFilter: sim_id });
        }
        return textJson({
          status: "subscribed",
          state: realtime.getState(),
          channel: realtime.getSubscribedChannel(),
          filter_sim_id: sim_id ?? null,
          delivery: "MCP notifications/message (logger=simrelay-sms)",
        });
      } catch (err) {
        throw mapApiError(err);
      }
    },
  );

  server.registerTool(
    "wait_for_next_sms",
    {
      title: "Wait for next incoming SMS",
      description:
        "Block until the next SMS arrives (optionally filtered by sim_id) and return its payload. Use this when an agent expects a code/OTP imminently — the call returns synchronously with the message so you don't have to poll. Ensures a WebSocket subscription is open before waiting; reuses any existing one. Default timeout is 60s, max 300s. Throws after the timeout if no matching SMS arrives.",
      inputSchema: WaitForNextSmsInputSchema,
      annotations: {
        title: "Wait for next incoming SMS",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ sim_id, timeout_seconds }) => {
      const timeoutMs = (timeout_seconds ?? 60) * 1000;
      try {
        if (realtime.getState() !== "READY") {
          await realtime.start({ simIdFilter: realtime.getState() === "DISCONNECTED" ? sim_id : undefined });
        }
        const event = await realtime.waitForNextSms(sim_id, timeoutMs);
        return textJson({ status: "received", event });
      } catch (err) {
        if (err instanceof Error && err.message === "timeout") {
          throw new McpError(
            ErrorCode.InternalError,
            `No matching SMS arrived within ${timeout_seconds ?? 60}s.`,
            { sim_id, timeout_seconds: timeout_seconds ?? 60 },
          );
        }
        throw mapApiError(err);
      }
    },
  );

  server.registerTool(
    "get_recent_sms",
    {
      title: "Get recent SMS from realtime buffer",
      description:
        "Return the N most-recent SMS messages captured by the WebSocket subscription in this server's lifetime (in-memory ring buffer, capacity 100). Filter by sim_id if provided. Returns an empty list if the subscription was never started or no matching SMS has arrived since startup. For historical messages persisted by SimRelay, use get_sim_messages instead.",
      inputSchema: GetRecentSmsInputSchema,
      annotations: {
        title: "Get recent SMS from realtime buffer",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sim_id, count }) => {
      const want = count ?? 5;
      const all = recent.snapshot();
      const filtered = sim_id == null
        ? all
        : all.filter((item) => {
            const payload = item.payload as { sim_id?: number | null } | undefined;
            return payload?.sim_id === sim_id;
          });
      const slice = filtered.slice(-want);
      return textJson({
        count: slice.length,
        filter_sim_id: sim_id ?? null,
        messages: slice.map((item) => item.payload),
      });
    },
  );

  server.registerTool(
    "get_subscription_status",
    {
      title: "Get subscription status",
      description:
        "Return the current WebSocket subscription state, the channel we're listening on, the active filter, and the most recent buffered SMS events. Useful for diagnosing why messages aren't arriving.",
      inputSchema: {},
      annotations: {
        title: "Get subscription status",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const snapshot = recent.snapshot();
      return textJson({
        state: realtime.getState(),
        channel: realtime.getSubscribedChannel(),
        recent_count: snapshot.length,
        recent: snapshot.slice(-10),
      });
    },
  );

  server.registerTool(
    "unsubscribe_from_messages",
    {
      title: "Unsubscribe from Incoming SMS",
      description:
        "Stop the real-time SMS stream and close the WebSocket. Idempotent — safe to call even if no subscription is active.",
      inputSchema: UnsubscribeInputSchema,
      annotations: {
        title: "Unsubscribe from Incoming SMS",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      realtime.stop();
      return textJson({ status: "unsubscribed", state: realtime.getState() });
    },
  );

  // Ring buffer holds EVERY incoming SMS (filter-independent) so
  // get_recent_sms / get_subscription_status work regardless of the active
  // subscribe filter.
  realtime.onAnySms((event) => {
    recent.push({ received_at: event.received_at ?? new Date().toISOString(), payload: event });
  });

  // MCP logging notification path respects the active subscribe filter.
  realtime.onSms((event) => {
    server.server
      .sendLoggingMessage({
        level: "info",
        logger: "simrelay-sms",
        data: event,
      })
      .catch(() => {
        // client may not have logging — drop silently
      });
  });

  // Surface raw WS lifecycle + frame events through MCP logging so misconfiguration
  // (wrong channel, filter eating events, silent disconnects) is visible in the
  // client. Volume is low: skips pings.
  realtime.onDebug((frame) => {
    server.server
      .sendLoggingMessage({
        level: "debug",
        logger: "simrelay-realtime",
        data: frame,
      })
      .catch(() => {
        // client may not subscribe to debug — drop silently
      });
  });

  const cleanup = () => {
    realtime.stop();
  };

  return { server, cleanup };
}
