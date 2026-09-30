import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { monotonicFactory } from 'ulid';
import { ConnectionRegistry } from './connectionRegistry';
import { redisTransport } from './transports/redisTransport';
import { RefCountedTransport } from './transports/refCountedTransport';
import { startHeartbeat } from './heartbeat';
import { parseInboundFrame } from './inboundFrame';
import type { InboundFrame } from './inboundFrame';
import { TokenBucket } from './rateLimiter';
import { resolveActionSecret } from './actionSecret';
import { buildActionWireNotification, verifyActionToken } from './actionToken';
import { validateNotification } from './notification';
import { ENVELOPE_VERSION } from './types';
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
  NetiflyTransport,
  Notification,
  RejectInfo,
  ResponseInfo,
  SendOrOptions,
  SendResult,
  SentInfo,
  UserId,
} from './types';

const DEFAULT_PATH = '/netifly';
const HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_PAYLOAD = 4096;
const DEFAULT_MAX_BUFFERED_BYTES = 1_048_576;
const DEFAULT_MAX_CONNECTIONS_PER_USER = 10;
const DEFAULT_MAX_INBOUND_FRAMES_PER_SECOND = 20;
const DEFAULT_DRAIN_MS = 5000;

// Events introduced for client acks/read state (NOT-30) — a listener that
// throws or rejects on one of these must never crash the host process or
// block other listeners for the same event (spec §9). Registered listeners
// for these events are wrapped (see wrapListener) so a bad app hook — e.g.
// one that persists to a database and occasionally rejects — can't take the
// server down. Pre-existing events ('connect'/'disconnect'/'error'/
// 'reject'/'dropped') keep their existing unwrapped behavior.
const SAFE_EVENTS = new Set(['sent', 'delivered', 'read', 'response', 'malformedFrame', 'action']);

