# notify() — One-Way Notifications (NOT-37) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opinionated `notify()`/`notifyOr()` API to `@netiflyjs/core` — a standard, validated `kind: 'info'` notification schema built on top of the existing `send()`/`sendOr()` envelope machinery.

**Architecture:** A new `packages/core/src/notification.ts` module owns the notification types' runtime validation (`validateNotification`, `NotificationValidationError`) as a pure function with no I/O. `NetiflyServerImpl`/`NetiflyPublisherImpl` each get a thin `notify()`/`notifyOr()` that validates, then publishes through a small `publishEnvelope()` helper factored out of their existing `send()` path — deliberately bypassing the app's own `Events`-typed `validate` hook, since `'notification'` isn't a member of that map. `notify()` reuses `send()`'s envelope building, `'sent'` event, delivery counting, and `sendOr`-style offline fallback unchanged.

**Tech Stack:** TypeScript, Jest (`packages/core/src/*.test.ts`, real WebSocket + Redis integration tests), tsd (`packages/core/test-d/`).

**Spec:** [docs/superpowers/specs/2026-09-29-notify-actionable-notifications-design.md](../specs/2026-09-29-notify-actionable-notifications-design.md) (§4, §5 — this plan implements the `kind: 'info'` half only; §6–§9's `kind: 'action'` half is a separate, later plan/branch per the spec's §1 scoping decision)

## Global Constraints

- `MAX_TITLE_LENGTH = 120`, `MAX_BODY_LENGTH = 500`, `MAX_LINK_LABEL_LENGTH = 80` (spec §5).
- `link.href` must be a relative path starting with `/`, or an absolute URL with scheme `http:`/`https:` — every other scheme (`javascript:`, `data:`, `vbscript:`, unparseable strings) is rejected (spec §5).
- `notify()`'s wire envelope `type` is the unprefixed string `'notification'` — never `netifly.notification` — so it stays inside the client's normal auto-ack/`lastEventId` path; the `netifly.` prefix stays reserved for protocol relay frames only (spec §4).
- `notify()`/`notifyOr()` must **not** invoke the app's own `validate` option — that hook is typed against the app's `Events` map, and `'notification'` is not a member of it (spec §4, and see Review Focus below).
- `notify()`/`notifyOr()` return the same `SendResult` shape (`{ delivered: boolean; instances: number }`) as `send()`/`sendOr()`, and both are available on `NetiflyPublisher` too (only `notify()`, no `notifyOr()` there — `NetiflyPublisher` has no `sendOr()` either, spec §4).
- A validation failure throws `NotificationValidationError` synchronously, before anything is built or published — nothing reaches Redis (spec §5).
- Non-breaking, additive change — no existing exported type, method signature, or wire shape changes (spec §10).

## Review Focus

- A whitespace-only `title`/`body` (e.g. `"   "`) must be rejected as empty — checked via `.trim().length === 0` — while the max-length check still counts the untrimmed string, so padding can't be used to smuggle a longer message past the cap. Covered in Task 1.
- A non-TypeScript caller can pass a `link` whose `href`/`label` aren't actually strings (e.g. `{ link: { href: 123 } }`) — validation must produce a clean `NotificationValidationError`, not an unhandled `TypeError` from calling `.startsWith()` on a non-string. Covered in Task 1.
- A non-TypeScript (or simply wrong) caller can pass no `kind` at all, or `kind: 'action'` — this plan's `notify()` only supports `kind: 'info'`, and must reject anything else with a clear message rather than silently accepting or crashing downstream. Covered in Task 1.
- `notify()`/`notifyOr()` called after `close()` must throw the same `"Netifly: cannot send after close()"` error `send()` already does, not silently publish or throw something unrelated. Covered in Task 2.
- An app that configured `createNetifly({ validate })` for its own `Events` map must never see that hook invoked for a `notify()` call — a strict validator (e.g. one that throws on an unrecognized `type`) would otherwise incorrectly reject a perfectly valid notification. Covered in Task 2 and Task 3.

---

### Task 1: Notification schema & validation

**Files:**
- Modify: `packages/core/src/types.ts` (add notification types near the existing `SendResult`/`SendOrOptions` block, e.g. after line 187)
- Create: `packages/core/src/notification.ts`
- Create: `packages/core/src/notification.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `InfoNotification`, `NotificationLink`, `NotificationSeverity`, `Notification` (= `InfoNotification` for now), `WireNotification` (= `Notification` for now) types from `./types`; `NotificationValidationError` class and `validateNotification(notification: Notification): void` from `./notification` — both consumed by Task 2 and Task 3.

- [ ] **Step 1: Add the notification types and write the failing validation test**

Add to `packages/core/src/types.ts`, directly after the closing brace of `SendOrOptions` (after the existing line `export interface SendOrOptions { ... }`, before `export interface NetiflyInstance<Events...`):

```ts
export interface NotificationLink {
  href: string;
  label: string;
}

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';

