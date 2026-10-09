import React from 'react';
import { act, render } from '@testing-library/react';
import { NetiflyClient } from '@netiflyjs/client';
import { NetiflyProvider } from './NetiflyProvider';
import { useEvent } from './useEvent';
import { FakeWebSocket } from './test-utils/fakeWebSocket';

type TestEvents = { 'export.ready': { tag: string } };

beforeEach(() => {
  FakeWebSocket.reset();
});

function openSocket(): FakeWebSocket {
  const socket = FakeWebSocket.latest();
  act(() => socket.simulateOpen());
  return socket;
}

function deliver(socket: FakeWebSocket, type: string, data: unknown): void {
  act(() =>
    socket.simulateMessage({ v: 1, id: `${type}-${Date.now()}-${Math.random()}`, type, data, ts: Date.now() })
  );
}

describe('useEvent()', () => {
  it('always calls the latest handler, without resubscribing, as the handler prop changes', () => {
    const calls: string[] = [];
    const onSpy = jest.spyOn(NetiflyClient.prototype, 'on');

    function HarnessWithLatest({ tag }: { tag: string }): null {
      useEvent<TestEvents, 'export.ready'>('export.ready', (data) => {
        calls.push(`${tag}:${data.tag}`);
      });
      return null;
    }

    const { rerender } = render(
      <NetiflyProvider url="ws://example.test/netifly">
        <HarnessWithLatest tag="v1" />
      </NetiflyProvider>
    );
    const socket = openSocket();

    deliver(socket, 'export.ready', { tag: 'a' });
    expect(calls).toEqual(['v1:a']);

    rerender(
      <NetiflyProvider url="ws://example.test/netifly">
        <HarnessWithLatest tag="v2" />
      </NetiflyProvider>
    );

    deliver(socket, 'export.ready', { tag: 'b' });
    expect(calls).toEqual(['v1:a', 'v2:b']);
    expect(onSpy).toHaveBeenCalledTimes(1);
    onSpy.mockRestore();
  });

  it('unsubscribes on unmount', () => {
    const calls: unknown[] = [];

    function Harness(): null {
      useEvent<TestEvents, 'export.ready'>('export.ready', (data) => calls.push(data));
      return null;
    }

    const { unmount } = render(
      <NetiflyProvider url="ws://example.test/netifly">
        <Harness />
      </NetiflyProvider>
    );
    const socket = openSocket();

    deliver(socket, 'export.ready', { tag: 'before-unmount' });
    expect(calls).toEqual([{ tag: 'before-unmount' }]);

    unmount();
    deliver(socket, 'export.ready', { tag: 'after-unmount' });

    expect(calls).toEqual([{ tag: 'before-unmount' }]);
  });
});
