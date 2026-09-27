# `@netiflyjs/client` reference

> **Status:** stub — full prose to follow. See the
> [root README's API Reference](https://github.com/NetiflyJS/netifly#-api-reference)
> for complete detail in the meantime.

Zero-dependency, ~1.7 KB gzipped, built on the standard `WebSocket` global
(browsers, React Native, Node 22+).

## `createNetiflyClient<Events>(options)`

| Option | Required | Notes |
| --- | --- | --- |
| `url` | ✅ | the Netifly WebSocket endpoint |
| `getToken` | — | called before every (re)connect; omit for cookie-based auth |
| `tokenMode` | — | `'query'` (default) or `'subprotocol'` |
| `tokenQueryParam`, `tokenProtocolPrefix` | — | naming overrides for the two token modes |
| `baseDelayMs`, `maxDelayMs` | — | full-jitter backoff tuning, defaults `500`/`30_000` |
| `maxReconnectAttempts` | — | default `Infinity` |

Returns a `NetiflyClient<Events>`: `connect`, `close`, `on`, `onAny`,
`onStateChange`, `onClose`, `onError`, plus `state`, `lastEventId`,
`protocol`.

## Reconnect behavior

| Situation | Behavior |
| --- | --- |
| Handshake never completed | Exponential backoff, full jitter |
| Closed `1000`/`1005` after opening | Stays `closed` (intentional server disconnect) |
| Closed `1012` after opening | Reconnects immediately, single jittered delay (graceful deploy signal) |
| Any other close after opening | Treated as transient — exponential backoff |
| `client.close()` called | Never reconnects |

See [Getting started](../getting-started.md) for the full reconnect caveat
around handshake failures (browsers can't see *why* a handshake was
rejected — see the root README for the detailed explanation).

## To expand

- Full method signatures and worked examples for each token mode.
- The `fullJitterDelay`/`planReconnect` pure-function exports.
