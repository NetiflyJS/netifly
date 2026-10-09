<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/NetiflyJS/netifly/main/assets/brand/netifly-mark-on-dark.svg">
    <img src="https://raw.githubusercontent.com/NetiflyJS/netifly/main/assets/brand/netifly-mark.svg" alt="Netifly" width="96">
  </picture>
</p>

<h1 align="center">@netiflyjs/client</h1>

<p align="center"><strong>The browser/Node client for Netifly — reconnect and typed events built in, ~1.7 KB gzipped.</strong></p>

[![npm version](https://img.shields.io/npm/v/@netiflyjs/client.svg)](https://www.npmjs.com/package/@netiflyjs/client)
[![CI](https://github.com/NetiflyJS/netifly/actions/workflows/ci.yml/badge.svg)](https://github.com/NetiflyJS/netifly/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@netiflyjs/client.svg)](./LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@netiflyjs/client.svg)](https://www.npmjs.com/package/@netiflyjs/client)

The receiving end of [`@netiflyjs/core`](https://www.npmjs.com/package/@netiflyjs/core).
**Zero runtime dependencies**, built on the standard `WebSocket` global —
runs unchanged in browsers, React Native, and Node 22+. Reconnects with
full-jitter exponential backoff and refreshes short-lived auth tokens on
every attempt, so you don't hand-roll either. Part of the
[Netifly](https://github.com/NetiflyJS/netifly) project — pair it with
[`@netiflyjs/react`](https://www.npmjs.com/package/@netiflyjs/react) in a
React app.

## Contents

- [Features](#features)
- [Installation](#installation)
- [Getting started](#getting-started)
- [Recipe: reconnects and token refresh](#recipe-reconnects-and-token-refresh)
- [API reference](#api-reference)
- [Testing & development](#testing--development)
- [Contributing](#contributing)
- [License](#license)

## Features

- 🪶 **~1.7 KB minified + gzipped**, zero runtime dependencies.
- 🌐 **Standard `WebSocket` global** — browsers, React Native, Node 22+.
- 🔁 **Reconnect with full jitter** — a fleet of clients spreads out after an outage instead of re-stampeding the server.
- 🪪 **Token auth, refreshed on every attempt** — query string or `Sec-WebSocket-Protocol`, your choice.
- 🧩 **Typed events** — share the same `Events` map your server uses with `createNetifly<Events>()` for type-checked handlers.
- ✉️ **`onNotification()`** — a dedicated channel for `notify()`-sent, user-facing notifications.

## Installation

```bash
npm install @netiflyjs/client
```

## Getting started

```ts
import { createNetiflyClient } from '@netiflyjs/client';

// The same Events map your server passes to createNetifly<Events>()
type Events = {
  'comment.created': { commentId: string };
  'export.ready': { url: string };
};

const client = createNetiflyClient<Events>({
  url: 'wss://api.example.com/netifly',
  getToken: () => session.accessToken, // may be async; called on every (re)connect
});

client.on('export.ready', ({ url }) => {   // ✅ url: string
  toast(`Your export is ready: ${url}`);
});

client.onStateChange((state) => {
  // 'connecting' | 'open' | 'reconnecting' | 'closed'
  setBanner(state === 'open' ? null : 'Reconnecting…');
});

client.connect();

// …later, on logout/unmount:
client.close(); // cancels any pending reconnect; never reconnects on its own
```

`on()` returns an unsubscribe function, so it drops straight into a React
effect — though for a React app, prefer
[`@netiflyjs/react`](https://www.npmjs.com/package/@netiflyjs/react), which
wraps this client in a provider and hooks.

## Recipe: reconnects and token refresh

A visible "reconnecting…" state, refreshing a short-lived token before
each attempt, and capping retries so a dead session doesn't retry
forever — full worked example:
[Recipe: handling reconnects and token refresh](https://github.com/NetiflyJS/netifly/blob/main/docs/site/recipes/client-reconnects-and-token-refresh.md).

## API reference

`createNetiflyClient<Events>(options)` returns a `NetiflyClient<Events>`:
`connect`, `close`, `on`, `onAny`, `markRead`, `respond`, `respondToAction`,
`onActionAck`, `onResolved`, `onNotification`, `onStateChange`, `onClose`,
`onError`, plus `state`, `lastEventId`, `protocol`.

This README covers the quickstart; the full option table, the complete
reconnect-behavior table (which close codes retry and how), both token
auth modes with server-side code, and every method's exact semantics are
documented in the
**[`client` API reference](https://github.com/NetiflyJS/netifly/blob/main/docs/site/reference/client.md)**.

## Testing & development

This package lives in the Netifly pnpm workspace monorepo. Its own test
suite spins up a real `createNetifly()` server to run against, so it needs
a local Redis and **Node 22+** (it exercises the native `WebSocket` global).

```bash
pnpm install
docker run --rm -p 6379:6379 redis:7-alpine
pnpm --filter @netiflyjs/client test
pnpm --filter @netiflyjs/client build
pnpm --filter @netiflyjs/client run size   # bundle-size budget, after a build
```

## Contributing

Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `chore:`, etc.) — `semantic-release` uses them to decide
this package's next version and changelog automatically on merge to `main`.
See the [root README](https://github.com/NetiflyJS/netifly) for the full
contributor workflow.

## License

[MIT](./LICENSE)
