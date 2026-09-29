# Actionable Notifications — Signed Action Tokens (NOT-38) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `notify()` with `kind: 'action'` — CTA buttons whose answers are cryptographically verified (signed, stateless HMAC tokens) and routed to the app via a new `'action'` event, with exactly-once "answered" semantics enforced by a Redis lock.

**Architecture:** A new `actionToken.ts` module owns token signing/verification and building the wire-safe action array (tokens embed `context` so it survives to whichever instance answers it, with no persistence). A new `actionSecret.ts` module owns resolving/validating the signing secret at construction time. `RedisRouter` gains one new primitive (`tryLockAnswered`) reusing its existing plain publisher client. `NetiflyServerImpl` gains a dedicated inbound-frame branch (`handleActionFrame`) that verifies, locks, emits `'action'` exactly once, relays `netifly.notification.resolved` to the user's other connections, and acks the answering socket directly with `netifly.actionAck`. `NetiflyPublisherImpl` gains the same secret + token-signing half (it can originate an action notification, but never receives the answer — that's a `NetiflyInstance`-only concern). `@netiflyjs/client` gains `respondToAction()`/`onActionAck()`/`onResolved()`.

**Depends on:** [NOT-37's plan](./2026-09-29-notify-one-way-notifications.md) must be implemented and merged first — this plan's Task 1 widens the `Notification`/`WireNotification` types and `validateNotification()` that NOT-37 introduces, and every later task builds on NOT-37's `notify()`/`notifyOr()` plumbing.

**⚠️ Breaking change:** Unlike NOT-37, this ships as a **major version bump**. Eager `actionSecret` validation at `createNetifly()`/`createNetiflyPublisher()` construction means every existing call site throws at startup unless updated — see Task 6, Step 1.

**Tech Stack:** TypeScript, Node `node:crypto` (`createHmac`, `timingSafeEqual`), Jest (real WebSocket + Redis integration tests), tsd.

**Spec:** [docs/superpowers/specs/2026-09-29-notify-actionable-notifications-design.md](../specs/2026-09-29-notify-actionable-notifications-design.md) §6–§9 (this plan's scope — §4/§5's `kind: 'info'` half is NOT-37's plan)

## Global Constraints

- `MAX_ACTIONS = 5`; each action's `id` unique within the array; `expiresAt` required and strictly `> Date.now()` at validation time (spec §5).
- Token format: `base64url(JSON.stringify({nid,uid,aid,exp,ctx})) + '.' + hex(HMAC-SHA256(secret, thatBase64))` — signed, not encrypted; `context` (`ctx`) is embedded so any instance can recover it statelessly (spec §6).
- `actionSecret` resolution order: `options.actionSecret` (string) → `process.env.NETIFLY_SECRET` → throw, unless `options.actionSecret === false` (explicit opt-out, `notify(kind:'action')` then throws instead). Validated **eagerly at construction**, not lazily (spec §6, and see the Breaking change note above).
- Client → server action frame: `{ type: 'action', id, action, token, input? }`, verified via `crypto.timingSafeEqual` — never a plain `===` string comparison on the signature.
- Redis idempotency key: `SET netifly:<ns:>answered:<notificationId> <actionId> NX EX <ttl>`, `ttl = Math.max(1, Math.ceil((exp - Date.now()) / 1000))` (spec §6).
- Ack statuses are exactly `'accepted' | 'already_answered' | 'expired' | 'invalid'`, sent only to the answering socket as `netifly.actionAck`; the `'action'` app event and the `netifly.notification.resolved` broadcast fire only on `'accepted'` (spec §6).
- `'action'` is added to `SAFE_EVENTS` — a throwing/rejecting listener must never crash the process or block the ack (spec §8).
- No changes to `@netiflyjs/express` production code — `AttachNetiflyOptions extends Omit<CreateNetiflyOptions, 'server'>` already forwards `actionSecret` with zero changes; only its tests need updating (Task 6).

## Review Focus

- A client answering after `expiresAt` has passed must get `'expired'`, never `'accepted'`, and must never acquire the Redis lock. Covered in Task 6.
- A token with a valid signature but a `uid` that doesn't match the answering socket's authenticated `userId` (an intercepted/replayed token used by a different user) must be rejected as `'invalid'`, never routed to `'action'` under the wrong user. Covered in Task 6.
- Two connections for the same user answering the same action concurrently must produce exactly one `'action'` event and have both receive `netifly.notification.resolved` — this must hold even when both frames are verified at the same wall-clock instant, which only the Redis `NX` lock (not JS's single-threadedness) actually guarantees across two server instances. Covered in Task 6.
- `actionSecret: false` must fail loudly and specifically at the `notify(kind:'action')` call site, not silently skip token signing or crash somewhere else downstream. Covered in Task 1 and Task 6.
- Every pre-existing test helper (`netiflyServer.test.ts`, `netiflyPublisher.test.ts`, `client.test.ts`, `packages/express/src/index.test.ts`) must keep passing under the new eager `actionSecret` requirement — this is the mechanical fallout of the breaking change and is easy to miss piecemeal. Covered as the first step of Task 6.

---

### Task 1: Widen notification types and validation for `kind: 'action'`

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/notification.ts` (full rewrite of the file's contents)
- Modify: `packages/core/src/notification.test.ts` (append new cases)

**Interfaces:**
- Consumes: `InfoNotification`, `Notification` (= `InfoNotification` only), `NotificationValidationError`, `validateNotification` from NOT-37's Task 1.
- Produces: `NotificationAction`, `ActionNotification`, widened `Notification` (`InfoNotification | ActionNotification`), widened `WireNotification`, `ActionInfo` types from `./types`; `validateNotification` now accepts both kinds — consumed by Task 3 (`buildActionWireNotification`) and Task 6/7 (`notify()`).

- [ ] **Step 1: Widen the types and write the failing validation tests**

In `packages/core/src/types.ts`, replace the `Notification`/`WireNotification` type aliases NOT-37 added:

```ts
/**
 * The shape `notify()`/`notifyOr()` accept. Currently just `InfoNotification`
 * — widened to include an `ActionNotification` variant by a later change
 * (NOT-38), which is why this is a type alias and not `InfoNotification`
 * directly at every call site.
 */
export type Notification = InfoNotification;

/** What a client actually receives on the wire for a notify() call. */
export type WireNotification = Notification;
```

with:

```ts
export interface NotificationAction {
  id: string;
  label: string;
  style?: 'primary' | 'danger' | 'default';
  input?: { type: 'text'; placeholder?: string };
}

export interface ActionNotification {
  kind: 'action';
  title: string;
  body: string;
  actions: NotificationAction[]; // 1..5, ids unique — see notification.ts
  expiresAt: number; // required — bounds the signed token's validity and the Redis answered-lock TTL
  context?: Record<string, unknown>; // signed into each action's token; never a plain wire field, see actionToken.ts
  meta?: Record<string, unknown>;
}

/** The shape `notify()`/`notifyOr()` accept. */
export type Notification = InfoNotification | ActionNotification;

/** What a client actually receives on the wire — action notifications carry a signed, opaque token per action instead of raw context. */
export type WireNotification =
  | InfoNotification
  | (Omit<ActionNotification, 'actions' | 'context'> & {
      actions: (NotificationAction & { token: string })[];
    });

/** Payload for `NetiflyInstance.on('action', ...)` — an answered action notification. */
export interface ActionInfo {
  userId: UserId;
  notificationId: string;
  actionId: string;
  input?: unknown;
  context?: Record<string, unknown>;
}
```

Then, inside `export interface NetiflyInstance<Events extends EventMap = EventMap> { ... }`, add right after the existing `on(event: 'malformedFrame', ...)` line:

```ts
  on(
    event: 'action',
    listener: (info: ActionInfo) => void
  ): this;
```

and mirror it in the file's `once(...)` block, right after the existing `once(event: 'malformedFrame', ...)` line:

```ts
  once(
    event: 'action',
    listener: (info: ActionInfo) => void
  ): this;
```

Now rewrite `packages/core/src/notification.test.ts` in full (adds `kind: 'action'` coverage alongside the existing `kind: 'info'` cases):

```ts
import { NotificationValidationError, validateNotification } from './notification';
import type { ActionNotification, InfoNotification } from './types';

function baseInfo(overrides: Partial<InfoNotification> = {}): InfoNotification {
  return { kind: 'info', title: 'Export ready', body: 'Your report is ready.', ...overrides };
}

function baseAction(overrides: Partial<ActionNotification> = {}): ActionNotification {
  return {
    kind: 'action',
    title: 'Approve expense £420?',
    body: 'Submitted by Sam for Client dinner',
    actions: [{ id: 'approve', label: 'Approve' }],
    expiresAt: Date.now() + 3600_000,
    ...overrides,
  };
}

describe('validateNotification: kind: info', () => {
  it('accepts a minimal valid notification', () => {
    expect(() => validateNotification(baseInfo())).not.toThrow();
  });

  it('rejects a missing kind', () => {
    const { kind: _kind, ...rest } = baseInfo();
    expect(() => validateNotification(rest as unknown as InfoNotification)).toThrow(
      NotificationValidationError
    );
  });

  it('rejects an unrecognized kind', () => {
    expect(() =>
      validateNotification({ ...baseInfo(), kind: 'urgent' } as unknown as InfoNotification)
    ).toThrow(NotificationValidationError);
  });

  it('rejects an empty title', () => {
    expect(() => validateNotification(baseInfo({ title: '' }))).toThrow(NotificationValidationError);
  });

  it('rejects a whitespace-only title', () => {
    expect(() => validateNotification(baseInfo({ title: '   ' }))).toThrow(NotificationValidationError);
  });

  it('rejects a title over 120 characters', () => {
    expect(() => validateNotification(baseInfo({ title: 'x'.repeat(121) }))).toThrow(
      NotificationValidationError
    );
  });

  it('accepts a title at exactly 120 characters', () => {
    expect(() => validateNotification(baseInfo({ title: 'x'.repeat(120) }))).not.toThrow();
  });

  it('rejects an empty body', () => {
    expect(() => validateNotification(baseInfo({ body: '' }))).toThrow(NotificationValidationError);
  });

  it('rejects a body over 500 characters', () => {
    expect(() => validateNotification(baseInfo({ body: 'x'.repeat(501) }))).toThrow(
      NotificationValidationError
    );
  });

  it('rejects an invalid severity', () => {
    expect(() =>
      validateNotification(baseInfo({ severity: 'critical' as InfoNotification['severity'] }))
    ).toThrow(NotificationValidationError);
  });

  it.each(['info', 'success', 'warning', 'error'] as const)('accepts severity %s', (severity) => {
    expect(() => validateNotification(baseInfo({ severity }))).not.toThrow();
  });

  it('accepts a relative link href', () => {
    expect(() =>
      validateNotification(baseInfo({ link: { href: '/reports/123', label: 'Open' } }))
    ).not.toThrow();
  });

  it('accepts an https link href', () => {
    expect(() =>
      validateNotification(baseInfo({ link: { href: 'https://example.com/x', label: 'Open' } }))
    ).not.toThrow();
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', 'vbscript:msgbox(1)', 'not a url'])(
    'rejects an unsafe link href: %s',
    (href) => {
      expect(() => validateNotification(baseInfo({ link: { href, label: 'Open' } }))).toThrow(
        NotificationValidationError
      );
    }
  );

  it('rejects a link.href that is not a string (non-TS caller)', () => {
    expect(() =>
      validateNotification(
        baseInfo({ link: { href: 123, label: 'Open' } as unknown as InfoNotification['link'] })
      )
    ).toThrow(NotificationValidationError);
  });

  it('rejects a link with a missing label', () => {
    expect(() => validateNotification(baseInfo({ link: { href: '/x', label: '' } }))).toThrow(
      NotificationValidationError
    );
  });

  it('rejects a link.label that is not a string (non-TS caller)', () => {
    expect(() =>
      validateNotification(
        baseInfo({ link: { href: '/x', label: 42 } as unknown as InfoNotification['link'] })
      )
    ).toThrow(NotificationValidationError);
  });

  it('rejects a link label over 80 characters', () => {
    expect(() =>
      validateNotification(baseInfo({ link: { href: '/x', label: 'x'.repeat(81) } }))
    ).toThrow(NotificationValidationError);
  });
});

describe('validateNotification: kind: action', () => {
  it('accepts a minimal valid action notification', () => {
    expect(() => validateNotification(baseAction())).not.toThrow();
  });

  it('rejects an empty actions array', () => {
    expect(() => validateNotification(baseAction({ actions: [] }))).toThrow(NotificationValidationError);
  });

  it('rejects more than 5 actions', () => {
    const actions = Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, label: `Action ${i}` }));
    expect(() => validateNotification(baseAction({ actions }))).toThrow(NotificationValidationError);
  });

  it('accepts exactly 5 actions', () => {
    const actions = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, label: `Action ${i}` }));
    expect(() => validateNotification(baseAction({ actions }))).not.toThrow();
  });

  it('rejects duplicate action ids', () => {
    expect(() =>
      validateNotification(
        baseAction({
          actions: [
            { id: 'approve', label: 'Approve' },
            { id: 'approve', label: 'Approve Again' },
          ],
        })
      )
    ).toThrow(NotificationValidationError);
  });

  it('rejects an action with an empty id', () => {
    expect(() =>
      validateNotification(baseAction({ actions: [{ id: '', label: 'Approve' }] }))
    ).toThrow(NotificationValidationError);
  });

  it('rejects an action with an empty label', () => {
    expect(() =>
      validateNotification(baseAction({ actions: [{ id: 'approve', label: '' }] }))
    ).toThrow(NotificationValidationError);
  });

  it('rejects an invalid action style', () => {
    expect(() =>
      validateNotification(
        baseAction({
          actions: [{ id: 'approve', label: 'Approve', style: 'huge' as unknown as 'primary' }],
        })
      )
    ).toThrow(NotificationValidationError);
  });

  it.each(['primary', 'danger', 'default'] as const)('accepts action style %s', (style) => {
    expect(() =>
      validateNotification(baseAction({ actions: [{ id: 'approve', label: 'Approve', style }] }))
    ).not.toThrow();
  });

  it('rejects a missing expiresAt', () => {
    const { expiresAt: _expiresAt, ...rest } = baseAction();
    expect(() => validateNotification(rest as unknown as ActionNotification)).toThrow(
      NotificationValidationError
    );
  });

  it('rejects an expiresAt in the past', () => {
    expect(() => validateNotification(baseAction({ expiresAt: Date.now() - 1000 }))).toThrow(
      NotificationValidationError
    );
  });

  it('accepts an optional context object', () => {
    expect(() =>
      validateNotification(baseAction({ context: { expenseId: 'exp_123' } }))
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd packages/core && npx jest notification.test.ts`
Expected: FAIL — `kind: 'action'` cases fail because `validateNotification` doesn't handle that kind yet (either accepted incorrectly or throws the wrong way, depending on NOT-37's exact implementation).

- [ ] **Step 3: Rewrite `notification.ts` to validate both kinds**

Replace the full contents of `packages/core/src/notification.ts`:

```ts
import type { Notification } from './types';

/** Thrown by `validateNotification()` — exported so apps can `instanceof`-check it apart from other errors a `notify()` call might reject with. */
export class NotificationValidationError extends Error {}

const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 500;
const MAX_LINK_LABEL_LENGTH = 80;
const MAX_ACTIONS = 5;
const SEVERITIES = new Set(['info', 'success', 'warning', 'error']);
const ACTION_STYLES = new Set(['primary', 'danger', 'default']);

function isSafeLinkHref(href: string): boolean {
  if (href.startsWith('/')) {
    return true;
  }
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateTitleAndBody(notification: Notification): void {
  const title = (notification as { title?: unknown }).title;
  if (typeof title !== 'string' || title.trim().length === 0 || title.length > MAX_TITLE_LENGTH) {
    throw new NotificationValidationError(
      `Netifly: notify() requires a non-empty title of at most ${MAX_TITLE_LENGTH} characters`
    );
  }

  const body = (notification as { body?: unknown }).body;
  if (typeof body !== 'string' || body.trim().length === 0 || body.length > MAX_BODY_LENGTH) {
    throw new NotificationValidationError(
      `Netifly: notify() requires a non-empty body of at most ${MAX_BODY_LENGTH} characters`
    );
  }
}

function validateSeverity(notification: Notification): void {
  const severity = (notification as { severity?: unknown }).severity;
  if (severity !== undefined && !SEVERITIES.has(severity as string)) {
    throw new NotificationValidationError(
      `Netifly: notify() severity must be one of 'info' | 'success' | 'warning' | 'error', got ${JSON.stringify(severity)}`
    );
  }
}

function validateLink(notification: Notification): void {
  const link = (notification as { link?: unknown }).link;
  if (link === undefined) {
    return;
  }
  const href = (link as { href?: unknown }).href;
  const label = (link as { label?: unknown }).label;

  if (typeof href !== 'string' || !isSafeLinkHref(href)) {
    throw new NotificationValidationError(
      `Netifly: notify() link.href must be a relative path or an http(s) URL, got ${JSON.stringify(href)}`
    );
  }
  if (typeof label !== 'string' || label.trim().length === 0 || label.length > MAX_LINK_LABEL_LENGTH) {
    throw new NotificationValidationError(
      `Netifly: notify() link.label is required and must be at most ${MAX_LINK_LABEL_LENGTH} characters`
    );
  }
}

function validateActions(notification: Notification): void {
  const actions = (notification as { actions?: unknown }).actions;
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > MAX_ACTIONS) {
    throw new NotificationValidationError(
      `Netifly: notify() kind:'action' requires a non-empty actions array of at most ${MAX_ACTIONS} entries`
    );
  }

  const seenIds = new Set<string>();
  for (const action of actions) {
    const id = (action as { id?: unknown }).id;
    const label = (action as { label?: unknown }).label;
    const style = (action as { style?: unknown }).style;

    if (typeof id !== 'string' || id.length === 0) {
      throw new NotificationValidationError('Netifly: notify() every action requires a non-empty id');
    }
    if (seenIds.has(id)) {
      throw new NotificationValidationError(`Netifly: notify() action ids must be unique, duplicate "${id}"`);
    }
    seenIds.add(id);

    if (typeof label !== 'string' || label.trim().length === 0) {
      throw new NotificationValidationError('Netifly: notify() every action requires a non-empty label');
    }
    if (style !== undefined && !ACTION_STYLES.has(style as string)) {
      throw new NotificationValidationError(
        `Netifly: notify() action.style must be one of 'primary' | 'danger' | 'default', got ${JSON.stringify(style)}`
      );
    }
  }

  const expiresAt = (notification as { expiresAt?: unknown }).expiresAt;
  if (typeof expiresAt !== 'number' || expiresAt <= Date.now()) {
    throw new NotificationValidationError(
      "Netifly: notify() kind:'action' requires expiresAt to be a timestamp in the future"
    );
  }
}

/**
 * Validates a `notify()`/`notifyOr()` argument before anything is built or
 * published. Every check reads fields via an `unknown`-typed cast rather
 * than trusting the declared `Notification` type, since this also has to
 * defend plain-JS callers who bypass TypeScript entirely. Throws
 * `NotificationValidationError` on the first failure.
 */
export function validateNotification(notification: Notification): void {
  const kind = (notification as { kind?: unknown }).kind;
  if (kind !== 'info' && kind !== 'action') {
    throw new NotificationValidationError(
      `Netifly: notify() requires kind: 'info' | 'action', got ${JSON.stringify(kind)}`
    );
  }

  validateTitleAndBody(notification);

  if (kind === 'info') {
    validateSeverity(notification);
    validateLink(notification);
    return;
  }

  validateActions(notification);
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd packages/core && npx jest notification.test.ts`
Expected: PASS — every `kind: 'info'` and `kind: 'action'` case green.

- [ ] **Step 5: Typecheck and commit**

Run: `cd packages/core && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

```bash
git add packages/core/src/types.ts packages/core/src/notification.ts packages/core/src/notification.test.ts
git commit -m "feat(core): widen notify() to kind:'action' with validation (NOT-38)"
```

---

### Task 2: Action secret resolution

**Files:**
- Create: `packages/core/src/actionSecret.ts`
- Create: `packages/core/src/actionSecret.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `resolveActionSecret(optionValue: string | false | undefined): string | undefined`, consumed by Task 6 and Task 7's constructors.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/actionSecret.test.ts`:

```ts
import { resolveActionSecret } from './actionSecret';

describe('resolveActionSecret', () => {
  const originalEnv = process.env.NETIFLY_SECRET;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NETIFLY_SECRET;
    } else {
      process.env.NETIFLY_SECRET = originalEnv;
    }
  });

  it('returns the option value when a non-empty string is passed', () => {
    delete process.env.NETIFLY_SECRET;
    expect(resolveActionSecret('opt-secret')).toBe('opt-secret');
  });

  it('prefers the option value over NETIFLY_SECRET', () => {
    process.env.NETIFLY_SECRET = 'env-secret';
    expect(resolveActionSecret('opt-secret')).toBe('opt-secret');
  });

  it('falls back to NETIFLY_SECRET when the option is omitted', () => {
    process.env.NETIFLY_SECRET = 'env-secret';
    expect(resolveActionSecret(undefined)).toBe('env-secret');
  });

  it('returns undefined when explicitly disabled with actionSecret: false', () => {
    process.env.NETIFLY_SECRET = 'env-secret';
    expect(resolveActionSecret(false)).toBeUndefined();
  });

  it('throws when neither the option nor NETIFLY_SECRET is set', () => {
    delete process.env.NETIFLY_SECRET;
    expect(() => resolveActionSecret(undefined)).toThrow(
      'Netifly: no actionSecret provided and NETIFLY_SECRET is not set'
    );
  });

  it('throws when the option is an empty string and NETIFLY_SECRET is unset', () => {
    delete process.env.NETIFLY_SECRET;
    expect(() => resolveActionSecret('')).toThrow(
      'Netifly: no actionSecret provided and NETIFLY_SECRET is not set'
    );
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd packages/core && npx jest actionSecret.test.ts`
Expected: FAIL — `Cannot find module './actionSecret'`.

- [ ] **Step 3: Implement `actionSecret.ts`**

Create `packages/core/src/actionSecret.ts`:

```ts
/**
 * Resolves the HMAC secret used to sign/verify kind:'action' notification
 * tokens. `optionValue === false` means the caller explicitly disabled
 * actions for this server/publisher — returns `undefined` in that case
 * (meaning "actions disabled," not "unset"). Any other missing value
 * (option omitted and NETIFLY_SECRET unset) is a configuration error and
 * throws at construction time — see the NOT-38 spec §6 for why this is
 * validated eagerly rather than lazily on first use.
 */
export function resolveActionSecret(optionValue: string | false | undefined): string | undefined {
  if (optionValue === false) {
    return undefined;
  }
  if (typeof optionValue === 'string' && optionValue.length > 0) {
    return optionValue;
  }
  const fromEnv = process.env.NETIFLY_SECRET;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return fromEnv;
  }
  throw new Error(
    "Netifly: no actionSecret provided and NETIFLY_SECRET is not set. Pass { actionSecret } or set NETIFLY_SECRET — or pass { actionSecret: false } to disable kind:'action' notifications for this server."
  );
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `cd packages/core && npx jest actionSecret.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `cd packages/core && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

```bash
git add packages/core/src/actionSecret.ts packages/core/src/actionSecret.test.ts
git commit -m "feat(core): add actionSecret resolution for actionable notifications (NOT-38)"
```

---

### Task 3: Signed action tokens

**Files:**
- Create: `packages/core/src/actionToken.ts`
- Create: `packages/core/src/actionToken.test.ts`

**Interfaces:**
- Consumes: `ActionNotification`, `NotificationAction`, `UserId`, `WireNotification` types from Task 1.
- Produces: `ActionTokenPayload`, `signActionToken(payload, secret): string`, `verifyActionToken(token, secret): VerifyActionTokenResult`, `buildActionWireNotification(notification, params): WireNotification` — consumed by Task 6 and Task 7.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/actionToken.test.ts`:

```ts
import { buildActionWireNotification, signActionToken, verifyActionToken } from './actionToken';
import type { ActionNotification } from './types';

const SECRET = 'test-secret';

function basePayload() {
  return { nid: 'notif-1', uid: 'user-1', aid: 'approve', exp: Date.now() + 60_000, ctx: null };
}

describe('signActionToken / verifyActionToken', () => {
  it('round-trips a payload signed and verified with the same secret', () => {
    const payload = basePayload();
    const token = signActionToken(payload, SECRET);
    expect(verifyActionToken(token, SECRET)).toEqual({ ok: true, payload });
  });

  it('round-trips a non-null context object', () => {
    const payload = { ...basePayload(), ctx: { expenseId: 'exp_123' } };
    const token = signActionToken(payload, SECRET);
    expect(verifyActionToken(token, SECRET)).toEqual({ ok: true, payload });
  });

  it('rejects a token signed with a different secret', () => {
    const token = signActionToken(basePayload(), SECRET);
    expect(verifyActionToken(token, 'wrong-secret')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a token with a tampered payload segment', () => {
    const token = signActionToken(basePayload(), SECRET);
    const [encoded, signature] = token.split('.');
    expect(verifyActionToken(`${encoded}x.${signature}`, SECRET)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('rejects a token with a tampered signature segment', () => {
    const token = signActionToken(basePayload(), SECRET);
    const [encoded, signature] = token.split('.');
    const flipped = signature[0] === 'a' ? `b${signature.slice(1)}` : `a${signature.slice(1)}`;
    expect(verifyActionToken(`${encoded}.${flipped}`, SECRET)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('rejects a token with no separator', () => {
    expect(verifyActionToken('not-a-real-token', SECRET)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a token with an empty payload segment', () => {
    expect(verifyActionToken('.somesignature', SECRET)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a token with an empty signature segment', () => {
    const token = signActionToken(basePayload(), SECRET);
    const [encoded] = token.split('.');
    expect(verifyActionToken(`${encoded}.`, SECRET)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('buildActionWireNotification', () => {
  function actionNotification(overrides: Partial<ActionNotification> = {}): ActionNotification {
    return {
      kind: 'action',
      title: 'Approve expense £420?',
      body: 'Submitted by Sam for Client dinner',
      actions: [
        { id: 'approve', label: 'Approve', style: 'primary' },
        { id: 'reject', label: 'Reject', style: 'danger' },
      ],
      expiresAt: Date.now() + 3600_000,
      context: { expenseId: 'exp_123' },
      ...overrides,
    };
  }

  it('embeds a signed token per action and strips context from the wire payload', () => {
    const notification = actionNotification();
    const wire = buildActionWireNotification(notification, {
      notificationId: 'notif-1',
      userId: 'user-1',
      secret: SECRET,
    });

    expect(wire.kind).toBe('action');
    expect('context' in wire).toBe(false);
    expect(wire).toMatchObject({
      title: notification.title,
      body: notification.body,
      expiresAt: notification.expiresAt,
    });

    const wireActions = (wire as { actions: { id: string; token: string }[] }).actions;
    expect(wireActions).toHaveLength(2);
    for (const action of wireActions) {
      expect(verifyActionToken(action.token, SECRET)).toEqual({
        ok: true,
        payload: {
          nid: 'notif-1',
          uid: 'user-1',
          aid: action.id,
          exp: notification.expiresAt,
          ctx: { expenseId: 'exp_123' },
        },
      });
    }
  });

  it('signs ctx: null when the notification has no context', () => {
    const notification = actionNotification({ context: undefined });
    const wire = buildActionWireNotification(notification, {
      notificationId: 'notif-2',
      userId: 'user-1',
      secret: SECRET,
    });
    const [firstAction] = (wire as { actions: { token: string }[] }).actions;
    const verified = verifyActionToken(firstAction.token, SECRET);
    expect(verified.ok && verified.payload.ctx).toBe(null);
  });

  it('omits meta from the wire payload when not provided', () => {
    const wire = buildActionWireNotification(actionNotification(), {
      notificationId: 'notif-3',
      userId: 'user-1',
      secret: SECRET,
    });
    expect('meta' in wire).toBe(false);
  });

  it('includes meta on the wire payload when provided', () => {
    const wire = buildActionWireNotification(actionNotification({ meta: { source: 'expenses' } }), {
      notificationId: 'notif-4',
      userId: 'user-1',
      secret: SECRET,
    });
    expect((wire as { meta?: unknown }).meta).toEqual({ source: 'expenses' });
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd packages/core && npx jest actionToken.test.ts`
Expected: FAIL — `Cannot find module './actionToken'`.

- [ ] **Step 3: Implement `actionToken.ts`**

Create `packages/core/src/actionToken.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ActionNotification, UserId, WireNotification } from './types';

/** The payload signed into every action token — see NOT-38 spec §6. */
export interface ActionTokenPayload {
  nid: string;
  uid: UserId;
  aid: string;
  exp: number;
  ctx: Record<string, unknown> | null;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(encodedPayload).digest('hex');
}

export function signActionToken(payload: ActionTokenPayload, secret: string): string {
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

export type VerifyActionTokenResult =
  | { ok: true; payload: ActionTokenPayload }
  | { ok: false; reason: 'invalid' };

/**
 * Verifies a token produced by signActionToken(): recomputes the HMAC over
 * the encoded payload and compares it (timing-safe) against the signature,
 * then structurally validates the decoded payload. Never throws — every
 * failure mode (malformed token, bad signature, undecodable/malshaped
 * payload) comes back as `{ ok: false, reason: 'invalid' }`.
 */
export function verifyActionToken(token: string, secret: string): VerifyActionTokenResult {
  const separatorIndex = token.lastIndexOf('.');
  if (separatorIndex <= 0 || separatorIndex === token.length - 1) {
    return { ok: false, reason: 'invalid' };
  }

  const encoded = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  const expected = sign(encoded, secret);

  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(signature, 'hex');
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    return { ok: false, reason: 'invalid' };
  }

  let payload: ActionTokenPayload;
  try {
    payload = JSON.parse(base64UrlDecode(encoded)) as ActionTokenPayload;
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof payload.nid !== 'string' ||
    typeof payload.uid !== 'string' ||
    typeof payload.aid !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return { ok: false, reason: 'invalid' };
  }

  return { ok: true, payload };
}

/**
 * Builds what actually goes on the wire for a kind:'action' notification:
 * each action gets a signed token embedding
 * notificationId/userId/actionId/expiresAt/context, and `context` itself is
 * never a plain top-level field (see NOT-38 spec §6).
 */
export function buildActionWireNotification(
  notification: ActionNotification,
  params: { notificationId: string; userId: UserId; secret: string }
): WireNotification {
  const wireActions = notification.actions.map((action) => ({
    ...action,
    token: signActionToken(
      {
        nid: params.notificationId,
        uid: params.userId,
        aid: action.id,
        exp: notification.expiresAt,
        ctx: notification.context ?? null,
      },
      params.secret
    ),
  }));

  return {
    kind: 'action',
    title: notification.title,
    body: notification.body,
    actions: wireActions,
    expiresAt: notification.expiresAt,
    ...(notification.meta !== undefined ? { meta: notification.meta } : {}),
  };
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd packages/core && npx jest actionToken.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `cd packages/core && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

```bash
git add packages/core/src/actionToken.ts packages/core/src/actionToken.test.ts
git commit -m "feat(core): add signed action token construction and verification (NOT-38)"
```

---

### Task 4: Redis answered-lock

**Files:**
- Modify: `packages/core/src/redisRouter.ts`
- Modify: `packages/core/src/redisRouter.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (pure infrastructure addition to an existing class).
- Produces: `answeredKey(notificationId, namespace?): string` and `RedisRouter.tryLockAnswered(notificationId, actionId, ttlSeconds): Promise<boolean>` — consumed by Task 6.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/redisRouter.test.ts`, change the top import line from:

```ts
import { RedisRouter, RedisRouterOptions, channelName } from './redisRouter';
```

to:

```ts
import { RedisRouter, RedisRouterOptions, answeredKey, channelName } from './redisRouter';
```

Then insert, immediately before the file's final `});` (the closing brace of the outer `describe('RedisRouter', ...)` block):

```ts
  describe('tryLockAnswered', () => {
    it('the first caller wins and later callers for the same notificationId lose', async () => {
      const router = createRouter(() => {});
      const first = await router.tryLockAnswered('redisRouter-answered-1', 'approve', 60);
      const second = await router.tryLockAnswered('redisRouter-answered-1', 'reject', 60);
      expect(first).toBe(true);
      expect(second).toBe(false);
    });

    it('different notificationIds do not contend with each other', async () => {
      const router = createRouter(() => {});
      const a = await router.tryLockAnswered('redisRouter-answered-a', 'approve', 60);
      const b = await router.tryLockAnswered('redisRouter-answered-b', 'approve', 60);
      expect(a).toBe(true);
      expect(b).toBe(true);
    });

    it('is namespace-aware, matching subscribe/publish', async () => {
      const routerA = createRouter(() => {}, { namespace: 'redisRouter-tenant-a' });
      const routerB = createRouter(() => {}, { namespace: 'redisRouter-tenant-b' });
      const a = await routerA.tryLockAnswered('redisRouter-answered-shared', 'approve', 60);
      const b = await routerB.tryLockAnswered('redisRouter-answered-shared', 'approve', 60);
      expect(a).toBe(true);
      expect(b).toBe(true);
    });
  });
});

describe('answeredKey', () => {
  it('formats the per-notification answered-lock key', () => {
    expect(answeredKey('notif-1')).toBe('netifly:answered:notif-1');
  });

  it('formats a namespaced answered-lock key', () => {
    expect(answeredKey('notif-1', 'tenant-a')).toBe('netifly:tenant-a:answered:notif-1');
  });
});
```

(Note: the first `});` above closes the pre-existing `describe('RedisRouter', ...)` block — the new `describe('answeredKey', ...)` is a new top-level block after it, mirroring how `describe('channelName', ...)` already sits above `describe('RedisRouter', ...)` in this file.)

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd packages/core && REDIS_URL=redis://127.0.0.1:6379 npx jest redisRouter.test.ts -t "tryLockAnswered|answeredKey"`
Expected: FAIL — `router.tryLockAnswered is not a function` / `answeredKey is not exported`.

- [ ] **Step 3: Implement `tryLockAnswered`/`answeredKey`**

In `packages/core/src/redisRouter.ts`, add this constant right after the existing `const MAX_USER_ID_LENGTH = 256;`:

```ts
const ANSWERED_SEGMENT = 'answered:';
```

Add this function right after the existing `channelPrefix` function:

```ts
function answeredKeyPrefix(namespace?: string): string {
  return namespace ? `${CHANNEL_PREFIX}${namespace}:${ANSWERED_SEGMENT}` : `${CHANNEL_PREFIX}${ANSWERED_SEGMENT}`;
}
```

Add this exported function right after the existing `export function channelName(...)`:

```ts
export function answeredKey(notificationId: string, namespace?: string): string {
  if (typeof notificationId !== 'string' || notificationId.length === 0) {
    throw new Error('Netifly: notificationId must be a non-empty string');
  }
  return `${answeredKeyPrefix(namespace)}${notificationId}`;
}
```

Add this method to the `RedisRouter` class, right after the existing `publish()` method:

```ts
  private answeredKeyFor(notificationId: string): string {
    return answeredKey(notificationId, this.namespace);
  }

  /**
   * Attempts to atomically claim "this notificationId's action has been
   * answered" via Redis SET NX EX — the first caller across any instance to
   * successfully SET wins; every later attempt (same or different instance)
   * for the same notificationId gets `false` back until the key expires.
   * Run on `this.publisher` (a plain client, safe for arbitrary commands),
   * same reasoning as `numSubscribers()` above. `actionId` is stored as the
   * value purely for operator visibility when inspecting Redis directly;
   * nothing reads it back.
   */
  async tryLockAnswered(notificationId: string, actionId: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.publisher.set(
      this.answeredKeyFor(notificationId),
      actionId,
      'EX',
      ttlSeconds,
      'NX'
    );
    return result === 'OK';
  }
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd packages/core && REDIS_URL=redis://127.0.0.1:6379 npx jest redisRouter.test.ts`
Expected: PASS — the new tests and every pre-existing test in the file.

- [ ] **Step 5: Typecheck and commit**

Run: `cd packages/core && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

```bash
git add packages/core/src/redisRouter.ts packages/core/src/redisRouter.test.ts
git commit -m "feat(core): add RedisRouter.tryLockAnswered() for actionable notifications (NOT-38)"
```

---

### Task 5: Inbound `action` frame parsing

**Files:**
- Modify: `packages/core/src/inboundFrame.ts`
- Modify: `packages/core/src/inboundFrame.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `InboundFrame` widened with an `{ type: 'action'; id; action; token; input? }` variant, `parseInboundFrame` handling it — consumed by Task 6.

- [ ] **Step 1: Write the failing tests**

Insert into `packages/core/src/inboundFrame.test.ts`, immediately before the file's final `});`:

```ts

  it('parses a valid action frame', () => {
    const result = parseInboundFrame(
      JSON.stringify({ type: 'action', id: 'notif-6', action: 'approve', token: 'abc.def' })
    );
    expect(result).toEqual({
      ok: true,
      frame: { type: 'action', id: 'notif-6', action: 'approve', token: 'abc.def', input: undefined },
    });
  });

  it('parses a valid action frame with input', () => {
    const result = parseInboundFrame(
      JSON.stringify({
        type: 'action',
        id: 'notif-7',
        action: 'reject',
        token: 'abc.def',
        input: 'because',
      })
    );
    expect(result).toEqual({
      ok: true,
      frame: { type: 'action', id: 'notif-7', action: 'reject', token: 'abc.def', input: 'because' },
    });
  });

  it('rejects an action frame missing the action key', () => {
    expect(parseInboundFrame(JSON.stringify({ type: 'action', id: 'x', token: 'abc.def' }))).toEqual({
      ok: false,
      reason: 'invalidShape',
    });
  });

  it('rejects an action frame missing the token key', () => {
    expect(parseInboundFrame(JSON.stringify({ type: 'action', id: 'x', action: 'approve' }))).toEqual({
      ok: false,
      reason: 'invalidShape',
    });
  });

  it('rejects an action frame with a non-string action', () => {
    expect(
      parseInboundFrame(JSON.stringify({ type: 'action', id: 'x', action: 42, token: 'abc.def' }))
    ).toEqual({ ok: false, reason: 'invalidShape' });
  });

  it('rejects an action frame with an empty-string token', () => {
    expect(
      parseInboundFrame(JSON.stringify({ type: 'action', id: 'x', action: 'approve', token: '' }))
    ).toEqual({ ok: false, reason: 'invalidShape' });
  });
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd packages/core && npx jest inboundFrame.test.ts`
Expected: FAIL — the new cases get `{ ok: false, reason: 'invalidShape' }` for the two valid-frame tests (unrecognized `type`), since `'action'` isn't handled yet.

- [ ] **Step 3: Implement the `action` branch**

In `packages/core/src/inboundFrame.ts`, replace the `InboundFrame` type:

```ts
/** A validated client → server control frame (see NOT-30 spec §5). */
export type InboundFrame =
  | { type: 'ack'; id: string }
  | { type: 'read'; id: string }
  | { type: 'response'; id: string; payload: unknown };
```

with:

```ts
/** A validated client → server control frame (see NOT-30 spec §5, NOT-38 spec §6 for 'action'). */
export type InboundFrame =
  | { type: 'ack'; id: string }
  | { type: 'read'; id: string }
  | { type: 'response'; id: string; payload: unknown }
  | { type: 'action'; id: string; action: string; token: string; input?: unknown };
```

Then, inside `parseInboundFrame`, replace the final line:

```ts
  return { ok: false, reason: 'invalidShape' };
```

with:

```ts
  if (type === 'action') {
    const { action, token, input } = value as { action?: unknown; token?: unknown; input?: unknown };
    if (typeof action !== 'string' || action.length === 0 || typeof token !== 'string' || token.length === 0) {
      return { ok: false, reason: 'invalidShape' };
    }
    return { ok: true, frame: { type: 'action', id, action, token, input } };
  }

  return { ok: false, reason: 'invalidShape' };
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd packages/core && npx jest inboundFrame.test.ts`
Expected: PASS — every case in the file, old and new.

- [ ] **Step 5: Typecheck and commit**

Run: `cd packages/core && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

```bash
git add packages/core/src/inboundFrame.ts packages/core/src/inboundFrame.test.ts
git commit -m "feat(core): parse the inbound 'action' frame (NOT-38)"
```

---

### Task 6: Server-side wiring — `notify(kind:'action')`, verification, and the `'action'` event

**Files:**
- Modify: `packages/core/src/types.ts` (add `actionSecret` to `CreateNetiflyOptions`)
- Modify: `packages/core/src/netiflyServer.ts`
- Modify: `packages/core/src/netiflyServer.test.ts`
- Modify: `packages/core/src/netiflyPublisher.test.ts` (helper only — see Step 1)
- Modify: `packages/client/src/client.test.ts` (helper only — see Step 1)
- Modify: `packages/express/src/index.test.ts` (three call sites — see Step 1)

**Interfaces:**
- Consumes: `validateNotification` (Task 1), `resolveActionSecret` (Task 2), `verifyActionToken`/`buildActionWireNotification` (Task 3), `RedisRouter.tryLockAnswered` (Task 4), the widened `InboundFrame` (Task 5).
- Produces: `NetiflyInstance.notify()` handling `kind: 'action'`, `NetiflyInstance.on('action', ...)`, the `netifly.notification.resolved` and `netifly.actionAck` wire frames — the last of these consumed by Task 8 (client).

- [ ] **Step 1: Keep the existing test suites green under eager `actionSecret` validation**

This step has no new test of its own — it's the mechanical fix the Breaking change note calls for, done *before* Step 2's new tests so intermediate runs stay green.

In `packages/core/src/netiflyServer.test.ts`, inside `startTestServer`, change:

```ts
  const netifly = createNetifly({
    server: httpServer,
    resolveUserId: resolveUserId as never,
    redisUrl: REDIS_URL,
    ...extra,
  });
```

to:

```ts
  const netifly = createNetifly({
    server: httpServer,
    resolveUserId: resolveUserId as never,
    redisUrl: REDIS_URL,
    actionSecret: false,
    ...extra,
  });
```

(`...extra` still spreads last, so any test that wants a real secret passes `{ actionSecret: 'some-secret' }` as `extra` and it overrides this default.)

Also add this helper to `packages/core/src/netiflyServer.test.ts`, right after the existing `connectClient` function — needed by Step 2's "wrong user" test, since `connectClient` has no way to attach a query string and `resolveUserId` there needs to distinguish two different callers by URL:

```ts
function connectClientWithQuery(port: number, query: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/netifly?${query}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
```

Also widen `nextMatchingMessage`'s declared type in the same file — it already parses and returns the full envelope at runtime, but its type signature currently omits `id`, and Step 2's tests below read `envelope.id` off its result (to correlate a notification with the `respondToAction`-style frame answering it). Change:

```ts
function nextMatchingMessage(
  ws: WebSocket,
  predicate: (envelope: { type: string; data: unknown }) => boolean
): Promise<{ type: string; data: unknown }> {
```

to:

```ts
function nextMatchingMessage(
  ws: WebSocket,
  predicate: (envelope: { id: string; type: string; data: unknown }) => boolean
): Promise<{ id: string; type: string; data: unknown }> {
```

(the function body is unchanged — only the type annotations widen to match what it already returns at runtime).

Make the identical `actionSecret: false` change to `startTestServer` in `packages/core/src/netiflyPublisher.test.ts`.

In `packages/client/src/client.test.ts`, inside `startServer`, change:

```ts
  const netifly = createNetifly<Events>({
    server: httpServer,
    resolveUserId,
    redisUrl: REDIS_URL,
    allowedOrigins: '*',
  });
```

to:

```ts
  const netifly = createNetifly<Events>({
    server: httpServer,
    resolveUserId,
    redisUrl: REDIS_URL,
    allowedOrigins: '*',
    actionSecret: false,
  });
```

In `packages/express/src/index.test.ts`, add `actionSecret: false,` to each of the three `attachNetifly(app, { ... })` call sites (after `redisUrl: REDIS_URL,` in each):

```ts
    const { server, netifly } = attachNetifly(app, {
      resolveUserId: () => 'netiflyExpress-eve',
      redisUrl: REDIS_URL,
      actionSecret: false,
    });
```

```ts
    const { server, netifly } = attachNetifly(app, {
      resolveUserId: () => null,
      redisUrl: REDIS_URL,
      actionSecret: false,
      server: existingServer,
    });
```

```ts
    const { server, netifly } = attachNetifly(app, {
      resolveUserId: () => 'netiflyExpress-req-netifly',
      redisUrl: REDIS_URL,
      actionSecret: false,
    });
```

Run every affected package's test suite now, *before* writing any new production code, to confirm this alone keeps everything green once Step 3 lands the throwing behavior:

Run: `cd packages/core && REDIS_URL=redis://127.0.0.1:6379 npx jest` and `cd packages/client && REDIS_URL=redis://127.0.0.1:6379 npx jest` and `cd packages/express && REDIS_URL=redis://127.0.0.1:6379 npx jest`
Expected at this point: still PASS (no production code changed yet — this step alone is inert until Step 3).

- [ ] **Step 2: Write the failing tests for `actionSecret`, `notify(kind:'action')`, and the full answer flow**

In `packages/core/src/types.ts`, add to `CreateNetiflyOptions<Events>`, right after the existing `validate` option:

```ts
  /**
   * HMAC secret used to sign kind:'action' notification tokens. Falls back
   * to the NETIFLY_SECRET environment variable. Required unless explicitly
   * set to `false`, in which case createNetifly() starts normally but any
   * notify() call with kind:'action' throws.
   */
  actionSecret?: string | false;
```

In `packages/core/src/netiflyServer.test.ts`, add these imports alongside the existing ones:

```ts
import { verifyActionToken } from './actionToken';
```

Then insert, immediately before the file's final `});` (after the `notify()` describe block added by NOT-37's plan, still inside the outer `describe('createNetifly', ...)`):

```ts
  describe('actionSecret', () => {
    it('throws at construction when neither actionSecret nor NETIFLY_SECRET is set', () => {
      const original = process.env.NETIFLY_SECRET;
      delete process.env.NETIFLY_SECRET;
      const httpServer = http.createServer();
      try {
        expect(() =>
          createNetifly({
            server: httpServer,
            resolveUserId: () => 'x',
            redisUrl: REDIS_URL,
          })
        ).toThrow('Netifly: no actionSecret provided and NETIFLY_SECRET is not set');
      } finally {
        if (original !== undefined) process.env.NETIFLY_SECRET = original;
      }
    });

    it('does not throw at construction when actionSecret: false is passed explicitly', async () => {
      const server = await startTestServer(() => 'netiflyServer-action-disabled-construct', {
        actionSecret: false,
      });
      servers.push(server);
      expect(server.netifly).toBeDefined();
    });

    it("notify(kind:'action') throws when actionSecret: false was passed", async () => {
      const server = await startTestServer(() => 'netiflyServer-action-disabled-notify');
      servers.push(server);

      await expect(
        server.netifly.notify('netiflyServer-action-disabled-notify', {
          kind: 'action',
          title: 'Approve?',
          body: 'x',
          actions: [{ id: 'approve', label: 'Approve' }],
          expiresAt: Date.now() + 60_000,
        })
      ).rejects.toThrow("Netifly: kind:'action' notifications are disabled");
    });
  });

  describe("notify(kind:'action') and answering it", () => {
    it('delivers actions with signed tokens; a valid answer fires action, resolves both devices, and acks accepted', async () => {
      const secret = 'netiflyServer-action-secret';
      const server = await startTestServer(() => 'netiflyServer-action-user', { actionSecret: secret });
      servers.push(server);

      const wsA = await connectClient(server.port);
      clients.push(wsA);
      await onceEvent(server.netifly, 'connect');
      const wsB = await connectClient(server.port);
      clients.push(wsB);

      const notificationPromise = nextMatchingMessage(wsA, (e) => e.type === 'notification');
      const actionPromise = onceInfo<{
        userId: string;
        notificationId: string;
        actionId: string;
        input?: unknown;
        context?: Record<string, unknown>;
      }>(server.netifly, 'action');
      const resolvedOnA = nextMatchingMessage(wsA, (e) => e.type === 'netifly.notification.resolved');
      const resolvedOnB = nextMatchingMessage(wsB, (e) => e.type === 'netifly.notification.resolved');

      await server.netifly.notify('netiflyServer-action-user', {
        kind: 'action',
        title: 'Approve expense £420?',
        body: 'Submitted by Sam',
        actions: [{ id: 'approve', label: 'Approve' }],
        expiresAt: Date.now() + 60_000,
        context: { expenseId: 'exp_123' },
      });

      const envelope = await notificationPromise;
      const data = envelope.data as { actions: { id: string; token: string }[] };
      const token = data.actions[0].token;
      expect(verifyActionToken(token, secret).ok).toBe(true);

      const ackPromise = nextMatchingMessage(wsA, (e) => e.type === 'netifly.actionAck');
      wsA.send(JSON.stringify({ type: 'action', id: envelope.id, action: 'approve', token }));

      const info = await actionPromise;
      expect(info).toEqual({
        userId: 'netiflyServer-action-user',
        notificationId: envelope.id,
        actionId: 'approve',
        input: undefined,
        context: { expenseId: 'exp_123' },
      });

      const ack = await ackPromise;
      expect(ack.data).toEqual({ id: envelope.id, action: 'approve', status: 'accepted' });

      const resolvedA = await resolvedOnA;
      const resolvedB = await resolvedOnB;
      expect(resolvedA.data).toEqual({ id: envelope.id, action: 'approve' });
      expect(resolvedB.data).toEqual({ id: envelope.id, action: 'approve' });
    });

    it('rejects a tampered token as invalid', async () => {
      const secret = 'netiflyServer-action-tamper-secret';
      const server = await startTestServer(() => 'netiflyServer-action-tamper', { actionSecret: secret });
      servers.push(server);
      const ws = await connectClient(server.port);
      clients.push(ws);
      await onceEvent(server.netifly, 'connect');

      const notificationPromise = nextMatchingMessage(ws, (e) => e.type === 'notification');
      const actionCalls: unknown[] = [];
      server.netifly.on('action', (info) => actionCalls.push(info));

      await server.netifly.notify('netiflyServer-action-tamper', {
        kind: 'action',
        title: 'Approve?',
        body: 'x',
        actions: [{ id: 'approve', label: 'Approve' }],
        expiresAt: Date.now() + 60_000,
      });
      const envelope = await notificationPromise;
      const token = (envelope.data as { actions: { token: string }[] }).actions[0].token;
      const tamperedToken = `${token}garbage`;

      const ackPromise = nextMatchingMessage(ws, (e) => e.type === 'netifly.actionAck');
      ws.send(JSON.stringify({ type: 'action', id: envelope.id, action: 'approve', token: tamperedToken }));

      const ack = await ackPromise;
      expect(ack.data).toEqual({ id: envelope.id, action: 'approve', status: 'invalid' });
      expect(actionCalls).toHaveLength(0);
    });

    it("rejects a token answered by a different user's socket as invalid", async () => {
      const secret = 'netiflyServer-action-wronguser-secret';
      const server = await startTestServer(
        (req) => new URL(req.url ?? '', 'http://localhost').searchParams.get('user'),
        { actionSecret: secret }
      );
      servers.push(server);

      const wsOwner = await connectClientWithQuery(server.port, 'user=owner');
      clients.push(wsOwner);
      await onceEvent(server.netifly, 'connect');
      const wsAttacker = await connectClientWithQuery(server.port, 'user=attacker');
      clients.push(wsAttacker);

      const notificationPromise = nextMatchingMessage(wsOwner, (e) => e.type === 'notification');
      const actionCalls: unknown[] = [];
      server.netifly.on('action', (info) => actionCalls.push(info));

      await server.netifly.notify('owner', {
        kind: 'action',
        title: 'Approve?',
        body: 'x',
        actions: [{ id: 'approve', label: 'Approve' }],
        expiresAt: Date.now() + 60_000,
      });
      const envelope = await notificationPromise;
      const token = (envelope.data as { actions: { token: string }[] }).actions[0].token;

      const ackPromise = nextMatchingMessage(wsAttacker, (e) => e.type === 'netifly.actionAck');
      wsAttacker.send(JSON.stringify({ type: 'action', id: envelope.id, action: 'approve', token }));

      const ack = await ackPromise;
      expect(ack.data).toEqual({ id: envelope.id, action: 'approve', status: 'invalid' });
      expect(actionCalls).toHaveLength(0);
    });

    it('rejects an expired token', async () => {
      const secret = 'netiflyServer-action-expired-secret';
      const server = await startTestServer(() => 'netiflyServer-action-expired', { actionSecret: secret });
      servers.push(server);
      const ws = await connectClient(server.port);
      clients.push(ws);
      await onceEvent(server.netifly, 'connect');

      const notificationPromise = nextMatchingMessage(ws, (e) => e.type === 'notification');
      await server.netifly.notify('netiflyServer-action-expired', {
        kind: 'action',
        title: 'Approve?',
        body: 'x',
        actions: [{ id: 'approve', label: 'Approve' }],
        expiresAt: Date.now() + 200,
      });
      const envelope = await notificationPromise;
      const token = (envelope.data as { actions: { token: string }[] }).actions[0].token;

      await wait(300);

      const ackPromise = nextMatchingMessage(ws, (e) => e.type === 'netifly.actionAck');
      ws.send(JSON.stringify({ type: 'action', id: envelope.id, action: 'approve', token }));

      const ack = await ackPromise;
      expect(ack.data).toEqual({ id: envelope.id, action: 'approve', status: 'expired' });
    });

    it('rejects a second answer to an already-answered notification', async () => {
      const secret = 'netiflyServer-action-double-secret';
      const server = await startTestServer(() => 'netiflyServer-action-double', { actionSecret: secret });
      servers.push(server);
      const ws = await connectClient(server.port);
      clients.push(ws);
      await onceEvent(server.netifly, 'connect');

      const notificationPromise = nextMatchingMessage(ws, (e) => e.type === 'notification');
      const actionCalls: unknown[] = [];
      server.netifly.on('action', (info) => actionCalls.push(info));

      await server.netifly.notify('netiflyServer-action-double', {
        kind: 'action',
        title: 'Approve?',
        body: 'x',
        actions: [{ id: 'approve', label: 'Approve' }],
        expiresAt: Date.now() + 60_000,
      });
      const envelope = await notificationPromise;
      const token = (envelope.data as { actions: { token: string }[] }).actions[0].token;

      const firstAck = nextMatchingMessage(ws, (e) => e.type === 'netifly.actionAck');
      ws.send(JSON.stringify({ type: 'action', id: envelope.id, action: 'approve', token }));
      expect((await firstAck).data).toEqual({ id: envelope.id, action: 'approve', status: 'accepted' });

      const secondAck = nextMatchingMessage(ws, (e) => e.type === 'netifly.actionAck');
      ws.send(JSON.stringify({ type: 'action', id: envelope.id, action: 'approve', token }));
      expect((await secondAck).data).toEqual({
        id: envelope.id,
        action: 'approve',
        status: 'already_answered',
      });

      expect(actionCalls).toHaveLength(1);
    });

    it('two devices answering the same action concurrently: exactly one action event, both resolved', async () => {
      const secret = 'netiflyServer-action-race-secret';
      const server = await startTestServer(() => 'netiflyServer-action-race', { actionSecret: secret });
      servers.push(server);
      const wsA = await connectClient(server.port);
      clients.push(wsA);
      await onceEvent(server.netifly, 'connect');
      const wsB = await connectClient(server.port);
      clients.push(wsB);

      const notificationPromise = nextMatchingMessage(wsA, (e) => e.type === 'notification');
      const actionCalls: unknown[] = [];
      server.netifly.on('action', (info) => actionCalls.push(info));

      await server.netifly.notify('netiflyServer-action-race', {
        kind: 'action',
        title: 'Approve?',
        body: 'x',
        actions: [{ id: 'approve', label: 'Approve' }],
        expiresAt: Date.now() + 60_000,
      });
      const envelope = await notificationPromise;
      const token = (envelope.data as { actions: { token: string }[] }).actions[0].token;

      const ackA = nextMatchingMessage(wsA, (e) => e.type === 'netifly.actionAck');
      const ackB = nextMatchingMessage(wsB, (e) => e.type === 'netifly.actionAck');
      const frame = JSON.stringify({ type: 'action', id: envelope.id, action: 'approve', token });
      wsA.send(frame);
      wsB.send(frame);

      const statuses = [(await ackA).data, (await ackB).data].map(
        (d) => (d as { status: string }).status
      );
      expect(statuses.sort()).toEqual(['accepted', 'already_answered']);
      expect(actionCalls).toHaveLength(1);
    });

    it('multi-instance: notify() from instance A, answered on instance B, both see the resolved relay', async () => {
      const secret = 'netiflyServer-action-multiinstance-secret';
      const userId = 'netiflyServer-action-multiinstance';
      const instanceA = await startTestServer(() => userId, { actionSecret: secret });
      servers.push(instanceA);
      const instanceB = await startTestServer(() => userId, { actionSecret: secret });
      servers.push(instanceB);

      const wsA = await connectClient(instanceA.port);
      clients.push(wsA);
      await onceEvent(instanceA.netifly, 'connect');
      const wsB = await connectClient(instanceB.port);
      clients.push(wsB);
      await onceEvent(instanceB.netifly, 'connect');

      const notificationOnA = nextMatchingMessage(wsA, (e) => e.type === 'notification');
      const actionOnB = onceInfo<{ notificationId: string; actionId: string }>(instanceB.netifly, 'action');
      const resolvedOnA = nextMatchingMessage(wsA, (e) => e.type === 'netifly.notification.resolved');
      const resolvedOnB = nextMatchingMessage(wsB, (e) => e.type === 'netifly.notification.resolved');

      await instanceA.netifly.notify(userId, {
        kind: 'action',
        title: 'Approve?',
        body: 'x',
        actions: [{ id: 'approve', label: 'Approve' }],
        expiresAt: Date.now() + 60_000,
      });
      const envelope = await notificationOnA;
      const token = (envelope.data as { actions: { token: string }[] }).actions[0].token;

      const ackOnB = nextMatchingMessage(wsB, (e) => e.type === 'netifly.actionAck');
      wsB.send(JSON.stringify({ type: 'action', id: envelope.id, action: 'approve', token }));

      expect((await ackOnB).data).toEqual({ id: envelope.id, action: 'approve', status: 'accepted' });
      expect(await actionOnB).toEqual({ notificationId: envelope.id, actionId: 'approve' });
      expect((await resolvedOnA).data).toEqual({ id: envelope.id, action: 'approve' });
      expect((await resolvedOnB).data).toEqual({ id: envelope.id, action: 'approve' });
    });
  });
});
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `cd packages/core && REDIS_URL=redis://127.0.0.1:6379 npx jest netiflyServer.test.ts -t "action"`
Expected: FAIL — `actionSecret` is not recognized/validated, `notify()` doesn't special-case `kind: 'action'`, there is no `'action'` event, no `netifly.actionAck`/`netifly.notification.resolved` frames.

- [ ] **Step 4: Implement the server wiring**

In `packages/core/src/netiflyServer.ts`, add two new import lines, right after the existing `import { TokenBucket } from './rateLimiter';`:

```ts
import { resolveActionSecret } from './actionSecret';
import { buildActionWireNotification, verifyActionToken } from './actionToken';
```

Add a new type-only import line right after the existing `import { parseInboundFrame } from './inboundFrame';` (that line itself is unchanged — this is an additional line, not a replacement):

```ts
import type { InboundFrame } from './inboundFrame';
```

Add `ActionInfo` to the file's existing `import type { ... } from './types';` block (NOT-37's Task 2 already added `Notification` to this same block — this plan adds one more name to it, alphabetically):

```ts
import type {
  AckInfo,
  ActionInfo,
  AllowedOrigins,
  CloseOptions,
  CreateNetiflyOptions,
  Envelope,
  EventMap,
  MalformedFrameInfo,
  NetiflyInstance,
  Notification,
  RejectInfo,
  ResponseInfo,
  SendOrOptions,
  SendResult,
  SentInfo,
  UserId,
} from './types';
```

Change the `SAFE_EVENTS` constant:

```ts
const SAFE_EVENTS = new Set(['sent', 'delivered', 'read', 'response', 'malformedFrame']);
```

to:

```ts
const SAFE_EVENTS = new Set(['sent', 'delivered', 'read', 'response', 'malformedFrame', 'action']);
```

Add a field, and resolve it in the constructor. Add right after `private readonly validate: CreateNetiflyOptions<Events>['validate'];`:

```ts
  private readonly actionSecret: string | undefined;
```

In the constructor, right after `this.validate = options.validate;`, add:

```ts
    this.actionSecret = resolveActionSecret(options.actionSecret);
```

Change `buildEnvelope` to accept an optional preset id (needed so a `kind:'action'` notification's envelope id matches the `nid` embedded in its tokens):

```ts
  private buildEnvelope<T>(type: string, data: T): Envelope<T> {
    return { v: ENVELOPE_VERSION, id: this.ulid(), type, data, ts: Date.now() };
  }
```

to:

```ts
  private buildEnvelope<T>(type: string, data: T, id: string = this.ulid()): Envelope<T> {
    return { v: ENVELOPE_VERSION, id, type, data, ts: Date.now() };
  }
```

Change `publishEnvelope` (added by NOT-37's Task 2) to accept and forward an optional id:

```ts
  private async publishEnvelope<T>(userId: UserId, type: string, data: T): Promise<SendResult> {
    const envelope = this.buildEnvelope(type, data);
```

to:

```ts
  private async publishEnvelope<T>(userId: UserId, type: string, data: T, id?: string): Promise<SendResult> {
    const envelope = this.buildEnvelope(type, data, id);
```

(the rest of the method body is unchanged).

Change `notify()` (added by NOT-37's Task 2) from:

```ts
  async notify(userId: UserId, notification: Notification): Promise<SendResult> {
    if (this.closed) {
      throw new Error('Netifly: cannot send after close()');
    }
    validateNotification(notification);
    return this.publishEnvelope(userId, 'notification', notification);
  }
```

to:

```ts
  async notify(userId: UserId, notification: Notification): Promise<SendResult> {
    if (this.closed) {
      throw new Error('Netifly: cannot send after close()');
    }
    validateNotification(notification);

    if (notification.kind === 'action') {
      if (this.actionSecret === undefined) {
        throw new Error("Netifly: kind:'action' notifications are disabled (actionSecret: false).");
      }
      const id = this.ulid();
      const wireData = buildActionWireNotification(notification, {
        notificationId: id,
        userId,
        secret: this.actionSecret,
      });
      return this.publishEnvelope(userId, 'notification', wireData, id);
    }

    return this.publishEnvelope(userId, 'notification', notification);
  }
```

Change the connection's message listener from:

```ts
    const inboundBucket = new TokenBucket(this.maxInboundFramesPerSecond);
    ws.on('message', (data) => this.handleInboundFrame(userId, data, inboundBucket));
```

to:

```ts
    const inboundBucket = new TokenBucket(this.maxInboundFramesPerSecond);
    ws.on('message', (data) => this.handleInboundFrame(userId, ws, data, inboundBucket));
```

Finally, replace the whole `handleInboundFrame` method:

```ts
  private handleInboundFrame(userId: UserId, data: RawData, bucket: TokenBucket): void {
    if (!bucket.tryRemoveToken()) {
      this.emitMalformedFrame({ userId, reason: 'rateLimited' });
      return;
    }

    const parsed = parseInboundFrame(data.toString());
    if (!parsed.ok) {
      this.emitMalformedFrame({ userId, reason: parsed.reason });
      return;
    }

    const ts = Date.now();
    const frame = parsed.frame;
    let relayType: string;
    let relayData: unknown;

    if (frame.type === 'ack') {
      this.emit('delivered', { userId, id: frame.id, ts } satisfies AckInfo);
      relayType = 'netifly.ack';
      relayData = { id: frame.id };
    } else if (frame.type === 'read') {
      this.emit('read', { userId, id: frame.id, ts } satisfies AckInfo);
      relayType = 'netifly.read';
      relayData = { id: frame.id };
    } else {
      this.emit('response', { userId, id: frame.id, payload: frame.payload, ts } satisfies ResponseInfo);
      relayType = 'netifly.response';
      relayData = { id: frame.id, payload: frame.payload };
    }

    const relayEnvelope = this.buildEnvelope(relayType, relayData);
    this.router.publish(userId, relayEnvelope).catch((error: unknown) => this.emitError(error));
  }
```

with:

```ts
  private handleInboundFrame(userId: UserId, ws: WebSocket, data: RawData, bucket: TokenBucket): void {
    if (!bucket.tryRemoveToken()) {
      this.emitMalformedFrame({ userId, reason: 'rateLimited' });
      return;
    }

    const parsed = parseInboundFrame(data.toString());
    if (!parsed.ok) {
      this.emitMalformedFrame({ userId, reason: parsed.reason });
      return;
    }

    const frame = parsed.frame;

    if (frame.type === 'action') {
      void this.handleActionFrame(userId, ws, frame);
      return;
    }

    const ts = Date.now();
    let relayType: string;
    let relayData: unknown;

    if (frame.type === 'ack') {
      this.emit('delivered', { userId, id: frame.id, ts } satisfies AckInfo);
      relayType = 'netifly.ack';
      relayData = { id: frame.id };
    } else if (frame.type === 'read') {
      this.emit('read', { userId, id: frame.id, ts } satisfies AckInfo);
      relayType = 'netifly.read';
      relayData = { id: frame.id };
    } else {
      this.emit('response', { userId, id: frame.id, payload: frame.payload, ts } satisfies ResponseInfo);
      relayType = 'netifly.response';
      relayData = { id: frame.id, payload: frame.payload };
    }

    const relayEnvelope = this.buildEnvelope(relayType, relayData);
    this.router.publish(userId, relayEnvelope).catch((error: unknown) => this.emitError(error));
  }

  // Verifies a client's answer to an actionable notification (NOT-38 spec
  // §6) and always resolves to exactly one of the four ack statuses on the
  // answering socket — never throws, never leaves the frame unanswered.
  private async handleActionFrame(
    userId: UserId,
    ws: WebSocket,
    frame: Extract<InboundFrame, { type: 'action' }>
  ): Promise<void> {
    if (this.actionSecret === undefined) {
      this.sendActionAck(ws, frame.id, frame.action, 'invalid');
      return;
    }

    const verified = verifyActionToken(frame.token, this.actionSecret);
    if (!verified.ok) {
      this.sendActionAck(ws, frame.id, frame.action, 'invalid');
      return;
    }

    const { payload } = verified;
    if (payload.nid !== frame.id || payload.aid !== frame.action || payload.uid !== userId) {
      this.sendActionAck(ws, frame.id, frame.action, 'invalid');
      return;
    }

    if (Date.now() > payload.exp) {
      this.sendActionAck(ws, frame.id, frame.action, 'expired');
      return;
    }

    const ttlSeconds = Math.max(1, Math.ceil((payload.exp - Date.now()) / 1000));
    let locked: boolean;
    try {
      locked = await this.router.tryLockAnswered(payload.nid, payload.aid, ttlSeconds);
    } catch (error) {
      this.emitError(error);
      return;
    }
    if (!locked) {
      this.sendActionAck(ws, frame.id, frame.action, 'already_answered');
      return;
    }

    this.emit('action', {
      userId,
      notificationId: payload.nid,
      actionId: payload.aid,
      input: frame.input,
      context: payload.ctx ?? undefined,
    } satisfies ActionInfo);

    const resolvedEnvelope = this.buildEnvelope('netifly.notification.resolved', {
      id: payload.nid,
      action: payload.aid,
    });
    this.router.publish(userId, resolvedEnvelope).catch((error: unknown) => this.emitError(error));

    this.sendActionAck(ws, frame.id, frame.action, 'accepted');
  }

  private sendActionAck(
    ws: WebSocket,
    id: string,
    action: string,
    status: 'accepted' | 'already_answered' | 'expired' | 'invalid'
  ): void {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const envelope = this.buildEnvelope('netifly.actionAck', { id, action, status });
    ws.send(JSON.stringify(envelope));
  }
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd packages/core && REDIS_URL=redis://127.0.0.1:6379 npx jest netiflyServer.test.ts`
Expected: PASS — every new `action`-related test and every pre-existing test in the file.

- [ ] **Step 6: Run the full core, client, and express suites**

Run: `cd packages/core && REDIS_URL=redis://127.0.0.1:6379 npx jest`
Run: `cd packages/client && REDIS_URL=redis://127.0.0.1:6379 npx jest`
Run: `cd packages/express && REDIS_URL=redis://127.0.0.1:6379 npx jest`
Expected: PASS across all three — confirms Step 1's `actionSecret: false` fixes actually hold once the throwing behavior from Step 4 is live.

- [ ] **Step 7: Typecheck and commit**

Run: `cd packages/core && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

```bash
git add packages/core/src/types.ts packages/core/src/netiflyServer.ts packages/core/src/netiflyServer.test.ts packages/core/src/netiflyPublisher.test.ts packages/client/src/client.test.ts packages/express/src/index.test.ts
git commit -m "feat(core): actionable notifications — verified answers, 'action' event, resolved relay (NOT-38)

BREAKING CHANGE: createNetifly()/createNetiflyPublisher() now throw at
construction unless actionSecret or NETIFLY_SECRET is set, or
actionSecret: false is passed explicitly."
```

---

### Task 7: Publisher-side `notify(kind:'action')`

**Files:**
- Modify: `packages/core/src/types.ts` (add `actionSecret` to `CreateNetiflyPublisherOptions`)
- Modify: `packages/core/src/netiflyPublisher.ts`
- Modify: `packages/core/src/netiflyPublisher.test.ts`

**Interfaces:**
- Consumes: `resolveActionSecret` (Task 2), `buildActionWireNotification` (Task 3).
- Produces: `NetiflyPublisher.notify()` handling `kind: 'action'` — no `'action'` event on the publisher (non-goal, see spec §3), it can only originate an actionable notification.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/types.ts`, add to `CreateNetiflyPublisherOptions<Events>`, right after the existing `validate` option:

```ts
  /** Same actionSecret resolution as CreateNetiflyOptions — see there for details. */
  actionSecret?: string | false;
```

In `packages/core/src/netiflyPublisher.test.ts`, add this import alongside the existing ones:

```ts
import { verifyActionToken } from './actionToken';
```

Insert, immediately before the file's final `});` (after the `notify()` describe block added by NOT-37's plan, still inside the outer `describe('createNetiflyPublisher', ...)`):

```ts
  describe('actionSecret', () => {
    it('throws at construction when neither actionSecret nor NETIFLY_SECRET is set', () => {
      const original = process.env.NETIFLY_SECRET;
      delete process.env.NETIFLY_SECRET;
      try {
        expect(() => createNetiflyPublisher({ redisUrl: REDIS_URL })).toThrow(
          'Netifly: no actionSecret provided and NETIFLY_SECRET is not set'
        );
      } finally {
        if (original !== undefined) process.env.NETIFLY_SECRET = original;
      }
    });

    it('does not throw at construction when actionSecret: false is passed', () => {
      expect(() => {
        const publisher = createNetiflyPublisher({ redisUrl: REDIS_URL, actionSecret: false });
        publishers.push(publisher);
      }).not.toThrow();
    });

    it("notify(kind:'action') throws when actionSecret: false was passed", async () => {
      const publisher = createNetiflyPublisher({ redisUrl: REDIS_URL, actionSecret: false });
      publishers.push(publisher);

      await expect(
        publisher.notify('netiflyPublisher-action-disabled', {
          kind: 'action',
          title: 'Approve?',
          body: 'x',
          actions: [{ id: 'approve', label: 'Approve' }],
          expiresAt: Date.now() + 60_000,
        })
      ).rejects.toThrow("Netifly: kind:'action' notifications are disabled");
    });
  });

  describe("notify(kind:'action')", () => {
    it('publishes an action notification whose token verifies with the configured secret', async () => {
      const secret = 'netiflyPublisher-action-secret';
      const server = await startTestServer(() => 'netiflyPublisher-action-user');
      servers.push(server);
      const ws = await connectClient(server.port);
      clients.push(ws);
      await onceEvent(server.netifly, 'connect');

      const publisher = createNetiflyPublisher({ redisUrl: REDIS_URL, actionSecret: secret });
      publishers.push(publisher);

      const messagePromise = nextMessage(ws);
      await publisher.notify('netiflyPublisher-action-user', {
        kind: 'action',
        title: 'Approve expense £420?',
        body: 'Submitted by Sam',
        actions: [{ id: 'approve', label: 'Approve' }],
        expiresAt: Date.now() + 60_000,
        context: { expenseId: 'exp_123' },
      });

      const envelope = JSON.parse(await messagePromise);
      const action = (envelope.data as { actions: { id: string; token: string }[] }).actions[0];
      expect(action.id).toBe('approve');
      expect(verifyActionToken(action.token, secret)).toEqual({
        ok: true,
        payload: {
          nid: envelope.id,
          uid: 'netiflyPublisher-action-user',
          aid: 'approve',
          exp: envelope.data.expiresAt,
          ctx: { expenseId: 'exp_123' },
        },
      });
    });
  });
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd packages/core && REDIS_URL=redis://127.0.0.1:6379 npx jest netiflyPublisher.test.ts -t "action"`
Expected: FAIL — `actionSecret` isn't validated/used, `notify(kind:'action')` doesn't sign tokens.

- [ ] **Step 3: Implement the publisher wiring**

In `packages/core/src/netiflyPublisher.ts`, add to the imports:

```ts
import { resolveActionSecret } from './actionSecret';
import { buildActionWireNotification } from './actionToken';
import { validateNotification } from './notification';
```

(`validateNotification` was already imported by NOT-37's Task 3 — leave it as-is if present.)

Add a field and resolve it in the constructor. Right after `private readonly validate: CreateNetiflyPublisherOptions<Events>['validate'];`, add:

```ts
  private readonly actionSecret: string | undefined;
```

In the constructor, right after `this.validate = options.validate;`, add:

```ts
    this.actionSecret = resolveActionSecret(options.actionSecret);
```

Change `buildEnvelope` to accept an optional preset id, same as Task 6's server-side change:

```ts
  private buildEnvelope<T>(type: string, data: T): Envelope<T> {
    return { v: ENVELOPE_VERSION, id: this.ulid(), type, data, ts: Date.now() };
  }
```

to:

```ts
  private buildEnvelope<T>(type: string, data: T, id: string = this.ulid()): Envelope<T> {
    return { v: ENVELOPE_VERSION, id, type, data, ts: Date.now() };
  }
```

Change `publishEnvelope` (added by NOT-37's Task 3) to accept and forward an optional id:

```ts
  private async publishEnvelope<T>(userId: UserId, type: string, data: T): Promise<SendResult> {
    const envelope = this.buildEnvelope(type, data);
```

to:

```ts
  private async publishEnvelope<T>(userId: UserId, type: string, data: T, id?: string): Promise<SendResult> {
    const envelope = this.buildEnvelope(type, data, id);
```

(rest of the method body unchanged).

Change `notify()` (added by NOT-37's Task 3) from:

```ts
  async notify(userId: UserId, notification: Notification): Promise<SendResult> {
    this.assertNotClosed();
    validateNotification(notification);
    return this.publishEnvelope(userId, 'notification', notification);
  }
```

to:

```ts
  async notify(userId: UserId, notification: Notification): Promise<SendResult> {
    this.assertNotClosed();
    validateNotification(notification);

    if (notification.kind === 'action') {
      if (this.actionSecret === undefined) {
        throw new Error("Netifly: kind:'action' notifications are disabled (actionSecret: false).");
      }
      const id = this.ulid();
      const wireData = buildActionWireNotification(notification, {
        notificationId: id,
        userId,
        secret: this.actionSecret,
      });
      return this.publishEnvelope(userId, 'notification', wireData, id);
    }

    return this.publishEnvelope(userId, 'notification', notification);
  }
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd packages/core && REDIS_URL=redis://127.0.0.1:6379 npx jest netiflyPublisher.test.ts`
Expected: PASS — every new test and every pre-existing test in the file.

- [ ] **Step 5: Typecheck and commit**

Run: `cd packages/core && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

```bash
git add packages/core/src/types.ts packages/core/src/netiflyPublisher.ts packages/core/src/netiflyPublisher.test.ts
git commit -m "feat(core): NetiflyPublisher.notify(kind:'action') (NOT-38)"
```

---

### Task 8: Client-side `respondToAction()`/`onActionAck()`/`onResolved()`

**Files:**
- Modify: `packages/client/src/types.ts`
- Modify: `packages/client/src/client.ts`
- Modify: `packages/client/src/client.test.ts`

**Interfaces:**
- Consumes: the `netifly.actionAck`/`netifly.notification.resolved` wire frames produced by Task 6.
- Produces: `NetiflyClient.respondToAction(id, action, token, input?): void`, `.onActionAck(handler): Unsubscribe`, `.onResolved(handler): Unsubscribe`.

- [ ] **Step 1: Write the failing tests**

In `packages/client/src/types.ts`, add right after the existing `CloseInfo` interface:

```ts
/** Status returned by the server's `netifly.actionAck` reply to `respondToAction()`. */
export interface ActionAckInfo {
  id: string;
  action: string;
  status: 'accepted' | 'already_answered' | 'expired' | 'invalid';
}

/** The `netifly.notification.resolved` relay — syncs an answered action notification across a user's other tabs/devices. */
export interface ResolvedInfo {
  id: string;
  action: string;
}
```

In `packages/client/src/client.test.ts`, note that `startServer()`'s `createNetifly<Events>()` call needs `actionSecret` configured for these tests specifically (the shared default from Task 6 Step 1 set `actionSecret: false`, which would make `netifly.notify(kind:'action')` throw). Add a second helper right after the existing `startServer` function:

```ts
async function startServerWithActions(secret: string, port = 0): Promise<TestServer> {
  const httpServer = http.createServer((_req, res) => res.end());
  const netifly = createNetifly<Events>({
    server: httpServer,
    resolveUserId,
    redisUrl: REDIS_URL,
    allowedOrigins: '*',
    actionSecret: secret,
  });
  netifly.on('error', () => {
    /* keep transient errors from crashing the test process */
  });
  await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));
  return { netifly, httpServer, port: (httpServer.address() as AddressInfo).port };
}
```

Then insert, immediately before the file's final `});` (a new top-level `describe`, after the existing `describe('acks and read state', ...)` block, still inside the outer `describe('NetiflyClient', ...)`):

```ts

  describe('actionable notifications', () => {
    it('respondToAction() sends an action frame with the given token and input, and the server answers with an accepted ack', async () => {
      const server = track(await startServerWithActions('client-action-secret'));
      const client = makeClient(server.port);

      client.connect();
      await nextState(client, 'open');

      const notificationReceived = new Promise<{ id: string; token: string }>((resolve) => {
        const off = client.onAny((envelope) => {
          if (envelope.type === 'notification') {
            off();
            const data = envelope.data as { actions: { id: string; token: string }[] };
            resolve({ id: envelope.id, token: data.actions[0].token });
          }
        });
      });

      await server.netifly.notify('alice', {
        kind: 'action',
        title: 'Approve?',
        body: 'x',
        actions: [{ id: 'approve', label: 'Approve' }],
        expiresAt: Date.now() + 60_000,
      });
      const { id, token } = await notificationReceived;

      const ackPromise = new Promise<ActionAckInfo>((resolve) => {
        const off = client.onActionAck((info) => {
          off();
          resolve(info);
        });
      });

      client.respondToAction(id, 'approve', token);

      const ack = await ackPromise;
      expect(ack).toEqual({ id, action: 'approve', status: 'accepted' });
    });

    it('onResolved() fires on a second device when the first answers', async () => {
      const server = track(await startServerWithActions('client-action-secret-2'));
      const clientA = makeClient(server.port);
      const clientB = makeClient(server.port);

      clientA.connect();
      await nextState(clientA, 'open');
      clientB.connect();
      await nextState(clientB, 'open');

      const notificationOnA = new Promise<{ id: string; token: string }>((resolve) => {
        const off = clientA.onAny((envelope) => {
          if (envelope.type === 'notification') {
            off();
            const data = envelope.data as { actions: { id: string; token: string }[] };
            resolve({ id: envelope.id, token: data.actions[0].token });
          }
        });
      });

      await server.netifly.notify('alice', {
        kind: 'action',
        title: 'Approve?',
        body: 'x',
        actions: [{ id: 'approve', label: 'Approve' }],
        expiresAt: Date.now() + 60_000,
      });
      const { id, token } = await notificationOnA;

      const resolvedOnB = new Promise<ResolvedInfo>((resolve) => {
        const off = clientB.onResolved((info) => {
          off();
          resolve(info);
        });
      });

      clientA.respondToAction(id, 'approve', token);

      expect(await resolvedOnB).toEqual({ id, action: 'approve' });
    });

    it('respondToAction() no-ops when not connected', () => {
      const client = createNetiflyClient<Events>({ url: 'ws://127.0.0.1:1/netifly' });
      clients.push(client);
      expect(() => client.respondToAction('x', 'approve', 'token')).not.toThrow();
    });

    it("netifly.actionAck does not dispatch through on(type, handler) or trigger auto-ack/lastEventId", async () => {
      const server = track(await startServerWithActions('client-action-secret-3'));
      const client = makeClient(server.port);

      client.connect();
      await nextState(client, 'open');

      const notificationReceived = new Promise<{ id: string; token: string }>((resolve) => {
        const off = client.onAny((envelope) => {
          if (envelope.type === 'notification') {
            off();
            const data = envelope.data as { actions: { id: string; token: string }[] };
            resolve({ id: envelope.id, token: data.actions[0].token });
          }
        });
      });

      await server.netifly.notify('alice', {
        kind: 'action',
        title: 'Approve?',
        body: 'x',
        actions: [{ id: 'approve', label: 'Approve' }],
        expiresAt: Date.now() + 60_000,
      });
      const { id, token } = await notificationReceived;
      const lastEventIdBeforeAck = client.lastEventId;

      const stray: unknown[] = [];
      // Cast to bypass the typed `on<K extends keyof Events>` constraint —
      // 'netifly.actionAck' is deliberately not a member of the test's
      // `Events` map (it's a protocol frame, not an app event), so this
      // needs an escape hatch purely to prove no app handler ever receives it.
      (client.on as (type: string, handler: (data: unknown) => void) => () => void)(
        'netifly.actionAck',
        (data) => stray.push(data)
      );

      const ackPromise = new Promise<ActionAckInfo>((resolve) => {
        const off = client.onActionAck((info) => {
          off();
          resolve(info);
        });
      });
      client.respondToAction(id, 'approve', token);
      await ackPromise;

      expect(stray).toEqual([]);
      expect(client.lastEventId).toBe(lastEventIdBeforeAck);
    });
  });
```

Also add `ActionAckInfo` and `ResolvedInfo` to the existing top-of-file `import type { ConnectionState, Envelope } from './types';` line:

```ts
import type { ActionAckInfo, ConnectionState, Envelope, ResolvedInfo } from './types';
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd packages/client && REDIS_URL=redis://127.0.0.1:6379 npx jest client.test.ts -t "actionable notifications"`
Expected: FAIL — `client.respondToAction is not a function` / `client.onActionAck is not a function` / `client.onResolved is not a function`.

- [ ] **Step 3: Implement the client additions**

In `packages/client/src/client.ts`, add to the imports:

```ts
import type {
  ActionAckInfo,
  CloseInfo,
  ConnectionState,
  Envelope,
  EventMap,
  NetiflyClientOptions,
  ResolvedInfo,
  TokenMode,
} from './types';
```

Add two new handler sets right after the existing `private readonly errorHandlers = new Set<(error: Error) => void>();`:

```ts
  private readonly actionAckHandlers = new Set<(info: ActionAckInfo) => void>();
  private readonly resolvedHandlers = new Set<(info: ResolvedInfo) => void>();
```

Change the `sendFrame` method's parameter type from:

```ts
  private sendFrame(
    frame: { type: 'ack' | 'read'; id: string } | { type: 'response'; id: string; payload: unknown }
  ): void {
```

to:

```ts
  private sendFrame(
    frame:
      | { type: 'ack' | 'read'; id: string }
      | { type: 'response'; id: string; payload: unknown }
      | { type: 'action'; id: string; action: string; token: string; input?: unknown }
  ): void {
```

Add a new public method right after the existing `respond()` method:

```ts
  /** Sends { type: 'action', id, action, token, input }. No-op if not connected. */
  respondToAction(id: string, action: string, token: string, input?: unknown): void {
    this.sendFrame({ type: 'action', id, action, token, input });
  }
```

Add two new subscription methods right after the existing `onError()` method:

```ts
  /** Subscribes to the server's ack of a respondToAction() call: accepted, already_answered, expired, or invalid. */
  onActionAck(handler: (info: ActionAckInfo) => void): Unsubscribe {
    return this.subscribe(this.actionAckHandlers, handler);
  }

  /** Subscribes to netifly.notification.resolved — fires on every one of a user's connections (including the one that answered) when an actionable notification is answered. */
  onResolved(handler: (info: ResolvedInfo) => void): Unsubscribe {
    return this.subscribe(this.resolvedHandlers, handler);
  }
```

Finally, in `handleMessage`, add the two new meta-frame branches right after the existing shape guard and before the `lastEventId`/dispatch logic. Change:

```ts
    if (envelope === null || typeof envelope !== 'object' || typeof envelope.type !== 'string') {
      return;
    }
    if (typeof envelope.id === 'string' && !envelope.type.startsWith('netifly.')) {
      this.currentEventId = envelope.id;
    }
```

to:

```ts
    if (envelope === null || typeof envelope !== 'object' || typeof envelope.type !== 'string') {
      return;
    }

    if (envelope.type === 'netifly.actionAck') {
      const info = envelope.data as ActionAckInfo;
      for (const handler of [...this.actionAckHandlers]) {
        this.safely(() => handler(info));
      }
      return;
    }
    if (envelope.type === 'netifly.notification.resolved') {
      const info = envelope.data as ResolvedInfo;
      for (const handler of [...this.resolvedHandlers]) {
        this.safely(() => handler(info));
      }
      return;
    }

    if (typeof envelope.id === 'string' && !envelope.type.startsWith('netifly.')) {
      this.currentEventId = envelope.id;
    }
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd packages/client && REDIS_URL=redis://127.0.0.1:6379 npx jest client.test.ts`
Expected: PASS — every new test and every pre-existing test in the file.

- [ ] **Step 5: Typecheck and commit**

Run: `cd packages/client && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

```bash
git add packages/client/src/types.ts packages/client/src/client.ts packages/client/src/client.test.ts
git commit -m "feat(client): add respondToAction()/onActionAck()/onResolved() (NOT-38)"
```

---

### Task 9: Package exports, JSON Schema, and type tests

**Files:**
- Modify: `packages/core/src/notificationSchema.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test-d/netifly.test-d.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: `notificationJsonSchema` widened to cover both kinds, and every new type/function re-exported from `@netiflyjs/core`.

- [ ] **Step 1: Widen the JSON Schema**

Replace the full contents of `packages/core/src/notificationSchema.ts` (widens NOT-37's single-object schema into a `oneOf` covering both kinds):

```ts
/**
 * A hand-written JSON Schema (draft-07) mirroring `Notification` in
 * types.ts and the runtime checks in notification.ts — kept in sync by
 * hand, since the shape is small and stable. Exported as a plain object
 * (rather than a .json file) so it ships through the normal `tsc` build
 * into `dist/`, matching how every other export in this package is built.
 */
export const notificationJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'NetiflyNotification',
  oneOf: [
    {
      title: 'InfoNotification',
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'info' },
        title: { type: 'string', minLength: 1, maxLength: 120 },
        body: { type: 'string', minLength: 1, maxLength: 500 },
        severity: { type: 'string', enum: ['info', 'success', 'warning', 'error'] },
        link: {
          type: 'object',
          additionalProperties: false,
          properties: {
            href: { type: 'string', minLength: 1 },
            label: { type: 'string', minLength: 1, maxLength: 80 },
          },
          required: ['href', 'label'],
        },
        icon: { type: 'string' },
        expiresAt: { type: 'number' },
        meta: { type: 'object' },
      },
      required: ['kind', 'title', 'body'],
    },
    {
      title: 'ActionNotification',
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'action' },
        title: { type: 'string', minLength: 1, maxLength: 120 },
        body: { type: 'string', minLength: 1, maxLength: 500 },
        actions: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1 },
              label: { type: 'string', minLength: 1 },
              style: { type: 'string', enum: ['primary', 'danger', 'default'] },
              input: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  type: { const: 'text' },
                  placeholder: { type: 'string' },
                },
                required: ['type'],
              },
            },
            required: ['id', 'label'],
          },
        },
        expiresAt: { type: 'number' },
        context: { type: 'object' },
        meta: { type: 'object' },
      },
      required: ['kind', 'title', 'body', 'actions', 'expiresAt'],
    },
  ],
} as const;
```

- [ ] **Step 2: Export the new types and functions from `index.ts`**

In `packages/core/src/index.ts`, add right after the existing `export { NotificationValidationError, validateNotification } from './notification';` line:

```ts
export { resolveActionSecret } from './actionSecret';
export { signActionToken, verifyActionToken, buildActionWireNotification } from './actionToken';
```

Add these type names to the existing `export type { ... } from './types';` block, alphabetically:

```ts
  ActionInfo,
  ActionNotification,
  NotificationAction,
```

Add these two type names from `./actionToken`, as a new export line right after the `signActionToken`/`verifyActionToken` line:

```ts
export type { ActionTokenPayload, VerifyActionTokenResult } from './actionToken';
```

- [ ] **Step 3: Add tsd type tests**

Change the existing top-of-file import block in `packages/core/test-d/netifly.test-d.ts` from:

```ts
import {
  createNetifly,
  createNetiflyPublisher,
  type Notification,
  type SendResult,
} from '../src/index';
```

to:

```ts
import {
  createNetifly,
  createNetiflyPublisher,
  type ActionInfo,
  type Notification,
  type SendResult,
} from '../src/index';
```

Then append this block to the end of the file:

```ts

// --- notify(kind:'action') and on('action'): NOT-38 ---

const actionNotification = createNetifly<Events>({
  server,
  resolveUserId: async () => userId,
  redisUrl: 'redis://127.0.0.1:6379',
  actionSecret: 'test-secret',
});

expectType<Promise<SendResult>>(
  actionNotification.notify(userId, {
    kind: 'action',
    title: 'Approve?',
    body: 'x',
    actions: [{ id: 'approve', label: 'Approve' }],
    expiresAt: Date.now() + 60_000,
  })
);

actionNotification.on('action', (info) => {
  expectType<ActionInfo>(info);
});

// actionSecret: false is a valid construction-time opt-out — this must
// simply compile without a type error, no return-type assertion needed.
createNetifly<Events>({
  server,
  resolveUserId: async () => userId,
  redisUrl: 'redis://127.0.0.1:6379',
  actionSecret: false,
});
```

- [ ] **Step 4: Run typecheck, tsd, and the full test suite**

Run: `cd packages/core && npx tsc -p tsconfig.json --noEmit && npx tsd`
Expected: no errors from either.

Run: `cd packages/core && REDIS_URL=redis://127.0.0.1:6379 npx jest`
Expected: PASS — full suite.

Run: `cd packages/client && REDIS_URL=redis://127.0.0.1:6379 npx jest` and `cd packages/express && REDIS_URL=redis://127.0.0.1:6379 npx jest`
Expected: PASS — full suites.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/notificationSchema.ts packages/core/src/index.ts packages/core/test-d/netifly.test-d.ts
git commit -m "feat(core): export actionable notification types, widen JSON schema, add type tests (NOT-38)"
```

---

### Task 10: Documentation

**Files:**
- Modify: `README.md`
- Modify: `packages/core/README.md`

**Interfaces:**
- Consumes: the finished public API from Tasks 1–9. No code interfaces produced — this is the final task.

- [ ] **Step 1: Add the "Actionable notifications" guide to the root README**

In `README.md`, insert a new subsection immediately after the "Events vs. notifications" section NOT-37's plan added (right before the `## 📱 Client SDK — \`@netiflyjs/client\`` heading):

```markdown
### Actionable notifications

`notify()` with `kind: 'action'` adds CTA buttons a user can answer directly — Approve/Reject/Snooze-style — with the answer cryptographically verified server-side before your app ever sees it:

```ts
await netifly.notify(userId, {
  kind: 'action',
  title: 'Approve expense £420?',
  body: 'Submitted by Sam for Client dinner',
  actions: [
    { id: 'approve', label: 'Approve', style: 'primary' },
    { id: 'reject', label: 'Reject', style: 'danger' },
  ],
  expiresAt: Date.now() + 24 * 3600_000,
  context: { expenseId: 'exp_123' }, // stays server-side; signed into each action's token, never sent as a plain field
});

netifly.on('action', ({ userId, notificationId, actionId, context }) => {
  db.expenses.update(context.expenseId, { status: actionId }); // 'approve' | 'reject'
});
```

Requires an `actionSecret` (or `NETIFLY_SECRET` env var) — `createNetifly()`/`createNetiflyPublisher()` **throw at construction** unless one is configured, or you pass `{ actionSecret: false }` to explicitly disable `kind: 'action'` notifications for that server. This is deliberate: an actionable notification's security depends entirely on the signing secret, so a missing one fails loudly at startup rather than silently accepting unsigned/unverifiable actions.

On the client, render each `action.token` from the notification payload and echo it back when the user responds:

```ts
client.respondToAction(notificationId, 'approve', token);

client.onActionAck(({ status }) => {
  // 'accepted' | 'already_answered' | 'expired' | 'invalid'
});

client.onResolved(({ id, action }) => {
  // fires on every one of the user's connections (including the one that
  // answered) — use it to update the card everywhere, e.g. disable the buttons
});
```

**How it's secure**: each action's token is `base64url({ notificationId, userId, actionId, expiresAt, context }) + '.' + HMAC-SHA256(secret, ...)` — signed, not encrypted, so the server never has to look anything up to recover `context`; it's stateless across instances. On answer, the server verifies the signature (timing-safe), that the token's `userId` matches the answering socket's authenticated user, that it hasn't expired, and — via a Redis `SET NX EX` lock — that nobody has answered this notification's action already. A tampered token, wrong user, expired token, or a second answer to an already-answered notification all come back as a specific `netifly.actionAck` status rather than silently failing.
```

- [ ] **Step 2: Add `on('action', ...)` and `actionSecret` to the `createNetifly<Events>(options)` API Reference entry**

In `README.md`, inside the `### \`createNetifly<Events>(options)\` — \`@netiflyjs/core\`` section's options table, insert a new row immediately after the `validate` row:

```markdown
| `actionSecret` | `string \| false` | — | HMAC secret for signing `kind: 'action'` notification tokens (see [Actionable notifications](#actionable-notifications)). Falls back to `process.env.NETIFLY_SECRET`. **Throws at construction** unless a secret is resolved or this is explicitly `false` (disables `kind: 'action'` for this server). |
```

In the same section's bullet list, insert a new bullet immediately after the `notify`/`notifyOr` bullet NOT-37's plan added:

```markdown
- `on('action', ({ userId, notificationId, actionId, input, context }) => void)` — fires exactly once per answered `kind: 'action'` notification, on whichever instance the client's `respondToAction()` frame physically arrived at (never once per subscribed instance — same exactly-once model as `'delivered'`/`'read'`/`'response'`). `context` is whatever `notify()` was called with, recovered from the signed token — never trusted from the client. Also relayed to the user's other open connections as `netifly.notification.resolved`, and the answering socket alone gets a `netifly.actionAck` with `status: 'accepted' | 'already_answered' | 'expired' | 'invalid'`.
```

- [ ] **Step 3: Add `actionSecret` to the `createNetiflyPublisher<Events>(options)` API Reference entry**

In `README.md`, inside the `### \`createNetiflyPublisher<Events>(options)\` — \`@netiflyjs/core\`` section's options table, insert a new row immediately after the `validate` row:

```markdown
| `actionSecret` | `string \| false` | — | Same resolution/throw behavior as `createNetifly`'s `actionSecret` — must match the secret used by the `createNetifly()` server(s) this publisher should reach, since only a connected server (never a publisher) can verify an answer. |
```

- [ ] **Step 4: Add `createNetiflyClient` bullets for the new client methods**

In `README.md`, inside the `### \`createNetiflyClient<Events>(options)\` — \`@netiflyjs/client\`` section, insert new bullets immediately after the existing `respond(id, payload)` bullet (added by the NOT-30 doc pass):

```markdown
- `respondToAction(id, action, token, input?): void` — sends `{ type: 'action', id, action, token, input }`. `token` is the specific action's signed token from the notification payload (see [Actionable notifications](#actionable-notifications)). No-op if not connected.
- `onActionAck((info) => void): Unsubscribe` — the server's direct reply to `respondToAction()`: `{ id, action, status }` where `status` is `'accepted' | 'already_answered' | 'expired' | 'invalid'`.
- `onResolved((info) => void): Unsubscribe` — `netifly.notification.resolved`: `{ id, action }`, fires on every one of the user's connections (including the one that answered) when an actionable notification is answered.
```

- [ ] **Step 5: Add a condensed mention to `packages/core/README.md`**

In `packages/core/README.md`, inside the `### \`createNetifly(options)\` — \`@netiflyjs/core\`` section's bullet list, insert a new bullet immediately after the `notify(userId, notification)` bullet NOT-37's plan added:

```markdown
- `on('action', ({ userId, notificationId, actionId, input, context }) => void)` — fires when a client answers a `kind: 'action'` notification via a cryptographically verified, signed token. Requires `actionSecret` (or `NETIFLY_SECRET`) — `createNetifly()` throws at construction unless one is set or `actionSecret: false` is passed. See the [full README](https://github.com/NetiflyJS/netifly#actionable-notifications) for the "Actionable notifications" guide.
```

- [ ] **Step 6: Commit**

```bash
git add README.md packages/core/README.md
git commit -m "docs: document actionable notifications (NOT-38)"
```
