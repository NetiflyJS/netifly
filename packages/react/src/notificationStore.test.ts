import { createNetiflyClient } from '@netiflyjs/client';
import type { NetiflyClient } from '@netiflyjs/client';
import { createNotificationStore } from './notificationStore';
import { FakeWebSocket } from './test-utils/fakeWebSocket';

beforeEach(() => {
  FakeWebSocket.reset();
});

function makeConnectedClient(): { client: NetiflyClient; socket: FakeWebSocket } {
  const client = createNetiflyClient({ url: 'ws://example.test/netifly' });
  client.connect();
  const socket = FakeWebSocket.latest();
  socket.simulateOpen();
  return { client, socket };
}

function deliverNotification(socket: FakeWebSocket, id: string, data: unknown, ts = Date.now()): void {
  socket.simulateMessage({ v: 1, id, type: 'notification', data, ts });
}

function deliverActionAck(
  socket: FakeWebSocket,
  info: { id: string; action: string; status: 'accepted' | 'already_answered' | 'expired' | 'invalid' }
): void {
  socket.simulateMessage({ v: 1, id: 'ack-envelope', type: 'netifly.actionAck', data: info, ts: Date.now() });
}

function actionNotification(expiresAt = Date.now() + 60_000) {
  return {
    kind: 'action',
    title: 'Approve?',
    body: 'x',
    actions: [{ id: 'approve', label: 'Approve', token: 'signed-token-approve' }],
    expiresAt,
  };
}

