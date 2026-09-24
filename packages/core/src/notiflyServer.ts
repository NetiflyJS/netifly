import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { ConnectionRegistry } from './connectionRegistry';
import { RedisRouter } from './redisRouter';
import { startHeartbeat } from './heartbeat';
import type { CreateNotiflyOptions, NotiflyInstance, UserId } from './types';

const DEFAULT_PATH = '/notifly';
const HEARTBEAT_INTERVAL_MS = 30_000;

class NotiflyServerImpl extends EventEmitter implements NotiflyInstance {
  private readonly wss: WebSocketServer;
  private readonly registry: ConnectionRegistry<WebSocket>;
  private readonly router: RedisRouter;
  private readonly resolveUserId: CreateNotiflyOptions['resolveUserId'];
  private readonly path: string;
  private readonly heartbeatTimer: NodeJS.Timeout;
  private closed = false;

  constructor(options: CreateNotiflyOptions) {
    super();
    this.resolveUserId = options.resolveUserId;
    this.path = options.path ?? DEFAULT_PATH;

    this.registry = new ConnectionRegistry<WebSocket>({
      onLastDisconnect: (userId) => {
        this.router.unsubscribe(userId).catch((error: unknown) => this.emitError(error));
      },
    });

    const redisUrl = options.redisUrl ?? process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error(
        'Notifly: no redisUrl provided and REDIS_URL is not set. Pass { redisUrl } to createNotifly() or set the REDIS_URL environment variable.'
      );
    }

    this.router = new RedisRouter({
      redisUrl,
      onMessage: (userId, rawMessage) => this.deliverLocally(userId, rawMessage),
      onError: (error) => this.emitError(error),
    });

    this.wss = new WebSocketServer({ noServer: true });
    this.heartbeatTimer = startHeartbeat({
      intervalMs: HEARTBEAT_INTERVAL_MS,
      getClients: () => this.wss.clients,
    });

    options.server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      void this.handleUpgrade(req, socket, head);
    });
  }

  private async handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== this.path) {
      return;
    }

    let userId: unknown;
    try {
      userId = await this.resolveUserId(req);
    } catch (error) {
      this.emitError(error);
      userId = null;
    }

    if (typeof userId !== 'string' || userId.length === 0) {
      socket.destroy();
      return;
    }

    const resolvedUserId = userId;
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      void this.registerConnection(resolvedUserId, ws);
    });
  }

  // Awaiting the Redis SUBSCRIBE before registering the connection (rather
  // than firing it in the background) minimizes the window where a send()
  // that races a brand-new connection would be dropped.
  private async registerConnection(userId: UserId, ws: WebSocket): Promise<void> {
    // Tracks whether this connection actually made it into the registry, so
    // the 'close' listener below never emits 'disconnect' without a matching
    // prior 'connect' (e.g. when the socket dies before registration
    // completes).
    let registered = false;

    // Attached before the subscribe await below so that a socket which
    // disconnects during that window is still observed: without these
    // listeners in place first, an early 'close' would fire on a socket we
    // haven't started tracking yet, and we'd never find out.
    ws.on('error', (error) => this.emitError(error));
    ws.on('close', () => {
      this.registry.remove(userId, ws);
      if (registered) {
        this.emit('disconnect', userId);
      }
    });

    const needsSubscribe = !this.registry.hasConnections(userId);
    if (needsSubscribe) {
      try {
        await this.router.subscribe(userId);
      } catch (error) {
        this.emitError(error);
        ws.terminate();
        return;
      }
    }

    if (ws.readyState !== WebSocket.OPEN) {
      // The socket closed while we were awaiting the SUBSCRIBE above. Its
      // 'close' listener already ran registry.remove (a no-op, since we
      // hadn't added it yet). If we just created a brand-new subscription
      // for this user on its behalf, undo it now so it doesn't leak — unless
      // another connection for the same user registered in the meantime, in
      // which case unsubscribing here would pull the rug out from under it.
      if (needsSubscribe && !this.registry.hasConnections(userId)) {
        this.router.unsubscribe(userId).catch((error: unknown) => this.emitError(error));
      }
      return;
    }

    this.registry.add(userId, ws);
    registered = true;
    this.emit('connect', userId);
  }

  // Emits 'error' only when a consumer is actually listening. NotiflyServerImpl
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

  private deliverLocally(userId: UserId, rawMessage: string): void {
    for (const ws of this.registry.getConnections(userId)) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(rawMessage);
      }
    }
  }

  async send(userId: UserId, payload: unknown): Promise<void> {
    if (this.closed) {
      throw new Error('Notifly: cannot send after close()');
    }
    await this.router.publish(userId, payload);
  }

  disconnect(userId: UserId): void {
    for (const ws of this.registry.getConnections(userId)) {
      ws.close();
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.heartbeatTimer);

    // WebSocketServer#close's callback only fires once wss.clients is empty
    // — it does not close tracked client sockets itself. With any client
    // still connected, awaiting it below would hang forever, so every
    // tracked client is force-closed first.
    for (const ws of this.wss.clients) {
      ws.terminate();
    }

    await new Promise<void>((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()));
    });
    await this.router.close();
    this.registry.clear();
  }
}

export function createNotifly(options: CreateNotiflyOptions): NotiflyInstance {
  return new NotiflyServerImpl(options);
}
