# `@netiflyjs/react` reference

> **Status:** stub — full prose to follow. See the
> [root README's API Reference](https://github.com/NetiflyJS/netifly#-api-reference)
> for complete detail in the meantime.

React provider and hooks on top of [`@netiflyjs/client`](client.md):
StrictMode-safe (one connection, however many times effects re-run in
development) and SSR-safe (no socket opens outside an effect, so
`renderToString`/Next.js can import it with no guards).

## `<NetiflyProvider url getToken>`

Creates and owns a single `NetiflyClient`, connecting on mount and closing
on unmount. Everything below reads from it via context.

## `useNetifly()`

Returns `{ client, status }`. Throws when used outside a `<NetiflyProvider>`.

## `useEvent(type, handler)`

Subscribes to one typed application event. Always calls the latest
`handler`, never resubscribes just because it changed identity, and
unsubscribes on unmount.

## `useNotifications()`

Returns `{ items, unreadCount, markRead, markAllRead, dismiss, respond }`,
backed by one small in-memory store per provider (shared by every
component that calls the hook). `respond(notificationId, actionId, input?)`
resolves to `'accepted' | 'already_answered' | 'expired' | 'invalid'`.
