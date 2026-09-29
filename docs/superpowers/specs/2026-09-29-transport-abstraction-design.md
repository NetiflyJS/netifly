# Transport Abstraction + In-Memory Transport — Design Spec

**Date:** 2026-09-29
**Status:** Approved for implementation planning
**Author:** dolufemi (with Claude Code)
**Tracking:** [NOT-20](https://linear.app/notifyjs/issue/NOT-20/transport-abstraction-in-memory-transport-zero-redis-devtest-mode)

## 1. Summary

`RedisRouter` is hard-wired into `createNetifly()` today — the only way to
move messages between connections and across server instances is real
Redis. This spec puts that behind a small `NetiflyTransport` interface, and
ships two implementations: `redisTransport()` (today's behavior, extracted
and slightly slimmed down) and `memoryTransport()` (a new, dependency-free,
single-process implementation for local dev and tests). It unblocks
[NOT-26](https://linear.app/notifyjs/issue/NOT-26) (Postgres transport),
[NOT-32](https://linear.app/notifyjs/issue/NOT-32) (Redis Cluster
transport), and [NOT-23](https://linear.app/notifyjs/issue/NOT-23)
(`@netiflyjs/testing`'s in-memory fake) without any of those requiring
further changes to `createNetifly()` itself.

## 2. Goals

- Define one `NetiflyTransport` interface that `createNetifly()` depends on
  instead of `RedisRouter` directly.
- Ship `redisTransport(url, options?)`, behaviorally identical to today's
  `redisUrl` option, and `memoryTransport()`, a new zero-dependency,
  single-process transport for local development and tests.
- A shared transport contract test suite that both implementations run
  against, so a future transport (Postgres, Redis Cluster) has a concrete,
  executable definition of "correct" to implement against.
- Keep `createNetifly({ redisUrl })` and `namespace` working exactly as
  they do today — this is additive, not breaking.
- Existing Redis-backed tests (`netiflyServer.test.ts`,
  `redisRouter.test.ts`) keep passing, now exercising the same code through
  the new abstraction.

## 3. Non-goals

- **`NetiflyPublisher` stays on its current, direct-Redis implementation.**
  It does not take a `transport` option in this ticket. It has no WebSocket
  connections to dedupe/ref-count subscriptions for, so the main thing this
  abstraction buys (Section 5) doesn't apply to it the same way; moving it
  onto `NetiflyTransport` is a natural, non-breaking follow-up once this
  shape has proven itself, and NOT-23 can revisit whether it needs one.
- **No multi-instance simulation for `memoryTransport()`.** It models
  exactly one process (`memoryTransport()` takes no arguments). Sharing one
  in-memory "bus" across several `createNetifly()` calls in the same
  process — the way several `RedisRouter`s share one real Redis — is out of
  scope; if NOT-23 needs it, that's an additive, non-breaking extension
  (e.g. an optional `{ bus }` param), not a reason to build it speculatively
  now.
- **No Postgres or Redis Cluster transport.** Those are NOT-26 and NOT-32,
  which this ticket unblocks but does not implement.
- **No new public export of the ref-counting wrapper** (Section 5). It is
  an internal implementation detail of `createNetifly()`'s own wiring, not
  part of the contract a transport author implements or a consumer calls.

## 4. Public API (`@netiflyjs/core`)

```ts
export interface NetiflyTransport {
  subscribe(userId: UserId): Promise<void>;
  unsubscribe(userId: UserId): Promise<void>;
  /** `message` is always a pre-serialized JSON string — see Section 6. */
  publish(userId: UserId, message: string): Promise<{ receivers: number }>;
  /** Batched presence check; `isOnline`/`whoIsOnline` both route through this. */
  receivers(userIds: UserId[]): Promise<Record<UserId, number>>;
  /** Registers the single callback invoked for every message this transport receives. */
  onMessage(cb: (userId: UserId, message: string) => void): void;
  /** Registers the single callback invoked for background/connection errors. */
  onError(cb: (error: Error) => void): void;
  close(): Promise<void>;
}

export function redisTransport(
  url: string,
  options?: { namespace?: string }
): NetiflyTransport;

export function memoryTransport(): NetiflyTransport;

interface CreateNetiflyOptions<Events> {
  // ...existing options unchanged...
  /**
   * The transport used to move messages between connections and across
   * server instances. Defaults to `redisTransport(redisUrl, { namespace })`
   * built from `redisUrl`/`REDIS_URL` and `namespace` below. Passing both
   * `transport` and `namespace` throws synchronously — `namespace` only
   * has meaning when this package constructs the Redis transport for you.
   */
  transport?: NetiflyTransport;
  // redisUrl, namespace: unchanged, see Section 7.
}
```

Usage:

```ts
// Default — identical to today.
createNetifly({ server, resolveUserId, redisUrl: process.env.REDIS_URL });

// Explicit, namespaced Redis transport.
createNetifly({
  server,
  resolveUserId,
  transport: redisTransport(process.env.REDIS_URL!, { namespace: 'staging' }),
});

// Local dev / tests — zero external dependencies.
createNetifly({ server, resolveUserId, transport: memoryTransport() });
```

`RedisRouter` (internal, never exported from `index.ts`) is renamed and
restructured into `redisTransport()` per Section 5 — this is a pure
internal rename, not a public API change.

`isOnline`/`whoIsOnline` on `NetiflyInstance` are unchanged from the
caller's perspective; internally they now call `this.transport.receivers(...)`
instead of `RedisRouter.numSubscribers`/`numSubscribersMany`, which are
removed as separate methods (folded into the one batched `receivers()`).

## 5. Where ref-counting lives

`netiflyServer` deliberately calls `subscribe`/`unsubscribe` once per
connection without deduping at the server level — `RedisRouter` absorbs
the overlap today so concurrent connections for the same user never
unsubscribe each other's channel (NOT-5). That ref-counting is lifted out
of the transport and into one internal wrapper:

```ts
// packages/core/src/transports/refCountedTransport.ts — not exported from index.ts
class RefCountedTransport implements NetiflyTransport {
  constructor(private readonly raw: NetiflyTransport) {}
  // subscribe/unsubscribe ref-count per userId, calling raw.subscribe/unsubscribe
  // only on the first-in/last-out transition. publish/receivers/onMessage/
  // onError/close pass straight through to `raw`.
}
```

`createNetifly()` always wraps whatever raw transport it ends up with —
whether built internally from `redisUrl` or supplied via `transport` — in
`new RefCountedTransport(raw)`, and talks only to the wrapped version.
Consequences:

- Raw transports (`redisTransport`, `memoryTransport`, future ones) never
  need to implement ref-counting themselves — their `subscribe`/
  `unsubscribe` can be naive: called once per logical interested party,
  already deduplicated by the wrapper above them.
- The overlap/ref-count behavior currently tested in `redisRouter.test.ts`
  ("keeps a channel subscribed for a second caller...", "only stops
  delivering once every overlapping subscriber has unsubscribed...") is
  tested exactly once, against `RefCountedTransport` with a trivial fake
  raw transport — not duplicated per real transport.
- The shared transport contract suite (Section 8) therefore tests the *raw*
  per-transport contract only; it does not need to exercise overlapping
  subscribers, since that's `RefCountedTransport`'s job, not a raw
  transport's.

## 6. Message format: always a pre-serialized string

`netiflyServer` JSON-stringifies the envelope once, centrally — in the
same place `send()`/`sendOr()`/the ack-relay path (NOT-30) already build
it — before calling `this.transport.publish(userId, jsonString)`. Every
transport moves opaque strings; none of them parse or care about envelope
structure. On the receiving side, `onMessage(userId, jsonString)` is
forwarded straight to `ws.send(jsonString)` with no re-parse, preserving
today's zero-reparse fast path for the Redis-backed case.

This was chosen over letting each transport move the raw envelope object
(which `memoryTransport()` could technically do for free, being
same-process) for two reasons: it keeps the transport contract genuinely
tiny (move a string, nothing else), and it keeps dev/prod parity — a
payload that isn't JSON-serializable fails the same way locally against
`memoryTransport()` as it would in production against `redisTransport()`,
instead of only surfacing once someone deploys.

The non-serializable-payload check itself (today, inside
`RedisRouter.publish`) moves to `netiflyServer`, where serialization now
happens — same error message, same thrown-from-`send()` behavior, just
physically relocated one file over.

## 7. `redisTransport()` and backward compatibility

`redisTransport(url, options?)` is `RedisRouter`'s current body, with two
changes: the ref-count map is removed (moved to `RefCountedTransport`,
Section 5), and `onMessage`/`onError` become post-construction registration
methods instead of constructor-injected callbacks — necessary because a
`transport` is now constructed by the caller before `createNetifly` ever
sees it, so `createNetifly` can no longer hand it a callback at
construction time the way it hands one to `RedisRouter` today.

`createNetifly`'s constructor:

```ts
if (options.transport && options.namespace) {
  throw new Error(
    'Netifly: pass `namespace` to redisTransport() directly when using an explicit `transport`; ' +
      'createNetifly({ namespace }) only applies to the redisUrl-built default transport.'
  );
}
const raw = options.transport
  ?? redisTransport(options.redisUrl ?? requireEnvRedisUrl(), { namespace: options.namespace });
this.transport = new RefCountedTransport(raw);
this.transport.onMessage((userId, message) => this.deliverLocally(userId, message));
this.transport.onError((error) => this.emitError(error));
```

- `redisUrl` (and `REDIS_URL`) keep working exactly as today, including the
  existing error message when neither is set — this is sugar for
  constructing a `redisTransport` internally, not a separate code path.
- `namespace` keeps working today's way only through the `redisUrl` path.
  Passing both `transport` and `namespace` throws synchronously at
  `createNetifly()` construction, rather than silently ignoring one —
  anyone who wants a namespaced Redis transport when constructing
  explicitly passes it directly: `redisTransport(url, { namespace })`.
- `RedisRouter` was never exported from `index.ts`, so nothing outside this
  package can reference it directly — free to rename/restructure with no
  deprecation period. `channelName()` (currently exported from
  `redisRouter.ts` for internal use) moves to `redisTransport.ts` unchanged.

## 8. `memoryTransport()`

```ts
export function memoryTransport(): NetiflyTransport {
  const subscribers = new Set<UserId>();
  let onMessageCb: ((userId: UserId, message: string) => void) | undefined;
  let onErrorCb: ((error: Error) => void) | undefined;
  // ...
}
```

- `subscribe`/`unsubscribe` add/remove from a `Set<UserId>` — no
  ref-counting (Section 5 already handles overlap above this).
- `publish(userId, message)`: if `userId` is in `subscribers`, invokes the
  registered `onMessage` callback **asynchronously**
  (`queueMicrotask`), not synchronously in the same tick — so code and
  tests written against one transport don't accidentally depend on timing
  behavior that only `memoryTransport()` happens to provide. Returns
  `{ receivers: subscribers.has(userId) ? 1 : 0 }`.
- `receivers(userIds)`: `1` for each `userId` currently in `subscribers`,
  `0` otherwise. Single-process by construction, so "receivers" here means
  "subscribed on this process" — there is no cluster to be a member of.
- `onError` exists to satisfy the interface; realistically never invoked —
  there is no background connection that can fail.
- `close()` clears `subscribers` and both registered callbacks; synchronous
  under the hood, returns a resolved `Promise<void>` to match the
  interface.

## 9. Error handling

- A throwing/rejecting `onMessage`/`onError` callback registered by
  `netiflyServer` is caught and reported via the existing `emitError` path,
  same as every other internal callback today — never propagates out of a
  transport's internals.
- `redisTransport`'s `onError(cb)` attaches `cb` to both the internal
  publisher and subscriber `ioredis` clients' `'error'` events, same
  signal `RedisRouter`'s constructor-injected `onError` carries today, just
  registered post-construction. Calling `onError` after `close()` is a
  silent no-op.
- `RefCountedTransport.close()` clears its ref-count map and delegates to
  the wrapped raw transport's `close()`. `redisTransport`'s `close()`
  keeps today's exact behavior (`Promise.all` over both connections via
  `disconnectRedis`, resolving even for a connection that never came up).

## 10. Testing

- **Shared contract suite** —
  `packages/core/src/transports/transport.contract.test.ts` exports
  `runTransportContractTests(name, makeTransport: () => NetiflyTransport)`.
  Covers: subscribe→publish delivers; unsubscribe stops delivery;
  `receivers()` reflects subscription state; `close()` cleans up; a forced
  failure surfaces via `onError`. Both `redisTransport` and
  `memoryTransport` invoke this helper with their own factory — this is
  the "every transport must pass" suite from the ticket's acceptance
  criteria.
- **`RefCountedTransport`** gets its own test file, covering the overlap
  scenarios moved out of `redisRouter.test.ts` (Section 5), run against a
  minimal fake raw transport.
- **`redisTransport.test.ts`** (renamed from `redisRouter.test.ts`) keeps
  what's Redis-specific: namespace isolation, the two `numSubscribers`
  tests collapsed into `receivers()`, connection-error-via-`onError`,
  `close()` semantics. The non-serializable-payload test moves to
  `netiflyServer.test.ts`, since serialization moved there (Section 6).
- **`netiflyServer.test.ts`** needs no behavioral changes — it exercises
  the public `createNetifly` API, unchanged for the `redisUrl` path. Its
  cross-instance tests (e.g. NOT-30's ack-relay-across-two-instances) keep
  working since real Redis remains the cross-instance broker in those
  tests.
- New: `netiflyServer.test.ts` gains a small set of tests constructing
  `createNetifly({ transport: memoryTransport() })` directly — connect,
  send, receive, disconnect — to prove the explicit-`transport` path
  works end to end, not just `redisUrl`.

## 11. Migration notes (for CHANGELOG / release, and docs)

- Non-breaking, additive minor-version bump for `@netiflyjs/core`.
  `@netiflyjs/client` and `@netiflyjs/express` are unaffected (express
  re-exports core's types, which only gain members here).
- README gets a new `transport` section next to the existing `redisUrl`
  documentation: the `NetiflyTransport` interface, `redisTransport()`,
  `memoryTransport()`, and the `transport`+`namespace` mutual-exclusion
  error.
- GitBook docs site (`docs/site/`) gets the same coverage as a page,
  matching how NOT-30's hooks were documented there — including a call-out
  that `memoryTransport()` is the recommended way to run the test suite of
  an app built on Netifly without a real Redis instance.