export interface InfoNotification {
  kind: 'info';
  title: string;
  body: string;
  severity?: NotificationSeverity;
  link?: NotificationLink;
  icon?: string;
  expiresAt?: number;
  meta?: Record<string, unknown>;
}

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

Create `packages/core/src/notification.test.ts`:

```ts
import { NotificationValidationError, validateNotification } from './notification';
import type { InfoNotification } from './types';

function baseNotification(overrides: Partial<InfoNotification> = {}): InfoNotification {
  return { kind: 'info', title: 'Export ready', body: 'Your report is ready.', ...overrides };
}

describe('validateNotification', () => {
  it('accepts a minimal valid notification', () => {
    expect(() => validateNotification(baseNotification())).not.toThrow();
  });

  it('rejects a missing kind', () => {
    const { kind: _kind, ...rest } = baseNotification();
    expect(() => validateNotification(rest as unknown as InfoNotification)).toThrow(
      NotificationValidationError
    );
  });

  it("rejects kind: 'action' (not supported by this version of notify())", () => {
    expect(() =>
      validateNotification({ ...baseNotification(), kind: 'action' } as unknown as InfoNotification)
    ).toThrow(NotificationValidationError);
  });

  it('rejects an empty title', () => {
    expect(() => validateNotification(baseNotification({ title: '' }))).toThrow(
      NotificationValidationError
    );
  });

  it('rejects a whitespace-only title', () => {
    expect(() => validateNotification(baseNotification({ title: '   ' }))).toThrow(
      NotificationValidationError
    );
  });

  it('rejects a title over 120 characters', () => {
    expect(() => validateNotification(baseNotification({ title: 'x'.repeat(121) }))).toThrow(
      NotificationValidationError
    );
  });

  it('accepts a title at exactly 120 characters', () => {
    expect(() => validateNotification(baseNotification({ title: 'x'.repeat(120) }))).not.toThrow();
  });

  it('rejects an empty body', () => {
    expect(() => validateNotification(baseNotification({ body: '' }))).toThrow(
      NotificationValidationError
    );
  });

  it('rejects a body over 500 characters', () => {
    expect(() => validateNotification(baseNotification({ body: 'x'.repeat(501) }))).toThrow(
      NotificationValidationError
    );
  });

  it('rejects an invalid severity', () => {
    expect(() =>
      validateNotification(
        baseNotification({ severity: 'critical' as InfoNotification['severity'] })
      )
    ).toThrow(NotificationValidationError);
  });

  it.each(['info', 'success', 'warning', 'error'] as const)('accepts severity %s', (severity) => {
    expect(() => validateNotification(baseNotification({ severity }))).not.toThrow();
  });

  it('accepts a relative link href', () => {
    expect(() =>
      validateNotification(baseNotification({ link: { href: '/reports/123', label: 'Open' } }))
    ).not.toThrow();
  });

  it('accepts an https link href', () => {
    expect(() =>
      validateNotification(
        baseNotification({ link: { href: 'https://example.com/x', label: 'Open' } })
      )
    ).not.toThrow();
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', 'vbscript:msgbox(1)', 'not a url'])(
    'rejects an unsafe link href: %s',
    (href) => {
      expect(() =>
        validateNotification(baseNotification({ link: { href, label: 'Open' } }))
      ).toThrow(NotificationValidationError);
    }
  );

  it('rejects a link.href that is not a string (non-TS caller)', () => {
    expect(() =>
      validateNotification(
        baseNotification({ link: { href: 123, label: 'Open' } as unknown as InfoNotification['link'] })
      )
    ).toThrow(NotificationValidationError);
  });

  it('rejects a link with a missing label', () => {
    expect(() => validateNotification(baseNotification({ link: { href: '/x', label: '' } }))).toThrow(
      NotificationValidationError
    );
  });

  it('rejects a link.label that is not a string (non-TS caller)', () => {
    expect(() =>
      validateNotification(
        baseNotification({ link: { href: '/x', label: 42 } as unknown as InfoNotification['link'] })
      )
    ).toThrow(NotificationValidationError);
  });

  it('rejects a link label over 80 characters', () => {
    expect(() =>
      validateNotification(baseNotification({ link: { href: '/x', label: 'x'.repeat(81) } }))
    ).toThrow(NotificationValidationError);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd packages/core && npx jest notification.test.ts`
Expected: FAIL — `Cannot find module './notification'`.

- [ ] **Step 3: Implement `notification.ts`**

Create `packages/core/src/notification.ts`:

