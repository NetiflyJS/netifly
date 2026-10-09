<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/NetiflyJS/netifly/main/assets/brand/netifly-mark-on-dark.svg">
    <img src="https://raw.githubusercontent.com/NetiflyJS/netifly/main/assets/brand/netifly-mark.svg" alt="Netifly" width="96">
  </picture>
</p>

<h1 align="center">@netiflyjs/react</h1>

<p align="center"><strong>A provider and hooks for Netifly — StrictMode-safe, SSR-safe.</strong></p>

[![npm version](https://img.shields.io/npm/v/@netiflyjs/react.svg)](https://www.npmjs.com/package/@netiflyjs/react)
[![CI](https://github.com/NetiflyJS/netifly/actions/workflows/ci.yml/badge.svg)](https://github.com/NetiflyJS/netifly/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@netiflyjs/react.svg)](./LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@netiflyjs/react.svg)](https://www.npmjs.com/package/@netiflyjs/react)

Wires [`@netiflyjs/client`](https://www.npmjs.com/package/@netiflyjs/client)
into React for you: a provider that owns one socket per app, and three
hooks for subscribing to events and rendering a notification inbox — so
you don't wire up effects, subscribe/cleanup, and unread-count state by
hand (and get it subtly wrong under StrictMode's double-invoked effects).
Part of the [Netifly](https://github.com/NetiflyJS/netifly) project.

## Contents

- [Features](#features)
- [Installation](#installation)
- [Getting started](#getting-started)
- [Recipe: a notification inbox](#recipe-a-notification-inbox)
- [API reference](#api-reference)
- [Testing & development](#testing--development)
- [Contributing](#contributing)
- [License](#license)

## Features

- 🔌 **One provider, one socket** — `<NetiflyProvider>` creates and owns a single `NetiflyClient`, connecting on mount and closing on unmount.
- 🧵 **StrictMode-safe** — the client lives in a lazy `useState` initializer, not an effect, so React 18's dev-only double-invoke never opens two sockets.
- 🖥️ **SSR-safe** — no socket ever opens outside an effect, so importing this in Next.js (`renderToString`/`renderToPipeableStream`) needs no `typeof window` guards.
- 📬 **`useNotifications()`** — unread count, read/dismiss, and actionable-notification responses, backed by one shared store per provider.
- 🧩 **Typed events** — `useEvent<Events, K>()` type-checks against the same `Events` map your server uses.

## Installation

```bash
npm install @netiflyjs/react @netiflyjs/client
```

`react` (`^18.0.0 || ^19.0.0`) is a peer dependency.

## Getting started

```tsx
import { NetiflyProvider, useEvent, useNotifications } from '@netiflyjs/react';

// The same Events map your server passes to createNetifly<Events>()
type Events = {
  'comment.created': { commentId: string };
};

function App() {
  return (
    <NetiflyProvider url="wss://api.example.com/netifly" getToken={() => session.accessToken}>
      <Inbox />
    </NetiflyProvider>
  );
}

function Inbox() {
  useEvent<Events, 'comment.created'>('comment.created', (data) => toast(`New comment: ${data.commentId}`));

  const { items, unreadCount, markRead, dismiss, respond } = useNotifications();

  return (
    <>
      <span>{unreadCount} unread</span>
      {items.map((item) => (
        <article key={item.id}>
          <strong>{item.notification.title}</strong>
          <p>{item.notification.body}</p>
          <button onClick={() => markRead(item.id)}>Mark read</button>
          <button onClick={() => dismiss(item.id)}>Dismiss</button>
        </article>
      ))}
    </>
  );
}
```

A runnable version of this lives in
[`examples/react`](https://github.com/NetiflyJS/netifly/tree/main/examples/react)
— a toast list (`aria-live="polite"`), an unread badge, and an
Approve/Reject actionable notification, in plain markup.

## Recipe: a notification inbox

The example above, extended with actionable notifications
(Approve/Reject-style buttons) and expiry handling — full walkthrough:
[Recipe: building a notification inbox](https://github.com/NetiflyJS/netifly/blob/main/docs/site/recipes/react-notification-inbox.md).

## API reference

`useNetifly()`, `useEvent(type, handler)`, and `useNotifications()` —
plus every `<NetiflyProvider>` prop (the same options
[`createNetiflyClient`](https://www.npmjs.com/package/@netiflyjs/client)
takes) and the exact StrictMode/SSR guarantees behind them — are
documented in full in the
**[`react` API reference](https://github.com/NetiflyJS/netifly/blob/main/docs/site/reference/react.md)**.

## Testing & development

This package lives in the Netifly pnpm workspace monorepo.

```bash
pnpm install
pnpm --filter @netiflyjs/react test
pnpm --filter @netiflyjs/react build
```

## Contributing

Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `chore:`, etc.) — `semantic-release` uses them to decide
this package's next version and changelog automatically on merge to `main`.
See the [root README](https://github.com/NetiflyJS/netifly) for the full
contributor workflow.

## License

[MIT](./LICENSE)
