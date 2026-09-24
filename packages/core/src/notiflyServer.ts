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
        void this.router.unsubscribe(userId);
      },
    });

    this.router = new RedisRouter({
      redisUrl: options.redisUrl ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
      onMessage: (userId, rawMessage) => this.deliverLocally(userId, rawMessage),
      onError: (error) => this.emit('error', error),
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
    } catch {
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
    if (!this.registry.hasConnections(userId)) {
      await this.router.subscribe(userId);
    }
    this.registry.add(userId, ws);
    this.emit('connect', userId);

    ws.on('close', () => {
      this.registry.remove(userId, ws);
      this.emit('disconnect', userId);
    });
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
    this.closed = true;
    clearInterval(this.heartbeatTimer);
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