```ts
import type { Notification } from './types';

/** Thrown by `validateNotification()` — exported so apps can `instanceof`-check it apart from other errors a `notify()` call might reject with. */
export class NotificationValidationError extends Error {}

const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 500;
const MAX_LINK_LABEL_LENGTH = 80;
const SEVERITIES = new Set(['info', 'success', 'warning', 'error']);

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

/**
 * Validates a `notify()`/`notifyOr()` argument before anything is built or
 * published. Every check reads fields via an `unknown`-typed cast rather
 * than trusting the declared `Notification` type, since this also has to
 * defend plain-JS callers who bypass TypeScript entirely (see the plan's
 * Review Focus). Throws `NotificationValidationError` on the first failure.
 */
export function validateNotification(notification: Notification): void {
  const kind = (notification as { kind?: unknown }).kind;
  if (kind !== 'info') {
    throw new NotificationValidationError(
      `Netifly: notify() requires kind: 'info' in this version, got ${JSON.stringify(kind)}`
    );
  }

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

  const severity = notification.severity;
  if (severity !== undefined && !SEVERITIES.has(severity)) {
    throw new NotificationValidationError(
      `Netifly: notify() severity must be one of 'info' | 'success' | 'warning' | 'error', got ${JSON.stringify(severity)}`
    );
  }

  if (notification.link !== undefined) {
    const href = (notification.link as { href?: unknown }).href;
    const label = (notification.link as { label?: unknown }).label;

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
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `cd packages/core && npx jest notification.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 5: Typecheck and commit**

Run: `cd packages/core && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

```bash
git add packages/core/src/types.ts packages/core/src/notification.ts packages/core/src/notification.test.ts
git commit -m "feat(core): add notify() notification schema and validation (NOT-37)"
```

---

### Task 2: Server-side `notify()`/`notifyOr()`

**Files:**
- Modify: `packages/core/src/types.ts` (add `notify`/`notifyOr` to `NetiflyInstance`, after the existing `sendOr` overloads around line 196-202)
- Modify: `packages/core/src/netiflyServer.ts` (factor out `publishEnvelope()`, add `notify()`/`notifyOr()`)
- Modify: `packages/core/src/netiflyServer.test.ts` (new `describe('notify()', ...)` block, inserted immediately before the file's final closing `});`)

**Interfaces:**
- Consumes: `Notification` type, `validateNotification`, `NotificationValidationError` from Task 1.
- Produces: `NetiflyInstance.notify(userId, notification): Promise<SendResult>` and `.notifyOr(userId, notification, options): Promise<SendResult>`, consumed by no later task in this plan (this is the last core-server task) but is the pattern Task 3 mirrors for `NetiflyPublisher`.

- [ ] **Step 1: Add the type signatures and write the failing tests**

In `packages/core/src/types.ts`, inside `export interface NetiflyInstance<Events extends EventMap = EventMap> { ... }`, add right after the existing `sendOr<K extends keyof Events & string>(...)` overload block (before `disconnect(userId: UserId): void;`):

```ts
  notify(userId: UserId, notification: Notification): Promise<SendResult>;
  /**
   * Like `notify()`, but calls (and awaits) `options.offline()` when the
   * notification wasn't delivered to any connection anywhere in the
   * cluster. Resolves with the same `SendResult` either way.
   */
  notifyOr(userId: UserId, notification: Notification, options: SendOrOptions): Promise<SendResult>;