class NetiflyServerImpl<Events extends EventMap = EventMap>
  extends EventEmitter
  implements NetiflyInstance<Events>
{
  private readonly wss: WebSocketServer;
  private readonly registry: ConnectionRegistry<WebSocket>;
  private readonly transport: NetiflyTransport;
  private readonly resolveUserId: CreateNetiflyOptions<Events>['resolveUserId'];
  private readonly path: string;
  private readonly allowedOrigins: AllowedOrigins | undefined;
  private readonly maxPayload: number;
  private readonly maxBufferedBytes: number;
  private readonly maxConnectionsPerUser: number;
  private readonly maxInboundFramesPerSecond: number;
  private readonly validate: CreateNetiflyOptions<Events>['validate'];
  private readonly actionSecret: string | undefined;
  private readonly heartbeatTimer: NodeJS.Timeout;
  private readonly ulid = monotonicFactory();
  private closed = false;

  constructor(options: CreateNetiflyOptions<Events>) {
    super();
    this.resolveUserId = options.resolveUserId;
    this.path = options.path ?? DEFAULT_PATH;
    this.allowedOrigins = options.allowedOrigins;
    this.maxPayload = options.maxPayload ?? DEFAULT_MAX_PAYLOAD;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.maxConnectionsPerUser = options.maxConnectionsPerUser ?? DEFAULT_MAX_CONNECTIONS_PER_USER;
    this.maxInboundFramesPerSecond =
      options.maxInboundFramesPerSecond ?? DEFAULT_MAX_INBOUND_FRAMES_PER_SECOND;
    this.validate = options.validate;

    this.registry = new ConnectionRegistry<WebSocket>({});

    if (options.transport && options.namespace !== undefined) {
      throw new Error(
        'Netifly: pass `namespace` to redisTransport() directly when using an explicit `transport` option — ' +
          'createNetifly({ namespace }) only applies to the redisUrl-built default transport.'
      );
    }

    let raw: NetiflyTransport;
    if (options.transport) {
      raw = options.transport;
    } else {
      const redisUrl = options.redisUrl ?? process.env.REDIS_URL;
      if (!redisUrl) {
        throw new Error(
          'Netifly: no redisUrl provided and REDIS_URL is not set. Pass { redisUrl } to createNetifly() or set the REDIS_URL environment variable.'
        );
      }
      raw = redisTransport(redisUrl, { namespace: options.namespace });
    }
    this.transport = new RefCountedTransport(raw);
    this.transport.onMessage((userId, message) => this.deliverLocally(userId, message));
    this.transport.onError((error) => this.emitError(error));

    this.actionSecret = resolveActionSecret(options.actionSecret);

    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.maxPayload });
    this.heartbeatTimer = startHeartbeat({
      intervalMs: HEARTBEAT_INTERVAL_MS,
      getClients: () => this.wss.clients,
    });

    options.server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      void this.handleUpgrade(req, socket, head);
    });
  }

  // Overridden (rather than relying on the inherited EventEmitter methods,
  // as every other event still does) only to wrap listeners for SAFE_EVENTS
  // — see the comment on that constant. Node's own once()/removeListener
  // machinery is untouched: we wrap the listener function itself before
  // handing it to super.on()/super.once(), so native once-after-first-call
  // semantics still apply to our wrapper, not to the caller's function.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, SAFE_EVENTS.has(event as string) ? this.wrapListener(listener) : listener);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  once(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.once(event, SAFE_EVENTS.has(event as string) ? this.wrapListener(listener) : listener);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private wrapListener(listener: (...args: any[]) => void): (...args: any[]) => void {
    return (...args: unknown[]) => {
      let result: unknown;
      try {
        result = listener(...args);
      } catch (error) {
        this.emitError(error);
        return;
      }
      if (result instanceof Promise) {
        result.catch((error: unknown) => this.emitError(error));
      }
    };
  }

  private async handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== this.path) {
      return;
    }

    const origin = req.headers.origin;
    if (!this.isOriginAllowed(origin, req)) {
      // socket.end() (rather than write() + destroy()) lets the response
      // flush before the socket closes — matches ws's own abortHandshake().
      socket.once('finish', () => socket.destroy());
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      this.emitReject({ reason: 'origin', status: 403, origin, req });
      return;
    }

    let userId: unknown;
    let authError: Error | undefined;
    try {
      userId = await this.resolveUserId(req);
    } catch (error) {
      authError = error instanceof Error ? error : new Error(String(error));
      userId = null;
    }

    if (typeof userId !== 'string' || userId.length === 0) {
      socket.once('finish', () => socket.destroy());
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      this.emitReject({ reason: 'auth', status: 401, error: authError, req });
      return;
    }

    const resolvedUserId = userId;

    // Per-instance only: ConnectionRegistry tracks connections held by this
    // process alone, so in a multi-instance deployment a single userId could
    // still hold up to maxConnectionsPerUser connections on *each* instance,
    // not maxConnectionsPerUser cluster-wide. Same caveat as disconnect()
    // above/README — this bounds abuse per process, not globally.
    if (this.registry.getConnections(resolvedUserId).size >= this.maxConnectionsPerUser) {
      socket.once('finish', () => socket.destroy());
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      this.emitReject({ reason: 'maxConnectionsPerUser', status: 429, userId: resolvedUserId, req });
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      void this.registerConnection(resolvedUserId, ws);
    });
  }

  // Awaiting the Redis SUBSCRIBE before registering the connection (rather
  // than firing it in the background) minimizes the window where a send()
  // that races a brand-new connection would be dropped.
  //
  // Every connection subscribes and unsubscribes for itself exactly once,
  // regardless of how many other connections exist for the same user:
  // RefCountedTransport ref-counts subscriptions per userId, so overlapping
  // connections can never unsubscribe out from under one another (NOT-5).
  // ConnectionRegistry state is deliberately not consulted here — it only
  // reflects fully-registered connections, not ones still mid-subscribe.
  private async registerConnection(userId: UserId, ws: WebSocket): Promise<void> {
    // Tracks whether this connection's subscribe is "ours to unsubscribe" —
    // i.e. whether the 'close' listener below still needs to pair it with an
    // unsubscribe(), or whether the post-await code already handled it.
    let subscribed = false;

    // Attached before the subscribe await below so that a socket which
    // disconnects during that window is still observed: without these
    // listeners in place first, an early 'close' would fire on a socket we
    // haven't started tracking yet, and we'd never find out.
    ws.on('error', (error) => this.emitError(error));
    ws.on('close', () => {
      this.registry.remove(userId, ws);
      if (subscribed) {
        subscribed = false;
        this.emit('disconnect', userId);
        this.transport.unsubscribe(userId).catch((error: unknown) => this.emitError(error));
      }
    });

    try {
      await this.transport.subscribe(userId);
    } catch (error) {
      this.emitError(error);
      ws.terminate();
      return;
    }

    if (ws.readyState !== WebSocket.OPEN) {
      // Closed while the SUBSCRIBE was in flight. The 'close' listener above
      // already ran (before `subscribed` was set, so it didn't pair an
      // unsubscribe) — do it here instead.
      this.transport.unsubscribe(userId).catch((error: unknown) => this.emitError(error));
      return;
    }

    subscribed = true;
    this.registry.add(userId, ws);
    this.emit('connect', userId);
    const inboundBucket = new TokenBucket(this.maxInboundFramesPerSecond);
    ws.on('message', (data) => this.handleInboundFrame(userId, ws, data, inboundBucket));
  }

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
    const relayMessage = this.serializeEnvelope(userId, relayEnvelope);
    this.transport.publish(userId, relayMessage).catch((error: unknown) => this.emitError(error));
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

    // NOT-20 replaced the earlier direct-Redis RedisRouter.tryLockAnswered()
    // with this.transport.claim() — an atomic claim primitive on the
    // NetiflyTransport interface itself (Task 4), so this works under any
    // transport, not just Redis. `answered:` is this call site's own key
    // convention — claim() treats `key` as an opaque string.
    const ttlSeconds = Math.max(1, Math.ceil((payload.exp - Date.now()) / 1000));
    let claimed: boolean;
    try {
      claimed = await this.transport.claim(`answered:${payload.nid}`, ttlSeconds);
    } catch (error) {
      this.emitError(error);
      this.sendActionAck(ws, frame.id, frame.action, 'invalid');
      return;
    }
    if (!claimed) {
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
    const resolvedMessage = this.serializeEnvelope(userId, resolvedEnvelope);
    this.transport.publish(userId, resolvedMessage).catch((error: unknown) => this.emitError(error));

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

  private emitMalformedFrame(info: MalformedFrameInfo): void {
    this.emit('malformedFrame', info);
  }

  private isOriginAllowed(origin: string | undefined, req: IncomingMessage): boolean {
    if (this.allowedOrigins === '*') {
      return true;
    }

    if (typeof this.allowedOrigins === 'function') {
      return this.allowedOrigins(origin);
    }

    // Non-browser clients (raw ws connections, server-to-server) don't send
    // an Origin header at all — allowed by default for every form except the
    // function predicate above, which the caller can use to require one.
    if (origin === undefined) {
      return true;
    }

    if (Array.isArray(this.allowedOrigins)) {
      return this.allowedOrigins.some((entry) => {
        if (typeof entry === 'string') {
          return entry === origin;
        }
        // Reset lastIndex first: a g/y-flagged RegExp is stateful, and
        // reusing one across calls would otherwise alternate match results.
        entry.lastIndex = 0;
        return entry.test(origin);
      });
    }

    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  // Emits 'error' only when a consumer is actually listening. NetiflyServerImpl
  // is a plain EventEmitter, and Node throws synchronously when 'error' is
  // emitted with no listener attached — that would crash the host process for
  // something as routine as a transient Redis hiccup or a flaky client socket,
  // which contradicts this library's goal of surfacing errors rather than
  // taking the host down.
  private emitError(error: unknown): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }

  private emitReject(info: RejectInfo): void {
    this.emit('reject', info);
  }

  private deliverLocally(userId: UserId, rawMessage: string): void {
    for (const ws of this.registry.getConnections(userId)) {
      if (ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      // A slow/stalled client (not reading fast enough, or at all) would
      // otherwise let ws.send() queue data in bufferedAmount forever, growing
      // server memory unbounded. Once a connection is over the threshold we
      // stop sending to it and shed it with 1013 ("Try Again Later") instead
      // — this only affects the one stalled connection, not the rest of the
      // user's connections, which still receive the message normally below.
      if (ws.bufferedAmount > this.maxBufferedBytes) {
        this.emit('dropped', { userId, reason: 'maxBufferedBytes' });
        ws.close(1013, 'Netifly: outbound buffer exceeded maxBufferedBytes');
        continue;
      }
      ws.send(rawMessage);
    }
  }

  async send<T>(userId: UserId, payload: T): Promise<SendResult>;
  async send<K extends keyof Events & string>(
    userId: UserId,
    type: K,
    data: Events[K]
  ): Promise<SendResult>;
  async send<T>(userId: UserId, ...rest: [T] | [string, T]): Promise<SendResult> {
    return this.sendInternal(userId, rest);
  }

  async sendOr<T>(userId: UserId, payload: T, options: SendOrOptions): Promise<SendResult>;
  async sendOr<K extends keyof Events & string>(
    userId: UserId,
    type: K,
    data: Events[K],
    options: SendOrOptions
  ): Promise<SendResult>;
  async sendOr<T>(
    userId: UserId,
    ...rest: [T, SendOrOptions] | [string, T, SendOrOptions]
  ): Promise<SendResult> {
    const options = rest[rest.length - 1] as SendOrOptions;
    const sendRest = (rest.length === 3 ? [rest[0], rest[1]] : [rest[0]]) as [T] | [string, T];

    const result = await this.sendInternal(userId, sendRest);
    if (!result.delivered) {
      await options.offline();
    }
    return result;
  }

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
  private async publishEnvelope<T>(userId: UserId, type: string, data: T, id?: string): Promise<SendResult> {
    const envelope = this.buildEnvelope(type, data, id);
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

  private buildEnvelope<T>(type: string, data: T, id: string = this.ulid()): Envelope<T> {
    return { v: ENVELOPE_VERSION, id, type, data, ts: Date.now() };
  }

  private serializeEnvelope(userId: UserId, envelope: Envelope<unknown>): string {
    try {
      return JSON.stringify(envelope);
    } catch (error) {
      const message = `Netifly: payload for user "${userId}" is not JSON-serializable`;
      const serializationError = new Error(message);
      (serializationError as Error & { cause?: unknown }).cause = error;
      throw serializationError;
    }
  }

  async isOnline(userId: UserId): Promise<boolean> {
    const counts = await this.transport.receivers([userId]);
    return counts[userId] > 0;
  }

  async whoIsOnline(userIds: UserId[]): Promise<Record<UserId, boolean>> {
    const counts = await this.transport.receivers(userIds);
    const online: Record<UserId, boolean> = {};
    for (const userId of userIds) {
      online[userId] = counts[userId] > 0;
    }
    return online;
  }

  isConnectedHere(userId: UserId): boolean {
    return this.registry.hasConnections(userId);
  }

  disconnect(userId: UserId): void {
    for (const ws of this.registry.getConnections(userId)) {
      ws.close();
    }
  }

  async close(options: CloseOptions = {}): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.heartbeatTimer);

    const { drainMs = DEFAULT_DRAIN_MS, force = false } = options;

    // WebSocketServer#close's callback only fires once wss.clients is empty
    // — it does not close tracked client sockets itself. With any client
    // still connected, awaiting it below would hang forever, so every
    // tracked client needs to be gone first.
    //
    // By default that's done gracefully: every currently-OPEN client is sent
    // a real close frame with code 1012 ("Service Restart") so it can tell a
    // deploy apart from an abrupt drop and reconnect accordingly, rather than
    // every connection dropping and reconnecting at the same instant. We wait
    // for each socket's own 'close' event (proving it completed its closing
    // handshake) or `drainMs`, whichever comes first, then unconditionally
    // terminate() whatever is still left in wss.clients — stragglers that
    // never acknowledged the close frame — so this can never hang. Passing
    // `force: true` skips the drain entirely and terminate()s everyone
    // immediately, matching the pre-NOT-19 behavior (useful for tests, or an
    // already-degraded process that can't afford to wait).
    if (force || this.wss.clients.size === 0) {
      for (const ws of this.wss.clients) {
        ws.terminate();
      }
    } else {
      const drained = Promise.all(
        Array.from(this.wss.clients)
          .filter((ws) => ws.readyState === WebSocket.OPEN)
          .map(
            (ws) =>
              new Promise<void>((resolve) => {
                ws.once('close', () => resolve());
                ws.close(1012, 'Netifly: server is restarting');
              })
          )
      );
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, drainMs));
      await Promise.race([drained, timeout]);

      for (const ws of this.wss.clients) {
        ws.terminate();
      }
    }

    await new Promise<void>((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()));
    });
    await this.transport.close();
    this.registry.clear();
  }
}

export function createNetifly<Events extends EventMap = EventMap>(
  options: CreateNetiflyOptions<Events>
): NetiflyInstance<Events> {
  return new NetiflyServerImpl<Events>(options);
}
