import type { WebSocket } from 'ws';
import { startHeartbeat } from './heartbeat';

function createMockSocket() {
  const handlers: Record<string, () => void> = {};
  return {
    ping: jest.fn(),
    terminate: jest.fn(),
    once: jest.fn((event: string, cb: () => void) => {
      handlers[event] = cb;
    }),
    emitPong: () => handlers.pong?.(),
  };
}

describe('startHeartbeat', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('pings every client on each interval tick', () => {
    const client = createMockSocket();
    startHeartbeat({ intervalMs: 1000, getClients: () => [client as unknown as WebSocket] });

    jest.advanceTimersByTime(1000);

    expect(client.ping).toHaveBeenCalledTimes(1);
    expect(client.terminate).not.toHaveBeenCalled();
  });

  it('terminates a client that never responded to the previous ping', () => {
    const client = createMockSocket();
    startHeartbeat({ intervalMs: 1000, getClients: () => [client as unknown as WebSocket] });

    jest.advanceTimersByTime(1000);
    jest.advanceTimersByTime(1000);

    expect(client.terminate).toHaveBeenCalledTimes(1);
  });

  it('keeps a client alive if it responds with pong before the next tick', () => {
    const client = createMockSocket();
    startHeartbeat({ intervalMs: 1000, getClients: () => [client as unknown as WebSocket] });

    jest.advanceTimersByTime(1000);
    client.emitPong();
    jest.advanceTimersByTime(1000);

    expect(client.terminate).not.toHaveBeenCalled();
    expect(client.ping).toHaveBeenCalledTimes(2);
  });

  it('stops ticking after the returned timer is cleared', () => {
    const client = createMockSocket();
    const timer = startHeartbeat({
      intervalMs: 1000,
      getClients: () => [client as unknown as WebSocket],
    });
    clearInterval(timer);

    jest.advanceTimersByTime(5000);

    expect(client.ping).not.toHaveBeenCalled();
  });
});