```

In `packages/core/src/netiflyServer.test.ts`, add this `import`/helper alongside the existing top-of-file imports (right after the existing `import { TokenBucket } from './rateLimiter';`-style relative imports — add a new named import line):

```ts
import { NotificationValidationError } from './notification';
```

Then, immediately before the file's final `});` (the closing brace of the outer `describe('createNetifly', ...)` block, currently the very last line of the file), insert:

```ts
  describe('notify()', () => {
    it('publishes a valid info notification and resolves with SendResult', async () => {
      const server = await startTestServer(() => 'netiflyServer-notify-user');
      servers.push(server);
      const ws = await connectClient(server.port);
      clients.push(ws);
      await onceEvent(server.netifly, 'connect');

      const notificationPromise = nextMatchingMessage(ws, (e) => e.type === 'notification');
      const result = await server.netifly.notify('netiflyServer-notify-user', {
        kind: 'info',
        title: 'Export ready',
        body: 'Your report has finished generating.',
      });

      expect(result).toEqual({ delivered: true, instances: 1 });
      const envelope = await notificationPromise;
      expect(envelope.data).toEqual({
        kind: 'info',
        title: 'Export ready',
        body: 'Your report has finished generating.',
      });
    });

    it('rejects an invalid notification without publishing anything', async () => {
      const server = await startTestServer(() => 'netiflyServer-notify-invalid');
      servers.push(server);
      const ws = await connectClient(server.port);
      clients.push(ws);
      await onceEvent(server.netifly, 'connect');

      const messages: unknown[] = [];
      ws.on('message', (data) => messages.push(JSON.parse(data.toString())));

      await expect(
        server.netifly.notify('netiflyServer-notify-invalid', { kind: 'info', title: '', body: 'x' })
      ).rejects.toThrow(NotificationValidationError);

      await wait(50);
      expect(messages).toHaveLength(0);
    });

    it('does not run the app-level validate hook for notify()', async () => {
      const validate = jest.fn();
      const server = await startTestServer(() => 'netiflyServer-notify-no-app-validate', { validate });
      servers.push(server);
      const ws = await connectClient(server.port);
      clients.push(ws);
      await onceEvent(server.netifly, 'connect');

      await server.netifly.notify('netiflyServer-notify-no-app-validate', {
        kind: 'info',
        title: 'Export ready',
        body: 'Done.',
      });
      expect(validate).not.toHaveBeenCalled();
    });

    it('notifyOr() calls offline() when nobody is connected', async () => {
      const server = await startTestServer(() => 'netiflyServer-notify-anyone');
      servers.push(server);

      const offline = jest.fn();
      const result = await server.netifly.notifyOr(
        'netiflyServer-notify-nobody-home',
        { kind: 'info', title: 'Export ready', body: 'Done.' },
        { offline }
      );

      expect(result.delivered).toBe(false);
      expect(offline).toHaveBeenCalledTimes(1);
    });

    it('throws after close(), same as send()', async () => {
      const server = await startTestServer(() => 'netiflyServer-notify-after-close');
      await server.close();

      await expect(
        server.netifly.notify('netiflyServer-notify-after-close', {
          kind: 'info',
          title: 'Export ready',
          body: 'Done.',
        })
      ).rejects.toThrow('Netifly: cannot send after close()');
    });
  });
});
```

(Note the trailing `});` above is the pre-existing final closing brace of the outer `describe` — the new block is inserted just before it, not appended after it.)

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd packages/core && REDIS_URL=redis://127.0.0.1:6379 npx jest netiflyServer.test.ts -t "notify"`
Expected: FAIL — `server.netifly.notify is not a function`.

- [ ] **Step 3: Factor out `publishEnvelope()` and implement `notify()`/`notifyOr()`**

**Note on the codebase state this step targets:** `netiflyServer.ts` currently publishes via `this.transport` (a `NetiflyTransport`, from the NOT-20 transport-abstraction refactor) and a `serializeEnvelope()` helper, not the older direct-Redis `this.router` shape — the snippets below match the actual current file.

In `packages/core/src/netiflyServer.ts`, replace the existing `sendInternal` method:

```ts
  private async sendInternal<T>(userId: UserId, rest: [T] | [string, T]): Promise<SendResult> {
    if (this.closed) {
      throw new Error('Netifly: cannot send after close()');
    }
    const type = rest.length === 2 ? rest[0] : 'message';
    const data = rest.length === 2 ? rest[1] : rest[0];
    // Cast needed at the call site: `validate`'s declared type ties `K` to
    // `Events` for type-checking at the *options* call site (see types.ts),
    // but here `type` is just a resolved `string` and `Events` is this
    // class's own unresolved generic parameter, so TS can't verify the pair
    // matches a specific `K` — the check already happened when the caller
    // built `options.validate` (or, for typed `send()` calls, when the
    // caller invoked `send()` itself). At runtime this is exactly the actual
    // `(type, data)` pair being sent.
    (this.validate as ((type: string, data: unknown) => void) | undefined)?.(type, data);
    const envelope = this.buildEnvelope(type, data);
    this.emit('sent', {
      userId,
      id: envelope.id,
      type: envelope.type,
      data: envelope.data,
    } satisfies SentInfo);
    const message = this.serializeEnvelope(userId, envelope);
    const { receivers } = await this.transport.publish(userId, message);
    return { delivered: receivers > 0, instances: receivers };
  }
```

with this pair (same behavior for `send()`/`sendOr()`, but the publish/emit half is now reusable):

