# One-Way & Two-Way Notifications (notify(), signed action tokens) — Design Spec

**Date:** 2026-09-29
**Status:** Approved for implementation planning
**Author:** dolufemi (with Claude Code)
**Tracking:** [NOT-37](https://linear.app/notifyjs/issue/NOT-37/one-way-notifications-standard-info-notification-kind-notify-api), [NOT-38](https://linear.app/notifyjs/issue/NOT-38/two-way-actionable-notifications-cta-buttons-signed-action-tokens)

## 1. Summary

Today Netifly moves opaque events: `send(userId, type, data)` carries
whatever `type`/`data` the app chooses, so no shared UI or tooling is
possible across apps. This spec adds an opinionated `notify()` API on top
of `send()` with a standard notification schema (NOT-37), and extends it
with actionable notifications — CTA buttons whose answers are routed back
to the server via signed, stateless tokens and verified before the app
ever sees them (NOT-38). `send()`/`sendOr()` and the existing
[NOT-30](./2026-09-28-client-acks-read-state-design.md) ack/read/response
machinery are unchanged; `notify()` is a new, additive layer that happens
to reuse `send()`'s envelope, delivery counting, and `'sent'` event
under the hood.

Covering both tickets in one spec because they share one schema
(`notify()` with `kind: 'info' | 'action'`), one validation approach, and
one event model — NOT-38 is a strict extension of NOT-37's shape, not a
separate design. They still ship as two sequential plans/branches/PRs
(`not-37-...` then `not-38-...`, matching the tickets), with NOT-38's
branch built on top of NOT-37's.

## 2. Goals

- A standard, opinionated notification schema (`kind: 'info'`) with
  `title`/`body`/`severity`/`link`/`icon`/`expiresAt`/`meta`, validated
  server-side (length limits, safe `link.href`), exported as TypeScript
  types (+ a hand-written JSON Schema) from `@netiflyjs/core`.
- A `kind: 'action'` extension: CTA buttons the user can answer directly
  (Approve/Reject/Snooze-style), with the answer cryptographically
  verified — tampered token, wrong user, expired, or already-answered are
  all rejected — and routed to the app via a new `'action'` event.
- The whole thing works **statelessly across instances**: Netifly does not
  persist sent notifications (existing non-goal, carried over from NOT-30
  and NOT-41), so an action answered on instance B for a notification sent
  from instance A must still recover its `context` with no shared
  lookup beyond Redis's one idempotency key.
- `notify()`/`notifyOr()` return the same `SendResult` as `send()`/
  `sendOr()`, work with `sendOr`'s offline fallback, and are available on
  both `NetiflyInstance` and `NetiflyPublisher`.
- Exactly-once `'action'` firing, and exactly-once "answered" semantics
  even when two devices race to answer the same notification.
- Secure by default: `kind: 'action'` requires an explicit signing secret;
  a server that never configures one can still run, but only if it
  explicitly opts out of actions.

## 3. Non-goals

- No persistence of notifications by Netifly itself — same trust model as
  `resolveUserId` and the existing `send()`/ack machinery: the app's own
  store, if it wants one, hangs off `'sent'`/`'action'`.
- No validation that an answered `notificationId` corresponds to a
  notification Netifly actually sent, beyond what the signed token
  itself proves (id/userId/actionId/expiresAt/context all come from the
  token, not from a lookup).
- No configurable validation limits (title/body length, action count) in
  v1 — fixed constants, easy to make configurable later without a
  breaking change.
- No deduplication of the `netifly.notification.resolved` echo a client
  receives of its own answer — same accepted behavior as the existing
  ack/read/response relays.
- `NetiflyPublisher` does not gain `on('action', ...)` — structurally it
  never holds the WebSocket connection an action answer arrives on, so it
  can't be "the instance that received it." Same reasoning already
  applied to `on('delivered'|'read'|'response')` in the NOT-30 spec.
- No app-level idempotency beyond the one Redis "answered" lock — a retried
  answer after the lock expires is the app's own concern, same as any
  other retried write.

## 4. Public API (`@netiflyjs/core`)

```ts
export class NotificationValidationError extends Error {}

export interface NotificationLink {
  href: string;
  label: string;
}

export interface NotificationAction {
  id: string;
  label: string;
  style?: 'primary' | 'danger' | 'default';
  input?: { type: 'text'; placeholder?: string };
}

export interface InfoNotification {
  kind: 'info';
  title: string;
  body: string;
  severity?: 'info' | 'success' | 'warning' | 'error'; // default 'info'
  link?: NotificationLink;
  icon?: string;
  expiresAt?: number;
  meta?: Record<string, unknown>;
}

export interface ActionNotification {
  kind: 'action';
  title: string;
  body: string;
  actions: NotificationAction[]; // 1..5, ids unique
  expiresAt: number; // required — bounds the token's validity and the Redis lock TTL
  context?: Record<string, unknown>; // signed into each action's token, never sent as a plain field
  meta?: Record<string, unknown>;
}

export type Notification = InfoNotification | ActionNotification;

/** What a client actually receives — actions carry a signed, opaque token instead of raw context. */
export type WireNotification =
  | InfoNotification
  | (Omit<ActionNotification, 'actions' | 'context'> & {
      actions: (NotificationAction & { token: string })[];
    });

export interface CreateNetiflyOptions<Events> {
  // ...existing options unchanged...
  /**
   * HMAC secret used to sign kind:'action' notification tokens. Falls back
   * to the NETIFLY_SECRET environment variable. Required unless explicitly
   * set to `false`, in which case createNetifly() starts normally but any
   * notify() call with kind:'action' throws.
   */
  actionSecret?: string | false;
}

export interface NetiflyInstance<Events> {
  // ...existing send/sendOr/on/etc. unchanged...
  notify(userId: UserId, notification: Notification): Promise<SendResult>;
  notifyOr(userId: UserId, notification: Notification, options: SendOrOptions): Promise<SendResult>;
  on(
    event: 'action',
    listener: (info: {
      userId: UserId;
      notificationId: string;
      actionId: string;
      input?: unknown;
      context?: Record<string, unknown>;
    }) => void
  ): this;
  once(event: 'action', listener: (...) => void): this; // mirrors on()
}

export interface NetiflyPublisher<Events> {
  // ...existing send/on('sent')/etc. unchanged...
  notify(userId: UserId, notification: Notification): Promise<SendResult>;
}
```

`notify()`/`notifyOr()` validate (§5), then call the existing
`send(userId, 'notification', wireData)`/`sendOr(...)` internally — so
envelope building, the `'sent'` event (`type: 'notification'`,
`data: WireNotification`), delivery counting, and offline fallback are
all inherited unchanged. `notify()`'s only new behavior is: build
`WireNotification` (signing action tokens for `kind: 'action'`, §6) and
run schema validation first.

Wire type resolution for §1's earlier open question: `notify()` uses the
**unprefixed** envelope type `'notification'`, by the same convention
`send(userId, payload)` already defaults untyped payloads to `type:
'message'`. This keeps notifications inside the client's normal
auto-ack/`lastEventId` path — the `netifly.` prefix stays reserved
exclusively for protocol-level relay frames (`netifly.ack`,
`netifly.read`, `netifly.response`, and the new
`netifly.notification.resolved`/`netifly.actionAck`, §7).

## 5. Validation (NOT-37 acceptance criteria)

Runs synchronously inside `notify()`/`notifyOr()`, before anything is
built or published. A failure throws `NotificationValidationError`
(exported, so apps can `instanceof`-check it) and nothing is sent —
same contract as the existing `validate` option.

```ts
const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 500;
const MAX_LINK_LABEL_LENGTH = 80;
const MAX_ACTIONS = 5;
const SAFE_URL_SCHEMES = new Set(['http:', 'https:']);
```

- `title`: required, non-empty, ≤120 chars.
- `body`: required, non-empty, ≤500 chars.
- `severity` (if present): one of `'info' | 'success' | 'warning' | 'error'`.
- `link.href` (if present): either starts with `/` (relative path), or
  parses via `new URL()` with scheme `http:`/`https:`. Anything else
  (`javascript:`, `data:`, `vbscript:`, unparseable strings) is rejected.
  `link.label`: required, non-empty, ≤80 chars.
- `kind: 'action'` additionally: `actions` non-empty, ≤5 entries, each
  `id`/`label` non-empty, `id` unique within the array, `style` one of
  the three literals if present; `expiresAt` required and `> Date.now()`.

The TS interfaces in §4 double as the exported schema; a hand-written
`packages/core/src/notificationSchema.json` (referenced from the README)
covers the "+ optional JSON Schema" acceptance criterion — no codegen
dependency for a shape this small and stable.

## 6. Signed action tokens (NOT-38)

**Secret resolution**, at `createNetifly()`/`createNetiflyPublisher()`
construction:

1. `actionSecret` option, if a non-empty string → use it.
2. Else `process.env.NETIFLY_SECRET`, if set → use it.
3. Else, if `actionSecret !== false` → throw:
   `"Netifly: no actionSecret provided and NETIFLY_SECRET is not set. Pass { actionSecret } or set NETIFLY_SECRET — or pass { actionSecret: false } to disable kind:'action' notifications for this server."`
4. Else (`actionSecret === false`) → construction succeeds with actions
   disabled; a later `notify(..., { kind: 'action' })` throws
   synchronously: `"Netifly: kind:'action' notifications are disabled (actionSecret: false)."`

**Token construction**, once per action, inside `notify()` for
`kind: 'action'`:

```
payload = base64url(JSON.stringify({
  nid: <notification envelope id>,
  uid: userId,
  aid: action.id,
  exp: notification.expiresAt,
  ctx: notification.context ?? null,
}))
sig   = hex(HMAC-SHA256(actionSecret, payload))
token = `${payload}.${sig}`
```

The token is signed, not encrypted — a client can decode and read its
own `context`, but cannot alter any field without invalidating `sig`.
This is what makes "never trusted from the client" hold: the server
never accepts a client-supplied `context`, only the one it itself signed
and the client echoed back verbatim. `notify()` computes `nid` from the
same ULID it generates when building the envelope (§4), so the token and
the envelope agree without an extra round-trip.

The outbound `WireNotification.actions[i]` carries `{ id, label, style?,
input?, token }` — `context` is never a plain top-level field on the
wire.

**Client → server** frame, via a new dedicated method (kept separate
from the existing unsigned `respond(id, payload)` from NOT-30, per the
earlier decision — mixing a cryptographically verified path into that
generic one risks a verification-skip bug):

```json
{ "type": "action", "id": "<notificationId>", "action": "<actionId>", "token": "<token>", "input": <any, optional> }
```
```ts
// @netiflyjs/client
respondToAction(id: string, action: string, token: string, input?: unknown): void;
```

**Server-side verification**, on receipt of an `action` frame on a
socket authenticated as `userId`:

1. Split `token` on the last `.` into `payload`/`sig`. Recompute
   `hex(HMAC-SHA256(actionSecret, payload))`; `crypto.timingSafeEqual`
   against `sig`. Mismatch, or `token` not parseable into two parts →
   ack `'invalid'` (§7), stop.
2. `JSON.parse(base64url-decode(payload))`; check `nid === frame.id`,
   `aid === frame.action`, `uid === userId` → any mismatch → ack
   `'invalid'`, stop.
3. `Date.now() > exp` → ack `'expired'`, stop.
4. `transport.claim(`answered:<nid>`, ttl)` where
   `ttl = Math.max(1, Math.ceil((exp - Date.now()) / 1000))` — a new atomic
   claim primitive on the `NetiflyTransport` interface itself (added post
   NOT-20's transport-abstraction refactor, which replaced the earlier
   direct-Redis `RedisRouter` this section originally assumed), backed by
   `SET NX EX` in `redisTransport()` and an in-process TTL map in
   `memoryTransport()`. `claim()` resolving `false` (already claimed) →
   ack `'already_answered'`, stop.
5. Emit `'action'` locally, exactly once: `{ userId, notificationId: nid, actionId: aid, input: frame.input, context: ctx ?? undefined }`.
6. Publish `{ type: 'netifly.notification.resolved', id: nid, action: aid }`
   to `netifly:user:<userId>` (existing channel, existing `publish`/
   `deliverLocally` path — every one of the user's connections, including
   the answering one, receives it, same echo behavior as the NOT-30
   relays).
7. Reply directly to the answering socket only (not broadcast):
   `{ type: 'netifly.actionAck', id: nid, action: aid, status: 'accepted' }`.

Steps 1–4's rejection acks (`invalid`/`expired`/`already_answered`) use
the same `netifly.actionAck` shape, sent only to the answering socket —
no relay, no `'action'` event.

A structurally malformed `action` frame (missing `action`/`token`, wrong
types) is not routed through verification at all — it's caught by
`parseInboundFrame` and reported via the existing `'malformedFrame'`
event (`reason: 'invalidShape'`), same as any other bad frame. This
keeps "you sent garbage" (silent drop + operator-visible counter)
distinct from "you sent a real but cryptographically rejected answer"
(explicit typed ack the client can show the user).

## 7. Client-side API (`@netiflyjs/client`)

```ts
class NetiflyClient<Events> {
  // ...existing methods unchanged...
  respondToAction(id: string, action: string, token: string, input?: unknown): void;
  onActionAck(handler: (info: { id: string; action: string; status: 'accepted' | 'already_answered' | 'expired' | 'invalid' }) => void): Unsubscribe;
  onResolved(handler: (info: { id: string; action: string }) => void): Unsubscribe;
}
```

- `respondToAction` is a silent no-op when not connected, same as
  `markRead`/`respond` today.
- `onActionAck`/`onResolved` are new dedicated subscription sets
  (mirroring `onClose`/`onError`), not routed through `on(type, handler)`
  — that path is keyed by application envelope type, and these two are
  protocol-level `netifly.*` frames like the existing ack/read/response
  relays, already excluded from it.
- `handleMessage()`'s existing `netifly.`-prefix branch (currently just
  "skip auto-ack/lastEventId tracking") extends to also dispatch
  `netifly.notification.resolved` → `onResolved` handlers and
  `netifly.actionAck` → `onActionAck` handlers.

