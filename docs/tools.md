# Tool Reference

All inputs are validated with Zod. All tools return both `content` (pretty-printed JSON for legacy clients) and `structuredContent` (typed payload for modern clients).

---

## `list_sims`

Read-only · idempotent.

**Input:** none.

**Output:**

```json
{
  "count": 2,
  "sims": [
    {
      "id": 1,
      "phone_number": "+491701234567",
      "status": "active",
      "country": "DE",
      "provider": "seven.io",
      "type": "physical",
      "alias": "Main SIM",
      "organization": { "id": 1, "name": "Acme" },
      "team": { "id": 5, "name": "Auth" },
      "messages_received_count": 1273,
      "locked": false,
      "lock_expires_at": null
    }
  ]
}
```

The `id` field is the **`hosted_sim_id`** that you pass to `lock_sim`, `release_sim_lock`, and `get_sim_messages`. It is an integer, **not** the phone number.

---

## `lock_sim`

Destructive · not idempotent · changes server state.

**Input:**

| Field | Type | Required | Description |
|---|---|---|---|
| `sim_id` | integer ≥ 1 | yes | The `hosted_sim_id` to lock |

**Output:**

```json
{
  "status": "locked",
  "sim_id": 42,
  "lock": { "expires_at": "2026-05-12T10:05:00Z", "..." }
}
```

**Errors:**

- `403` → not enough permissions on this SIM
- `409` → already locked by another user; surface to the LLM via the error message

---

## `release_sim_lock`

Destructive (mutates state) · **idempotent**.

**Input:**

| Field | Type | Required | Description |
|---|---|---|---|
| `sim_id` | integer ≥ 1 | yes | The `hosted_sim_id` whose lock to release |

**Output:**

```json
{ "status": "released", "sim_id": 42 }
```

Calling it without an active lock returns success.

---

## `get_sim_messages`

Read-only · idempotent.

**Input:**

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `sim_id` | integer ≥ 1 | yes | — | `hosted_sim_id` |
| `page` | integer ≥ 1 | no | 1 | 1-based page index |
| `per_page` | integer 1–100 | no | 50 | Messages per page |

**Output:**

```json
{
  "sim_id": 42,
  "count": 2,
  "pagination": { "page": 1, "per_page": 50, "total": 173, "last_page": 4 },
  "messages": [
    {
      "id": 9001,
      "sim_id": 42,
      "direction": "in",
      "from": "+491701234567",
      "to": null,
      "text": "Your code is 4242",
      "received_at": "2026-05-12T09:59:55Z"
    }
  ]
}
```

`direction` is normalized to `"in"` (inbound / received) or `"out"` (outbound / sent), or `null` if unknown.

---

## `subscribe_to_messages`

Non-destructive · idempotent · open-world (long-lived).

**Input:**

| Field | Type | Required | Description |
|---|---|---|---|
| `sim_id` | integer ≥ 1 | no | If provided, only forward messages for this SIM |

**Output:**

```json
{
  "status": "subscribed",
  "state": "READY",
  "channel": "private-App.Models.User.7",
  "filter_sim_id": null,
  "delivery": "MCP notifications/message (logger=simrelay-sms)"
}
```

After this call returns, the server opens a Reverb (Pusher-protocol) WebSocket to SimRelay. Every incoming SMS is delivered to the MCP client as:

```json
{
  "method": "notifications/message",
  "params": {
    "level": "info",
    "logger": "simrelay-sms",
    "data": {
      "event": "sms.received",
      "sim_id": 42,
      "from": "+49170…",
      "text": "Code: 1234",
      "received_at": "2026-05-12T10:00:00Z",
      "raw": { ... }
    }
  }
}
```

Behavior:

- Calling `subscribe_to_messages` again with a different `sim_id` updates the filter without dropping the connection.
- If the WS disconnects, the server reconnects with exponential backoff (5 s → 60 s max).
- The server also keeps the last 100 events in an in-memory ring buffer (used internally; not currently exposed as a tool).

---

## `unsubscribe_from_messages`

Non-destructive · idempotent.

**Input:** none.

**Output:**

```json
{ "status": "unsubscribed", "state": "DISCONNECTED" }
```

The subscription is also stopped automatically on `SIGINT` / `SIGTERM`.