```ts
  private async sendInternal<T>(userId: UserId, rest: [T] | [string, T]): Promise<SendResult> {
    if (this.closed) {
      throw new Error('Netifly: cannot send after close()');
    }
    const type = rest.length === 2 ? rest[0] : 'message';
    const data = rest.length === 2 ? rest[1] : rest[0];
    // Cast needed at the call site: `validate`'s declared type ties `K` to
    // `Events` for type-checking at the *options* call site (see types.ts),
    // but here `type` is just a resolved `string` and `Events` is this
    // class's own unresolved generic parameter, so TS can't verify the pair
    // matches a specific `K` — the check already happened when the caller
    // built `options.validate` (or, for typed `send()` calls, when the
    // caller invoked `send()` itself). At runtime this is exactly the actual
    // `(type, data)` pair being sent.
    (this.validate as ((type: string, data: unknown) => void) | undefined)?.(type, data);
    return this.publishEnvelope(userId, type, data);
  }

  // Shared by sendInternal() and notify(): builds the envelope, fires
  // 'sent', serializes it, and publishes via the transport. Deliberately
  // does NOT run `this.validate` — notify() calls this directly, after its
  // own validateNotification(), and must never run the app's Events-typed
  // validate hook for a 'notification' type that was never a member of
  // that map (see NOT-37 spec §4).
  private async publishEnvelope<T>(userId: UserId, type: string, data: T): Promise<SendResult> {
    const envelope = this.buildEnvelope(type, data);
    this.emit('sent', {
      userId,
      id: envelope.id,
      type: envelope.type,
      data: envelope.data,
    } satisfies SentInfo);
    const message = this.serializeEnvelope(userId, envelope);
    const { receivers } = await this.transport.publish(userId, message);
    return { delivered: receivers > 0, instances: receivers };
  }
```

(`buildEnvelope` and `serializeEnvelope` themselves are unchanged by this step — only `sendInternal` is split and `publishEnvelope` is new.)

Then add `notify()`/`notifyOr()` right after the existing `sendOr()` method (before `private async sendInternal`):

```ts
  async notify(userId: UserId, notification: Notification): Promise<SendResult> {
    if (this.closed) {
      throw new Error('Netifly: cannot send after close()');
    }
    validateNotification(notification);
    return this.publishEnvelope(userId, 'notification', notification);
  }

  async notifyOr(
    userId: UserId,
    notification: Notification,
    options: SendOrOptions
  ): Promise<SendResult> {
    const result = await this.notify(userId, notification);
    if (!result.delivered) {
      await options.offline();
    }
    return result;
  }
```

Add the new imports at the top of `packages/core/src/netiflyServer.ts`, alongside the existing `import { TokenBucket } from './rateLimiter';`:

```ts
import { validateNotification } from './notification';
```

And add `Notification` to the existing `import type { ... } from './types';` block. The current block (post-NOT-20) is:

```ts
import type {
  AckInfo,
  AllowedOrigins,
  CloseOptions,
  CreateNetiflyOptions,
  Envelope,
  EventMap,
  MalformedFrameInfo,
  NetiflyInstance,
  NetiflyTransport,
  RejectInfo,
  ResponseInfo,
  SendOrOptions,
  SendResult,
  SentInfo,
  UserId,
} from './types';
```

Add `Notification` alphabetically, after `NetiflyTransport` and before `RejectInfo`:

```ts
import type {
  AckInfo,
  AllowedOrigins,
  CloseOptions,
  CreateNetiflyOptions,
  Envelope,
  EventMap,
  MalformedFrameInfo,
  NetiflyInstance,
  NetiflyTransport,
  Notification,
  RejectInfo,
  ResponseInfo,
  SendOrOptions,
  SendResult,
  SentInfo,
  UserId,
} from './types';
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd packages/core && REDIS_URL=redis://127.0.0.1:6379 npx jest netiflyServer.test.ts`
Expected: PASS — the new `notify()` tests and every pre-existing test in the file (the `sendInternal` refactor must not change any existing behavior).

- [ ] **Step 5: Typecheck and commit**