## 8. Error handling

- `'action'` is added to the server's `SAFE_EVENTS` set — a throwing/
  rejecting listener is caught and reported via the existing
  `emitError` path, never blocking the ack reply, the relay, or another
  listener.
- Token verification failures never throw out of `handleInboundFrame` —
  every branch in §6 resolves to either a normal `'action'` emit or a
  typed ack; nothing crashes the connection or the process.
- `NotificationValidationError` (§5) and the `actionSecret`-missing
  errors (§6) are both regular synchronous throws out of `notify()`,
  same as the existing `validate` option's throw — the caller's own
  `await notify(...)` rejects; nothing is published.
- All other error handling from the v1 design and the NOT-30 spec is
  unchanged.

## 9. Testing

- `notify()` validation unit tests: title/body length limits, bad
  `link.href` schemes (`javascript:`, `data:`, unparseable), action-array
  rules (empty, >5, duplicate ids, missing `expiresAt`).
- Real WS round-trip (`netiflyServer.test.ts`):
  - a valid `notify(kind:'action')` → client receives `actions[].token`;
    `respondToAction` with that token → `'action'` fires once with the
    right `context`, both devices for that user receive
    `netifly.notification.resolved`, the answering socket receives
    `netifly.actionAck` with `status: 'accepted'`.
  - tampered token (flipped byte in `sig`), wrong user's token (a second
    user's socket replaying an intercepted token), expired token
    (`expiresAt` in the past), and a valid token answered twice — assert
    the exact `netifly.actionAck` status each produces and that
    `'action'` fires 0 or 1 times accordingly.
  - two devices for the same user both answering concurrently: exactly
    one `'action'` event total, both receive
    `netifly.notification.resolved`.
  - `actionSecret: false`: server constructs fine; `notify(kind:'action')`
    rejects synchronously.
