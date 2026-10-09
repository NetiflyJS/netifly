# Recipe: handling reconnects and token refresh

**Package:** [`@netiflyjs/client`](../reference/client.md)

Most apps want three things from the client beyond the bare quickstart:
a visible "reconnecting…" state, auth tokens that don't go stale mid-session,
and a sane limit on how long to keep retrying.

## Full example

```ts
import { createNetiflyClient } from '@netiflyjs/client';

async function getAccessToken(): Promise<string> {
  // Called again before every (re)connect — refresh here if the cached
  // token is expired or close to it, rather than returning a stale one.
  if (isExpiredOrExpiringSoon(session.accessToken)) {
    session.accessToken = await refreshAccessToken(session.refreshToken);
  }
  return session.accessToken;
}

const client = createNetiflyClient({
  url: 'wss://api.example.com/netifly',
  getToken: getAccessToken,
  maxReconnectAttempts: 20, // give up after ~20 tries instead of retrying forever
});

client.onStateChange((state) => {
  switch (state) {
    case 'connecting':
    case 'reconnecting':
      setBanner('Reconnecting…');
      break;
    case 'open':
      setBanner(null);
      break;
    case 'closed':
      setBanner('Disconnected — check your connection and refresh.');
      break;
  }
});

client.onError((error) => {
  // A rejected getToken(), an unparseable message, or giving up after
  // maxReconnectAttempts all land here.
  logger.warn('netifly client error', error);
});

client.connect();
```

## Why `getToken` is called on every attempt, not cached once

`getToken()` runs again before each connection attempt specifically so a
short-lived JWT doesn't outlive its expiry between the first `connect()`
and a reconnect minutes or hours later. If your refresh call can fail
(expired refresh token, revoked session), let it throw — the client
surfaces that via `onError` rather than silently retrying with a token
that will never work. Pair this with `maxReconnectAttempts` so a dead
session doesn't retry forever: once it's exhausted, `state` goes `closed`
and `onError` fires, which is your app's signal to force a real
re-authentication instead of waiting on the socket.

## Why the browser can't tell you *why* a handshake failed

If `onError`/`onStateChange` never report *which* HTTP status the server
answered with (401 vs. 403 vs. 429), that's expected — see the
[reconnecting caveat in the `client` reference](../reference/client.md#reconnecting)
for the full explanation and the workaround (check session validity over
plain HTTP, where the status code is visible, and call `client.close()`
yourself when it's invalid).
