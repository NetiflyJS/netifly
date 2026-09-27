# Recipe: email when offline

> **Status:** stub — outline below, full runnable example to follow.

`send()` tells you at publish time whether a user was reachable over a live
WebSocket connection anywhere in your cluster (see the `SendResult` /
`delivered` field in the [`core` reference](../reference/core.md)).
`sendOr()` is sugar for the common "fall back to email/push when the user
isn't online" pattern, so you don't have to branch on `delivered` yourself:

```ts
await netifly.sendOr(userId, 'invoice.ready', data, {
  offline: () => sendEmail(userId, 'Your invoice is ready', data),
});
```

`offline` is only called — and awaited, if it returns a promise — when
nobody held a live connection for `userId` anywhere in your cluster. Either
way, `sendOr()` resolves with the same `SendResult` `send()` would have
returned.

## To expand

- A complete example wiring `sendOr()` to a real email provider (e.g.
  Postmark/Resend) with a template.
- Notes on idempotency: what happens if the user reconnects a split second
  after the offline branch fires (this is a best-effort fallback, not a
  transactional guarantee — see the `isOnline`/heartbeat-interval caveat in
  the [`core` reference](../reference/core.md)).
