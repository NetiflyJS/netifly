import type { WebSocket } from 'ws';

export interface HeartbeatOptions {
  intervalMs: number;
  getClients: () => Iterable<WebSocket>;
}

// A client that doesn't answer one ping with a pong before the next tick is
// assumed dead (crashed, lost network) and terminated so its Redis
// subscription doesn't leak forever.
export function startHeartbeat(options: HeartbeatOptions): NodeJS.Timeout {
  const alive = new WeakMap<WebSocket, boolean>();

  return setInterval(() => {
    for (const ws of options.getClients()) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.once('pong', () => alive.set(ws, true));
      ws.ping();
    }
  }, options.intervalMs);
}
