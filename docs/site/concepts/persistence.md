# Persistence

**Netifly does not persist anything, anywhere, ever.** Not notifications,
not read state, not a connection history. This is deliberate — the same
"bring your own X" philosophy as `resolveUserId` (bring your own auth):
Netifly brings your own database, too. This page covers what that means
in practice, and where today's real gaps are.

## What's actually ephemeral

- **The message itself.** `send()`/`notify()` publish once, over Redis
  pub/sub, to whichever server instances currently hold a live connection
  for that user. If none do, the message is gone — not queued, not
  retried.
- **Presence (`isOnline`/`whoIsOnline`).** Backed by `PUBSUB NUMSUB`, not
  a stored row, and only accurate within the ~30s heartbeat interval. It
  answers "is this user connected right now," never "was this user
  online at 3pm yesterday."
- **The React `useNotifications()` store.** A plain in-memory object,
  one per `<NetiflyProvider>`. A page refresh empties it. It reflects
  only what arrived *since this socket connected* — never a backlog from
  before that.
- **`client.lastEventId`.** Tracked on the client, but not acted on —
  there's no "resume from this id" call anywhere yet (see
  [Known gaps](#known-gaps) below).

If your app needs any of "what did I miss," "mark as read, and remember
that," or "show me my last 30 notifications," none of it comes from
Netifly. It comes from a database you own, fed by the hooks below.

## Wiring persistence through the hooks

Five backend hooks (see [Hooks](hooks.md#backend-hooks-netiflyinstanceon))
map directly onto the lifecycle of one stored row:

| Hook | What to do |
| --- | --- |
| `on('sent', { userId, id, type, data })` | **Insert.** `id` is a sortable ULID — use it as your primary key or a unique index; it's stable across the whole lifecycle below. |
| `on('delivered', { userId, id, ts })` | **Update** status to `delivered` (only if not already `read`/`answered` — see the ordering caveat below). |
| `on('read', { userId, id, ts })` | **Update** status to `read`. |
| `on('response', { userId, id, payload, ts })` | **Update/insert** the free-form reply. |
| `on('action', { userId, notificationId, actionId, context })` | **Update** status to `answered`, recording `actionId`. |

A minimal schema:

```sql
CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,   -- the envelope's ULID from 'sent'
  user_id     TEXT NOT NULL,
  type        TEXT NOT NULL,      -- 'notification' for notify(), or your own event name
  payload     JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'sent', -- sent | delivered | read | answered | expired
  action_id   TEXT,               -- set once answered, for actionable notifications
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```ts
netifly.on('sent', ({ userId, id, type, data }) => {
  db.notifications.insert({ id, userId, type, payload: data, status: 'sent' });
});

netifly.on('delivered', ({ id }) => {
  db.notifications.updateIfLowerStatus(id, 'delivered'); // don't downgrade 'read' back to 'delivered'
});

netifly.on('read', ({ id }) => {
  db.notifications.update(id, { status: 'read' });
});

netifly.on('action', ({ notificationId, actionId }) => {
  db.notifications.update(notificationId, { status: 'answered', actionId });
});
```

**Ordering caveat**: `delivered`/`read`/`response`/`action` can arrive in
any order relative to each other — e.g. a fast client can send `read`
before your `delivered` handler's write has committed — and the
multi-tab relay (see
[`core`'s Client acks and read state](../reference/core.md#client-acks-and-read-state))
means the *same* `delivered`/`read` event can fire once per open tab for
one logical notification. Write handlers that are safe to run more than
once, in any order (`UPDATE ... WHERE status NOT IN ('read','answered')`
rather than an unconditional `UPDATE`), rather than assuming a strict
`sent → delivered → read` sequence.

## Loading history on the frontend

Because there's no "list my notifications" API, the read side is a
normal endpoint you write — Netifly has no part in it:

```ts
app.get('/api/notifications', async (req, res) => {
  const items = await db.notifications.listForUser(req.user.id, { limit: 30 });
  res.json(items);
});
```

Pair that with live updates per
[Multiple notifications to one user, over time](publishing-patterns.md#multiple-notifications-to-one-user-over-time)
— fetch the backlog on mount, then merge in whatever
`useNotifications()`/`onNotification` delivers live. Merge by `id`, not
by append-only, since a notification sent moments before the fetch could
show up in both.

## Known gaps

These are current limitations, not configuration you're missing:

- **No replay-on-reconnect.** `lastEventId` is tracked client-side but
  nothing resumes from it — a notification sent while a user was fully
  disconnected (not just between tabs) is only recoverable through
  *your* persisted history endpoint above, never through Netifly
  re-delivering it. Source comments mark this planned for a future
  version.
- **No idempotency guarantee on repeated acks.** The multi-tab relay and
  client retries mean your `on('delivered'|'read'|'response')` handlers
  can see the same `id` more than once — this is an accepted, documented
  non-goal (see the NOT-30 client-acks-read-state design), not an edge
  case to work around upstream. Your writes need to tolerate it (see the
  ordering caveat above).
- **No cross-device read-state reconciliation beyond the relay.** If a
  user reads a notification on a device that's currently offline, no
  other device learns about it until that device reconnects and you've
  built your own sync on top of the stored `status` — the relay only
  covers devices that are connected *at the moment* of the read.
- **`useNotifications()`'s store is never a substitute for the database
  above** — it's a convenience for *new* arrivals during the current
  session, not a cache of your backend's data. Don't skip the
  `GET /api/notifications`-style endpoint assuming the hook covers it.

## See also

- [Hooks](hooks.md)
- [Publishing patterns](publishing-patterns.md)
- [`core` reference — Client acks and read state](../reference/core.md#client-acks-and-read-state)
