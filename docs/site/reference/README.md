# API Reference

Netifly is split across four packages, each with its own reference page:

- [`@netiflyjs/core`](core.md) — the framework-agnostic engine
  (`createNetifly`, `createNetiflyPublisher`, transport, typed events,
  notifications).
- [`@netiflyjs/express`](express.md) — the Express adapter
  (`attachNetifly`).
- [`@netiflyjs/client`](client.md) — the browser/React Native/Node client
  (`createNetiflyClient`).
- [`@netiflyjs/react`](react.md) — the provider and hooks
  (`NetiflyProvider`, `useNetifly`, `useEvent`, `useNotifications`).

Each package also ships a shorter README alongside its source on npm/GitHub
— these pages are where the full depth lives; the package READMEs link
back here for anything beyond their own quickstart.
