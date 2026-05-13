import { z } from "zod";

export const ListSimsInputSchema = {} as const;

export const LockSimInputSchema = {
  sim_id: z
    .number()
    .int()
    .positive()
    .describe("The integer hosted_sim_id of the SIM to lock"),
} as const;

export const ReleaseSimLockInputSchema = {
  sim_id: z
    .number()
    .int()
    .positive()
    .describe("The integer hosted_sim_id of the SIM whose lock to release"),
} as const;

export const GetSimMessagesInputSchema = {
  sim_id: z
    .number()
    .int()
    .positive()
    .describe("The integer hosted_sim_id whose messages to retrieve"),
  page: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based page number (default 1)"),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Messages per page, 1–100 (default 50)"),
} as const;

export const SubscribeToMessagesInputSchema = {
  sim_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional filter — only forward messages for this hosted_sim_id. Omit to receive all incoming SMS for the authenticated user.",
    ),
} as const;

export const UnsubscribeInputSchema = {} as const;

export const WaitForNextSmsInputSchema = {
  sim_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional filter — wait only for messages whose hosted_sim_id matches. Omit to accept any incoming SMS for the authenticated user.",
    ),
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(300)
    .optional()
    .describe("How long to wait, in seconds (default 60, max 300)."),
} as const;

export const GetRecentSmsInputSchema = {
  sim_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional filter — only return messages for this hosted_sim_id."),
  count: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Number of most-recent buffered messages to return (default 5, max 100)."),
} as const;

export interface NormalizedSim {
  id: number;
  phone_number: string | null;
  status: string | null;
  country: string | null;
  provider: string | null;
  type: string | null;
  /** Pivot-level alias from organizations[].alias (e.g. "Marketing line"). */
  alias: string | null;
  organization: { id: number; name: string } | null;
  team: { id: number; name: string } | null;
  messages_received_count: number | null;
  /** From GET /api/sims/{id}/lock — added by list_sims when available. */
  lock: SimLockStatus | null;
}

export type SimLockStatus =
  | { status: "unlocked" }
  | {
      status: "locked";
      lock_id?: number;
      user_id?: number;
      user_name?: string | null;
      expires_at?: string | null;
    };

export interface NormalizedMessage {
  id: number | string;
  sim_id: number | null;
  direction: "in" | "out" | null;
  from: string | null;
  to: string | null;
  text: string | null;
  received_at: string | null;
}

export interface RealtimeSmsEvent {
  event: "sms.received";
  sim_id: number | null;
  from: string | null;
  text: string | null;
  received_at: string | null;
  raw: unknown;
}

type Json = Record<string, unknown>;

function pickString(obj: Json, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function pickNumber(obj: Json, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v !== "" && !isNaN(Number(v))) return Number(v);
  }
  return null;
}

function pickRef(obj: Json, key: string): { id: number; name: string } | null {
  const v = obj[key];
  if (v && typeof v === "object") {
    const r = v as Json;
    const id = pickNumber(r, "id");
    const name = pickString(r, "name");
    if (id != null && name != null) return { id, name };
  }
  return null;
}

export function normalizeSim(raw: unknown): NormalizedSim {
  const r = (raw ?? {}) as Json;

  // Real API returns organizations[] / teams[] as arrays; OpenAPI doc and some
  // older callers used singular organization/team objects. Handle both.
  const orgsArr = Array.isArray(r.organizations) ? (r.organizations as Json[]) : null;
  const teamsArr = Array.isArray(r.teams) ? (r.teams as Json[]) : null;

  const firstOrg = orgsArr && orgsArr.length > 0 ? orgsArr[0] : null;
  const firstTeam = teamsArr && teamsArr.length > 0 ? teamsArr[0] : null;

  const organization =
    firstOrg !== null && firstOrg !== undefined
      ? (() => {
          const id = pickNumber(firstOrg, "id");
          const name = pickString(firstOrg, "name");
          if (id != null && name != null) return { id, name };
          return null;
        })()
      : pickRef(r, "organization");

  const team =
    firstTeam !== null && firstTeam !== undefined
      ? (() => {
          const id = pickNumber(firstTeam, "id");
          const name = pickString(firstTeam, "name");
          if (id != null && name != null) return { id, name };
          return null;
        })()
      : pickRef(r, "team");

  // Pivot-level alias lives on organizations[*].alias for the matching team.
  // Pick the first one (most users belong to a single org/team pair).
  const pivotAlias =
    firstOrg && firstOrg !== undefined ? pickString(firstOrg, "alias") : null;

  return {
    id: pickNumber(r, "id") ?? -1,
    phone_number: pickString(
      r,
      "seven_system_number",
      "number",
      "phone_number",
      "msisdn",
    ),
    status: pickString(r, "status", "state"),
    country: pickString(r, "country", "country_code", "iso_country"),
    provider: pickString(r, "provider", "carrier"),
    type: pickString(r, "type"),
    alias: pivotAlias ?? pickString(r, "alias", "label"),
    organization,
    team,
    messages_received_count: pickNumber(r, "messages_received_count"),
    lock: null,
  };
}

export function normalizeMessage(raw: unknown): NormalizedMessage {
  const r = (raw ?? {}) as Json;
  const dirRaw = pickString(r, "direction");
  const direction: NormalizedMessage["direction"] =
    dirRaw === "inbound" || dirRaw === "in" || dirRaw === "received"
      ? "in"
      : dirRaw === "outbound" || dirRaw === "out" || dirRaw === "sent"
        ? "out"
        : null;
  return {
    id: (pickNumber(r, "id") ?? pickString(r, "id") ?? "") || "",
    sim_id: pickNumber(r, "hosted_sim_id", "sim_id"),
    direction,
    from: pickString(r, "from", "sender", "from_number"),
    to: pickString(r, "to", "recipient", "to_number"),
    text: pickString(r, "text", "message_text", "body", "content"),
    received_at: pickString(
      r,
      "received_at",
      "created_at",
      "timestamp",
      "sent_at",
    ),
  };
}

export function extractMessageEventPayload(raw: unknown): RealtimeSmsEvent {
  const r = (raw ?? {}) as Json;
  return {
    event: "sms.received",
    sim_id: pickNumber(r, "hosted_sim_id", "sim_id"),
    from: pickString(r, "from", "sender", "from_number"),
    text: pickString(r, "message_text", "text", "body"),
    received_at: pickString(r, "received_at", "created_at", "timestamp"),
    raw,
  };
}