describe('createNotificationStore', () => {
  it('adds a newly received notification as an unread item', () => {
    const { socket, client } = makeConnectedClient();
    const store = createNotificationStore(client);

    deliverNotification(socket, 'n1', { kind: 'info', title: 'Hi', body: 'x' }, 1000);

    expect(store.getSnapshot()).toEqual([
      {
        id: 'n1',
        receivedAt: 1000,
        status: 'unread',
        notification: { kind: 'info', title: 'Hi', body: 'x' },
      },
    ]);
  });

  it('notifies subscribers when a notification arrives', () => {
    const { socket, client } = makeConnectedClient();
    const store = createNotificationStore(client);
    const listener = jest.fn();
    store.subscribe(listener);

    deliverNotification(socket, 'n1', { kind: 'info', title: 'Hi', body: 'x' });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('markRead() flips an unread item to read and sends markRead to the server', () => {
    const { socket, client } = makeConnectedClient();
    const store = createNotificationStore(client);
    deliverNotification(socket, 'n1', { kind: 'info', title: 'Hi', body: 'x' });
    socket.sentFrames.length = 0;

    store.markRead('n1');

    expect(store.getSnapshot()[0].status).toBe('read');
    expect(socket.sentFrames).toContainEqual({ type: 'read', id: 'n1' });
  });

  it('markAllRead() flips every unread item to read', () => {
    const { socket, client } = makeConnectedClient();
    const store = createNotificationStore(client);
    deliverNotification(socket, 'n1', { kind: 'info', title: 'A', body: 'x' });
    deliverNotification(socket, 'n2', { kind: 'info', title: 'B', body: 'x' });

    store.markAllRead();

    expect(store.getSnapshot().map((i) => i.status)).toEqual(['read', 'read']);
  });

  it('dismiss() removes the item locally without sending any wire frame', () => {
    const { socket, client } = makeConnectedClient();
    const store = createNotificationStore(client);
    deliverNotification(socket, 'n1', { kind: 'info', title: 'Hi', body: 'x' });
    socket.sentFrames.length = 0;

    store.dismiss('n1');

    expect(store.getSnapshot()).toEqual([]);
    expect(socket.sentFrames).toEqual([]);
  });

  describe('respond()', () => {
    it('sends the action frame with the token looked up from the stored notification', () => {
      const { socket, client } = makeConnectedClient();
      const store = createNotificationStore(client);
      deliverNotification(socket, 'n1', actionNotification());
      socket.sentFrames.length = 0;

      void store.respond('n1', 'approve', { note: 'lgtm' });

      expect(socket.sentFrames).toEqual([
        { type: 'action', id: 'n1', action: 'approve', token: 'signed-token-approve', input: { note: 'lgtm' } },
      ]);
    });

    it('resolves "accepted" and marks the item answered', async () => {
      const { socket, client } = makeConnectedClient();
      const store = createNotificationStore(client);
      deliverNotification(socket, 'n1', actionNotification());

      const pending = store.respond('n1', 'approve');
      deliverActionAck(socket, { id: 'n1', action: 'approve', status: 'accepted' });

      expect(await pending).toBe('accepted');
      expect(store.getSnapshot()[0].status).toBe('answered');
    });

    it('resolves "already_answered" as reported by the server', async () => {
      const { socket, client } = makeConnectedClient();
      const store = createNotificationStore(client);
      deliverNotification(socket, 'n1', actionNotification());

      const pending = store.respond('n1', 'approve');
      deliverActionAck(socket, { id: 'n1', action: 'approve', status: 'already_answered' });

      expect(await pending).toBe('already_answered');
    });

    it('resolves "expired" as reported by the server and marks the item expired', async () => {
      const { socket, client } = makeConnectedClient();
      const store = createNotificationStore(client);
      deliverNotification(socket, 'n1', actionNotification());

      const pending = store.respond('n1', 'approve');
      deliverActionAck(socket, { id: 'n1', action: 'approve', status: 'expired' });

      expect(await pending).toBe('expired');
      expect(store.getSnapshot()[0].status).toBe('expired');
    });

    it('resolves "invalid" locally, without sending a frame, for an unknown action id', async () => {
      const { socket, client } = makeConnectedClient();
      const store = createNotificationStore(client);
      deliverNotification(socket, 'n1', actionNotification());
      socket.sentFrames.length = 0;

      const result = await store.respond('n1', 'no-such-action');

      expect(result).toBe('invalid');
      expect(socket.sentFrames).toEqual([]);
    });

    it('resolves "invalid" locally for an unknown notification id', async () => {
      const { client } = makeConnectedClient();
      const store = createNotificationStore(client);

      expect(await store.respond('no-such-notification', 'approve')).toBe('invalid');
    });
  });

  describe('expiry', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('flips an item to expired once its expiresAt passes, without a server round trip', () => {
      const now = Date.now();
      const { socket, client } = makeConnectedClient();
      const store = createNotificationStore(client);
      deliverNotification(socket, 'n1', actionNotification(now + 5000), now);
      socket.sentFrames.length = 0;

      jest.advanceTimersByTime(5000);

      expect(store.getSnapshot()[0].status).toBe('expired');
      expect(socket.sentFrames).toEqual([]);
    });

    it('does not flip an already-answered item back to expired once its expiresAt passes', () => {
      const now = Date.now();
      const { socket, client } = makeConnectedClient();
      const store = createNotificationStore(client);
      deliverNotification(socket, 'n1', actionNotification(now + 5000), now);
      deliverActionAck(socket, { id: 'n1', action: 'approve', status: 'accepted' });

      jest.advanceTimersByTime(5000);

      expect(store.getSnapshot()[0].status).toBe('answered');
    });
  });

  describe('onResolved (answered on another device)', () => {
    it('marks the item answered when netifly.notification.resolved arrives without a local respond() call', () => {
      const { socket, client } = makeConnectedClient();
      const store = createNotificationStore(client);
      deliverNotification(socket, 'n1', actionNotification());

      socket.simulateMessage({
        v: 1,
        id: 'resolved-envelope',
        type: 'netifly.notification.resolved',
        data: { id: 'n1', action: 'approve' },
        ts: Date.now(),
      });

      expect(store.getSnapshot()[0].status).toBe('answered');
    });
  });
});