Run: `cd packages/core && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

```bash
git add packages/core/src/types.ts packages/core/src/netiflyServer.ts packages/core/src/netiflyServer.test.ts
git commit -m "feat(core): add NetiflyInstance.notify()/notifyOr() (NOT-37)"
```

---

### Task 3: Publisher-side `notify()`

**Files:**
- Modify: `packages/core/src/types.ts` (add `notify` to `NetiflyPublisher`, after the existing `send<K>(...)` overload around line 276)
- Modify: `packages/core/src/netiflyPublisher.ts` (factor out `publishEnvelope()`, add `notify()`)
- Modify: `packages/core/src/netiflyPublisher.test.ts` (new `describe('notify()', ...)` block, inserted immediately before the file's final closing `});`)

**Interfaces:**
- Consumes: `Notification` type, `validateNotification` from Task 1. Same `publishEnvelope()` extraction pattern as Task 2, applied independently to `NetiflyPublisherImpl` (a separate class with its own Redis client — no shared code between the two beyond the pattern).
- Produces: `NetiflyPublisher.notify(userId, notification): Promise<SendResult>`.

- [ ] **Step 1: Add the type signature and write the failing tests**

In `packages/core/src/types.ts`, inside `export interface NetiflyPublisher<Events extends EventMap = EventMap> { ... }`, add right after the existing `send<K extends keyof Events & string>(...)` overload (before `/** Fires synchronously inside send()...`):

```ts
  notify(userId: UserId, notification: Notification): Promise<SendResult>;
```

In `packages/core/src/netiflyPublisher.test.ts`, add this import alongside the existing top-of-file imports:

```ts
import { NotificationValidationError } from './notification';
```

Then, immediately before the file's final `});` (the closing brace of the outer `describe('createNetiflyPublisher', ...)` block, currently the very last line of the file), insert:

```ts
  describe('notify()', () => {
    it('publishes a valid info notification that a connected server delivers to the client', async () => {
      const server = await startTestServer(() => 'netiflyPublisher-notify-user');
      servers.push(server);
      const ws = await connectClient(server.port);
      clients.push(ws);
      await onceEvent(server.netifly, 'connect');

      const publisher = createNetiflyPublisher({ redisUrl: REDIS_URL });
      publishers.push(publisher);

      const messagePromise = nextMessage(ws);
      const result = await publisher.notify('netiflyPublisher-notify-user', {
        kind: 'info',
        title: 'Export ready',
        body: 'Your report has finished generating.',
      });

      expect(result).toEqual({ delivered: true, instances: 1 });
      const envelope = JSON.parse(await messagePromise);
      expect(envelope.type).toBe('notification');
      expect(envelope.data).toEqual({
        kind: 'info',
        title: 'Export ready',
        body: 'Your report has finished generating.',
      });
    });

    it('rejects an invalid notification without publishing anything', async () => {
      const publisher = createNetiflyPublisher({ redisUrl: REDIS_URL });
      publishers.push(publisher);

      await expect(
        publisher.notify('netiflyPublisher-notify-invalid', { kind: 'info', title: '', body: 'x' })
      ).rejects.toThrow(NotificationValidationError);
    });

    it('does not run the app-level validate hook for notify()', async () => {
      const validate = jest.fn();
      const publisher = createNetiflyPublisher({ redisUrl: REDIS_URL, validate });
      publishers.push(publisher);

      await publisher.notify('netiflyPublisher-notify-no-app-validate', {
        kind: 'info',
        title: 'Export ready',
        body: 'Done.',
      });
      expect(validate).not.toHaveBeenCalled();
    });

    it('throws after close(), same as send()', async () => {
      const publisher = createNetiflyPublisher({ redisUrl: REDIS_URL });
      await publisher.close();

      await expect(
        publisher.notify('netiflyPublisher-notify-after-close', {
          kind: 'info',
          title: 'Export ready',
          body: 'Done.',
        })
      ).rejects.toThrow('Netifly: cannot use publisher after close()');
    });
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd packages/core && REDIS_URL=redis://127.0.0.1:6379 npx jest netiflyPublisher.test.ts -t "notify"`
Expected: FAIL — `publisher.notify is not a function`.

- [ ] **Step 3: Factor out `publishEnvelope()` and implement `notify()`**

In `packages/core/src/netiflyPublisher.ts`, replace the existing `send()` method body's tail — the block from `const envelope = this.buildEnvelope(type, data);` through the end of the method — by first extracting a shared helper. Replace the whole existing `async send<T>(userId: UserId, ...rest: [T] | [string, T]): Promise<SendResult> { ... }` implementation (keep the three overload signature lines above it unchanged) with:

```ts
  async send<T>(userId: UserId, ...rest: [T] | [string, T]): Promise<SendResult> {
    this.assertNotClosed();

    const type = rest.length === 2 ? rest[0] : 'message';
    const data = rest.length === 2 ? rest[1] : rest[0];
    // See the matching comment in netiflyServer.ts's sendInternal for why
    // this cast is needed at the call site.
    (this.validate as ((type: string, data: unknown) => void) | undefined)?.(type, data);
    return this.publishEnvelope(userId, type, data);
  }

  async notify(userId: UserId, notification: Notification): Promise<SendResult> {
    this.assertNotClosed();
    validateNotification(notification);
    return this.publishEnvelope(userId, 'notification', notification);
  }

  // Shared by send() and notify() — deliberately does NOT run `this.validate`;
  // see the matching comment on netiflyServer.ts's publishEnvelope() for why.
  private async publishEnvelope<T>(userId: UserId, type: string, data: T): Promise<SendResult> {
    const envelope = this.buildEnvelope(type, data);
    this.emit('sent', {
      userId,
      id: envelope.id,
      type: envelope.type,
      data: envelope.data,
    } satisfies SentInfo);

    let serialized: string;
    try {
      serialized = JSON.stringify(envelope);
    } catch (error) {
      const message = `Netifly: payload for user "${userId}" is not JSON-serializable`;
      const serializationError = new Error(message);
      (serializationError as Error & { cause?: unknown }).cause = error;
      throw serializationError;
    }

    const instances = await this.redis.publish(this.channelFor(userId), serialized);
    return { delivered: instances > 0, instances };
  }
```

Add the new imports at the top of `packages/core/src/netiflyPublisher.ts`, alongside the existing `import { channelName } from './transports/redisTransport';` (this file's own `channelName` import path moved as part of NOT-20's transport-abstraction refactor — the rest of the file, including `send()`'s body, is otherwise unaffected by that change):

```ts
import { validateNotification } from './notification';
```

And add `Notification` to the existing `import type { ... } from './types';` block (alphabetically, after `NetiflyPublisher`):

```ts
  Notification,
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd packages/core && REDIS_URL=redis://127.0.0.1:6379 npx jest netiflyPublisher.test.ts`
Expected: PASS — the new `notify()` tests and every pre-existing test in the file.

- [ ] **Step 5: Typecheck and commit**

Run: `cd packages/core && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

```bash
git add packages/core/src/types.ts packages/core/src/netiflyPublisher.ts packages/core/src/netiflyPublisher.test.ts
git commit -m "feat(core): add NetiflyPublisher.notify() (NOT-37)"
```

---

### Task 4: Package exports, JSON Schema, and type tests

**Files:**
- Create: `packages/core/src/notificationSchema.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test-d/netifly.test-d.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3 (`Notification`, `InfoNotification`, `NotificationLink`, `NotificationSeverity`, `WireNotification`, `NotificationValidationError`, `NetiflyInstance.notify`/`notifyOr`, `NetiflyPublisher.notify`).
- Produces: `notificationJsonSchema` (exported const), and everything above re-exported from `@netiflyjs/core`'s package root (`./index`) — the public surface apps actually import from.

- [ ] **Step 1: Write `notificationSchema.ts`**

A plain exported TS object rather than a `.json` file: `packages/core/package.json`'s `files` field only ships the `dist/` output, and a `.ts` module compiles into `dist/` automatically via the existing `tsc` build with zero config changes, whereas a raw `.json` file would need its own copy step. This satisfies NOT-37's "+ optional JSON Schema" acceptance criterion as an exported schema object, not a repo-relative file path.

Create `packages/core/src/notificationSchema.ts`:

```ts
/**
 * A hand-written JSON Schema (draft-07) mirroring `InfoNotification` in
 * types.ts and the runtime checks in notification.ts — kept in sync by hand,
 * since the shape is small and stable. Exported as a plain object (rather
 * than a .json file) so it ships through the normal `tsc` build into
 * `dist/`, matching how every other export in this package is built.
 */
