# Real-time SMS Subscriptions

`subscribe_to_messages` opens a [Laravel Reverb](https://reverb.laravel.com) WebSocket (Pusher protocol v7) to SimRelay and forwards every inbound SMS to the MCP client as a logging notification. The implementation mirrors what the SimRelay Chrome extension does, so it's known to interop with the production back-end.

## Connection lifecycle

```
   DISCONNECTED
        │  start()
        ▼
   CONNECTING            ──► (HTTP errors / timeouts) ──► ERROR ──► scheduleReconnect()
        │  WS open
        ▼
   CONNECTED
        │  pusher:connection_established (capture socket_id)
        ▼
   SUBSCRIBING           ──► POST {auth_endpoint} with {socket_id, channel_name} for each template
        │  pusher_internal:subscription_succeeded
        ▼
      READY              ──► forward `sms.received` / `message.received` events
        │
        │  unexpected close (code != 1000)
        ▼
   DISCONNECTED ──► scheduleReconnect()
```

## Channel selection

SimRelay broadcasts on the user's private channel. The exact name is environment-dependent; the manager tries these templates in order and uses the first one that authorizes successfully:

1. `private-App.Models.User.{userId}` *(Laravel default — used in production)*
2. `private-user.{userId}`
3. `private-user-{userId}`

The user ID comes from `GET /api/user`.

## Auth on private channels

Per the Pusher protocol, subscribing to a `private-*` channel requires an `auth` token. The server POSTs to the `auth_endpoint` returned by `GET /api/websocket-config`, with `Authorization: Bearer <access_token>` and body:

```json
{ "socket_id": "<from pusher:connection_established>", "channel_name": "<private-…>" }
```

The response `{ "auth": "<signature>" }` is included in the `pusher:subscribe` event.

## Event delivery

Two event names are accepted and treated identically: `sms.received` and `message.received`. Payload fields are aliased:

| Reverb field | Normalized field |
|---|---|
| `hosted_sim_id` or `sim_id` | `sim_id` |
| `message_text` or `text` or `body` | `text` |
| `from` or `sender` or `from_number` | `from` |
| `received_at` or `created_at` or `timestamp` | `received_at` |

The full original payload is preserved in `raw`.

## Reconnect policy

- Base delay: 5 s.
- Backoff: doubles every attempt, capped at 60 s.
- Reset to 0 on every successful subscription.
- Skipped when the WebSocket was closed cleanly (`code === 1000`) or via `unsubscribe_from_messages`.

## Filtering

Pass `sim_id` to `subscribe_to_messages` to receive only events for a single SIM. Filtering happens client-side in the MCP server (the WS subscription is per-user, not per-SIM), so all events still cross the wire — the filter just suppresses notifications.

## In-memory ring buffer

The most recent 100 events are stored in memory. They're not currently exposed as a tool, but live inside `server.ts` if you want to wire up a `get_recent_received_messages` accessor.

## Limitations

- The MCP `notifications/message` logging channel was designed for log lines, not data — agents see `data` as a JSON blob inside a log entry. This works fine in Claude Desktop and Claude Code, but other clients may simply display the payload as a debug log.
- If you need richer per-message MCP semantics (e.g. resource updates), the cleanest upgrade path is to add a resource at `simrelay://messages/recent` and fire `notifications/resources/updated` on each event. The ring buffer is already in place to support that.