- Multi-instance test, reusing the existing multi-Redis test harness from
  `redisRouter.test.ts`/`netiflyServer.test.ts`: `notify()` from instance
  A, `respondToAction` answered on instance B — `'action'` fires once
  (on B, the instance that received the frame), both instances' local
  sockets for that user see the resolved relay.
- `client.test.ts`: `respondToAction` sends the right frame / no-ops when
  disconnected; `onActionAck`/`onResolved` dispatch correctly and don't
  leak into `on(type, handler)` or trigger auto-ack/`lastEventId`.
- `inboundFrame.test.ts`: `action` frame shape validation (missing
  `action`/`token` → `invalidShape`).

## 10. Migration notes (for CHANGELOG / release)

- **NOT-37 is non-breaking** — additive minor-version bump for
  `@netiflyjs/core` (and `@netiflyjs/express`, which re-exports core's
  types), same additive posture as the NOT-30 release.
- **NOT-38 is a breaking change**, and ships as a major-version bump for
  `@netiflyjs/core`/`@netiflyjs/express`. The eager `actionSecret`
  validation at `createNetifly()`/`createNetiflyPublisher()` construction
  (§6) means **every existing call site throws at startup** unless it's
  updated to either configure a secret (`actionSecret` option or
  `NETIFLY_SECRET` env var) or explicitly opt out with
  `actionSecret: false`. This is true even for an app that never sends an
  actionable notification. The CHANGELOG must carry a migration note:
  *"Upgrading to this version requires adding `{ actionSecret: false }` to
  your `createNetifly()`/`createNetiflyPublisher()` options, or
  configuring `NETIFLY_SECRET`/`actionSecret`, or the server will throw at
  startup."* `@netiflyjs/client` itself has no breaking change (its new
  methods/subscriptions are additive), but ships alongside the same major
  version for clarity since the two are meant to be upgraded together.
- Ship as two sequential releases matching the two tickets: NOT-37 first
  (`notify()`, `kind: 'info'` only, validation, JSON Schema, minor bump),
  then NOT-38 (`kind: 'action'`, `actionSecret`, signed tokens, `'action'`
  event, `respondToAction`/`onActionAck`/`onResolved`, major bump).
- README gets a new "Events vs. notifications: when to use `send()` vs
  `notify()`" section (NOT-37), and a new "Actionable notifications"
  guide with an approval-button example (NOT-38), documenting
  `actionSecret`/`NETIFLY_SECRET` (including the startup-throw behavior
  and the `actionSecret: false` opt-out), the `netifly.actionAck`
  statuses, and the reserved `netifly.` type-namespace addition
  (`netifly.notification.resolved`, `netifly.actionAck`).