export const notificationJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'NetiflyInfoNotification',
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
} as const;
```

- [ ] **Step 2: Export everything from `index.ts`**

In `packages/core/src/index.ts`, add a new export line right after `export { createNetiflyPublisher } from './netiflyPublisher';`:

```ts
export { NotificationValidationError, validateNotification } from './notification';
export { notificationJsonSchema } from './notificationSchema';
```

And add these type names to the existing `export type { ... } from './types';` block, alphabetically:

```ts
  InfoNotification,
  Notification,
  NotificationLink,
  NotificationSeverity,
  WireNotification,
```

- [ ] **Step 3: Add tsd type tests**

First, update the existing top-of-file import block in `packages/core/test-d/netifly.test-d.ts` — change:

```ts
import type http from 'node:http';
import { expectType, expectError } from 'tsd';
import {
  createNetifly,
  createNetiflyPublisher,
  type SendResult,
} from '../src/index';
```

to:

```ts
import type http from 'node:http';
import { expectType, expectError } from 'tsd';
import {
  createNetifly,
  createNetiflyPublisher,
  type Notification,
  type SendResult,
} from '../src/index';
```

Then append this block to the end of the file:

```ts

// --- notify()/notifyOr(): NOT-37 ---

declare const infoNotification: Notification;

expectType<Promise<SendResult>>(netifly.notify(userId, infoNotification));
expectType<Promise<SendResult>>(
  netifly.notifyOr(userId, infoNotification, { offline: () => {} })
);
expectType<Promise<SendResult>>(untypedNetifly.notify(userId, infoNotification));
expectType<Promise<SendResult>>(publisher.notify(userId, infoNotification));
expectType<Promise<SendResult>>(untypedPublisher.notify(userId, infoNotification));
```

- [ ] **Step 4: Run typecheck, tsd, and the full test suite**

Run: `cd packages/core && npx tsc -p tsconfig.json --noEmit && npx tsd`
Expected: no errors from either.

Run: `cd packages/core && REDIS_URL=redis://127.0.0.1:6379 npx jest`
Expected: PASS — full existing suite plus every test from Tasks 1–3.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/notificationSchema.ts packages/core/src/index.ts packages/core/test-d/netifly.test-d.ts
git commit -m "feat(core): export notify() types, JSON schema, and type tests (NOT-37)"
```

---

### Task 5: Documentation

**Files:**
- Modify: `README.md`
- Modify: `packages/core/README.md`

**Interfaces:**
- Consumes: the finished public API from Tasks 1–4. No code interfaces produced — this is the final task.

- [ ] **Step 1: Add the "Events vs. notifications" section to the root README**

In `README.md`, insert a new subsection immediately after the existing `### Typed events` section's last paragraph (the line ending `...Omit \`validate\` entirely and behavior is unchanged from before this option existed.`) and before the `## 📱 Client SDK — \`@netiflyjs/client\`` heading:

