# Publishing patterns: single, multiple, two-way

Every pattern below is built from the same two primitives —
[`send()`/`sendOr()`](../reference/core.md#createnetiflyeventsoptions) for
app-internal events, [`notify()`/`notifyOr()`](../reference/core.md#events-vs-notifications)
for user-facing ones — called differently depending on who's receiving
and whether you expect an answer back.

## Single user

The baseline case: one user, one notification.

```ts
await netifly.notify(userId, {
  kind: 'info',
  title: 'Export ready',
  body: 'Your March report has finished generating.',
  link: { href: '/reports/123', label: 'Open' },
});
```

This reaches **every connection that user has open** — desktop, mobile,
multiple browser tabs — automatically; there's nothing extra to do for
multi-device. It does *not* reach the user if they're offline everywhere
— see [Persistence](persistence.md) for what "offline" means here and
[Recipe: email when offline](../recipes/email-when-offline.md) for a
fallback.

## Multiple users (fan-out)

There is **no batch/broadcast API** — `send()`/`notify()` take exactly
one `userId`. Fanning out to many users today means looping, with
`Promise.all` (or a concurrency limiter for large lists) to avoid doing
it one at a time:

```ts
async function notifyTeam(teamId: string, notification: Notification) {
  const memberIds = await db.teamMembers.listUserIds(teamId);
  const results = await Promise.all(
    memberIds.map((userId) => netifly.notify(userId, notification)),
  );
  return results; // one SendResult per user — see the caveats below
}
```

For a large list (thousands of users), bound the concurrency instead of
firing everything at once — e.g. with [`p-limit`](https://www.npmjs.com/package/p-limit):

```ts
import pLimit from 'p-limit';

const limit = pLimit(50); // at most 50 concurrent sends
await Promise.all(memberIds.map((userId) => limit(() => netifly.notify(userId, notification))));
```

**What this pattern does *not* give you:**

- **No atomicity.** Each `notify()` is an independent Redis publish; some users can succeed while others fail (a thrown `NotificationValidationError`, say, affects only that one call, not the batch — but a rejected promise anywhere in the array still rejects `Promise.all` unless you catch per-call).
- **No partial-failure reporting built in.** `Promise.allSettled` instead of `Promise.all` if you need to know exactly which `userId`s succeeded.
- **No dedup/rate limiting** — a list with a duplicate `userId` sends to them twice; nothing in Netifly notices.

## Multiple notifications to one user, over time

This is a different "multiple" — not many recipients, but many
notifications accumulating for the *same* user, which is what a
notification inbox actually displays. Netifly has no concept of this at
all: there is no "list my notifications" call anywhere in the API,
because there's nothing stored to list (see [Persistence](persistence.md)
for why). The inbox you render is built entirely by your own app:

1. Your backend inserts a row per notification, in the `on('sent', ...)` hook.
2. Your frontend loads the backlog from **your own API** (a normal `GET /notifications`, not anything Netifly provides) when a component mounts.
3. `useNotifications()` (or `onNotification`) layers *new, live* notifications on top of that backlog as they arrive, for as long as the socket stays connected.

```tsx
function Inbox() {
  const { items: live } = useNotifications(); // live-only, in-memory, since this mount
  const [history, setHistory] = useState<StoredNotification[]>([]);

  useEffect(() => {
    fetch('/api/notifications').then((r) => r.json()).then(setHistory);
  }, []);

  // Merge by id (the envelope's ULID is stable and sortable) so a
  // notification that arrived live isn't duplicated once a refetch
  // also returns it.
  const merged = mergeById(history, live);
  // ...render merged
}
```

See [Persistence](persistence.md) for the backend half of this (the
schema, and exactly which hook writes which field).

## Two-way: actionable notifications

For the cases above, the user is a passive recipient. An **actionable**
notification expects an answer, verified server-side before your app
acts on it:

```ts
await netifly.notify(userId, {
  kind: 'action',
  title: 'Approve expense £420?',
  body: 'Submitted by Sam for Client dinner',
  actions: [
    { id: 'approve', label: 'Approve', style: 'primary' },
    { id: 'reject', label: 'Reject', style: 'danger' },
  ],
  expiresAt: Date.now() + 24 * 3600_000,
  context: { expenseId: 'exp_123' },
});

netifly.on('action', ({ actionId, context }) => {
  db.expenses.update((context as { expenseId: string }).expenseId, { status: actionId });
});
```

The client renders `action.token` and echoes it back via
`respondToAction()`; the server verifies the signature, that the
answering user matches, that it hasn't expired, and that nobody has
answered it already (see
[`core`'s Actionable notifications](../reference/core.md#actionable-notifications)
for the full cryptographic detail). There's also a lower-ceremony
two-way shape — `client.respond(id, payload)` → the server's `'response'`
event — for a free-form reply that isn't a fixed set of action buttons
(e.g. a text input), with no signing/verification, since it doesn't
authorize anything on its own.

## See also

- [Hooks](hooks.md) — which backend/frontend event fires for each pattern above.
- [Persistence](persistence.md) — where the "multiple over time" history actually lives.
- [Recipe: email when offline](../recipes/email-when-offline.md) · [Recipe: notify from a BullMQ worker](../recipes/notify-from-a-bullmq-worker.md)
