# Recipes

Common patterns for using Netifly beyond the basic quickstart in
[Getting Started](../getting-started.md).

- [Email when offline](email-when-offline.md) — fall back to another
  channel when `send()` reports the user has no live connection.
  (`@netiflyjs/core` / `@netiflyjs/express`)
- [Notify from a BullMQ worker](notify-from-a-bullmq-worker.md) — publish
  from a process that doesn't hold a WebSocket server.
  (`@netiflyjs/core`)
- [Handling reconnects and token refresh](client-reconnects-and-token-refresh.md)
  — a visible "reconnecting…" state, refreshing short-lived tokens, and
  capping retries. (`@netiflyjs/client`)
- [Building a notification inbox](react-notification-inbox.md) — an unread
  badge and actionable notifications with `useNotifications()`.
  (`@netiflyjs/react`)