```markdown
### Events vs. notifications: when to use `send()` vs `notify()`

`send()`/`sendOr()` move whatever `type`/`data` your app defines — Netifly has no opinion on the shape. `notify()`/`notifyOr()` are a thin, opinionated layer on top of the exact same delivery path (same envelope, same `SendResult`, same `sendOr`-style offline fallback), for the specific, common case of a user-facing notification:

```ts
await netifly.notify(userId, {
  kind: 'info',
  title: 'Export ready',
  body: 'Your March report has finished generating.',
  severity: 'success',
  link: { href: '/reports/123', label: 'Open' },
  expiresAt: Date.now() + 24 * 3600_000,
});
```

Use `send()` for app-internal events a client-side handler reacts to programmatically (`'comment.created'`, `'export.ready'`, ...). Use `notify()` when the payload *is* the thing a human reads — Netifly validates it server-side (`title`/`body` length limits, a safe `link.href` — rejecting `javascript:`/`data:`/other unsafe schemes) and gives every notification a consistent shape your UI can render generically, without your app hand-rolling that schema itself. A `notify()` call that fails validation throws `NotificationValidationError` (exported from `@netiflyjs/core`) synchronously, before anything is published.

On the wire, `notify()` publishes with envelope `type: "notification"` — an ordinary, unprefixed type, so it flows through the client's normal auto-ack and `lastEventId` tracking exactly like any `send()`-originated message (see [Message Envelope](#-message-envelope)).
```

- [ ] **Step 2: Add `notify()`/`notifyOr()` to the `createNetifly<Events>(options)` API Reference entry**

In `README.md`, inside the `### \`createNetifly<Events>(options)\` — \`@netiflyjs/core\`` section, insert a new bullet immediately after the existing `sendOr<T>(...)` bullet (the one ending `...A rejection from \`offline()\` propagates out of \`sendOr()\` — it's not swallowed.`) and before the `disconnect(userId): void` bullet:

```markdown
- `notify(userId, notification): Promise<SendResult>` / `notifyOr(userId, notification, options): Promise<SendResult>` — validated, opinionated counterparts to `send()`/`sendOr()` for user-facing notifications (see [Events vs. notifications](#events-vs-notifications-when-to-use-send-vs-notify)). `notification` is `{ kind: 'info', title, body, severity?, link?, icon?, expiresAt?, meta? }`; a validation failure throws `NotificationValidationError` synchronously and nothing is published. Publishes with envelope `type: "notification"`.
```

- [ ] **Step 3: Add `notify()` to the `createNetiflyPublisher<Events>(options)` API Reference entry**

In `README.md`, inside the `### \`createNetiflyPublisher<Events>(options)\` — \`@netiflyjs/core\`` section, insert a new bullet immediately after the existing `send<T>(...)` bullet and before the `isOnline(userId)` bullet:

```markdown
- `notify(userId, notification): Promise<SendResult>` — same validated notification API as `NetiflyInstance.notify()` above. No `notifyOr()` on `NetiflyPublisher`, matching its existing `send()`-only (no `sendOr()`) surface.
```

- [ ] **Step 4: Add a condensed mention to `packages/core/README.md`**

In `packages/core/README.md`, inside the `### \`createNetifly(options)\` — \`@netiflyjs/core\`` section's bullet list, insert a new bullet immediately after the existing `send(userId, payload): Promise<void>` bullet:

```markdown
- `notify(userId, notification): Promise<SendResult>` — validated, opinionated notification API (`{ kind: 'info', title, body, severity?, link?, icon?, expiresAt?, meta? }`) built on `send()`. See the [full README](https://github.com/NetiflyJS/netifly#-api-reference) for validation rules and `notifyOr()`.
```

- [ ] **Step 5: Commit**

```bash
git add README.md packages/core/README.md
git commit -m "docs: document notify() (NOT-37)"
```
