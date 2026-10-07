import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { NetiflyProvider } from './NetiflyProvider';
import { useNotifications } from './useNotifications';
import { FakeWebSocket } from './test-utils/fakeWebSocket';

beforeEach(() => {
  FakeWebSocket.reset();
});

function openSocket(): FakeWebSocket {
  const socket = FakeWebSocket.latest();
  act(() => socket.simulateOpen());
  return socket;
}

function deliver(socket: FakeWebSocket, id: string, data: unknown): void {
  act(() => socket.simulateMessage({ v: 1, id, type: 'notification', data, ts: Date.now() }));
}

function Badge(): React.ReactElement {
  const { unreadCount } = useNotifications();
  return <span data-testid="badge">{unreadCount}</span>;
}

function List(): React.ReactElement {
  const { items, markRead } = useNotifications();
  return (
    <ul>
      {items.map((item) => (
        <li key={item.id} data-testid="item" data-status={item.status} onClick={() => markRead(item.id)}>
          {item.notification.title}
        </li>
      ))}
    </ul>
  );
}

describe('useNotifications()', () => {
  it('shares one store across sibling components: marking read in one updates unreadCount in the other', () => {
    render(
      <NetiflyProvider url="ws://example.test/netifly">
        <Badge />
        <List />
      </NetiflyProvider>
    );
    const socket = openSocket();

    deliver(socket, 'n1', { kind: 'info', title: 'Hi', body: 'x' });
    expect(screen.getByTestId('badge').textContent).toBe('1');

    act(() => screen.getByTestId('item').click());

    expect(screen.getByTestId('badge').textContent).toBe('0');
    expect(screen.getByTestId('item').dataset.status).toBe('read');
  });

  it('dismiss() removes the item from items', () => {
    function Harness(): React.ReactElement {
      const { items, dismiss } = useNotifications();
      return (
        <button data-testid="dismiss" onClick={() => dismiss(items[0]?.id)}>
          {items.length}
        </button>
      );
    }

    render(
      <NetiflyProvider url="ws://example.test/netifly">
        <Harness />
      </NetiflyProvider>
    );
    const socket = openSocket();
    deliver(socket, 'n1', { kind: 'info', title: 'Hi', body: 'x' });
    expect(screen.getByTestId('dismiss').textContent).toBe('1');

    act(() => screen.getByTestId('dismiss').click());

    expect(screen.getByTestId('dismiss').textContent).toBe('0');
  });
});
