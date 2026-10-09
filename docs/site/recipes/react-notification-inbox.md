# Recipe: building a notification inbox

**Package:** [`@netiflyjs/react`](../reference/react.md)

`useNotifications()` already tracks unread state, actionable notifications,
and expiry for you — this recipe wires it into a rendered inbox with an
unread badge and Approve/Reject-style actions, the same shape as the
runnable [`examples/react`](https://github.com/NetiflyJS/netifly/tree/main/examples/react)
app.

## Full example

```tsx
import { NetiflyProvider, useNetifly, useNotifications } from '@netiflyjs/react';

function App() {
  return (
    <NetiflyProvider url="wss://api.example.com/netifly" getToken={() => session.accessToken}>
      <Inbox />
    </NetiflyProvider>
  );
}

function Inbox() {
  const { status } = useNetifly();
  const { items, unreadCount, markRead, dismiss, respond } = useNotifications();

  return (
    <>
      <p>
        connection status: <strong>{status}</strong> · unread:{' '}
        <strong>{unreadCount}</strong>
      </p>

      {/* aria-live="polite" per the WAI-ARIA alert pattern: new notifications
          are announced without stealing focus from whatever the user is doing. */}
      <section aria-live="polite" aria-label="Notifications">
        {items.map((item) => (
          <article key={item.id} data-status={item.status}>
            <strong>{item.notification.title}</strong>
            <p>{item.notification.body}</p>

            {item.notification.kind === 'action' ? (
              item.status === 'answered' ? (
                <em>Answered</em>
              ) : (
                item.notification.actions.map((action) => (
                  <button key={action.id} onClick={() => void respond(item.id, action.id)}>
                    {action.label}
                  </button>
                ))
              )
            ) : (
              item.status === 'unread' && <button onClick={() => markRead(item.id)}>Mark read</button>
            )}

            <button onClick={() => dismiss(item.id)}>Dismiss</button>
          </article>
        ))}
      </section>
    </>
  );
}
```

## Notes

- `items` is shared across every component that calls `useNotifications()` under the same `<NetiflyProvider>` — you can split the badge and the list into separate components without prop-drilling or duplicating the subscription.
- `respond()` resolves to `'accepted' | 'already_answered' | 'expired' | 'invalid'` — check it if you want to show an error toast on `'expired'`/`'invalid'` rather than assuming every click succeeds.
- An item flips to `'expired'` on its own once `expiresAt` passes, and to `'answered'` when the server relays `netifly.notification.resolved` (e.g. the user answered from a different tab) — both update the UI with no extra code on your part.
- `dismiss()` is local-only — it doesn't tell the server anything, so a dismissed item can come back if you re-fetch/replay history later. If you need "dismissed" to persist, track dismissed ids yourself (e.g. in `localStorage` or your backend) alongside this hook.

See the [`react` reference](../reference/react.md) for the full
`useNotifications()`/`useEvent()`/`useNetifly()` API.
