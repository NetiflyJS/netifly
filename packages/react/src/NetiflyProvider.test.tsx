import React, { useState } from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { NetiflyProvider, useNetifly, useNetiflyContext } from './NetiflyProvider';
import { FakeWebSocket } from './test-utils/fakeWebSocket';
import type { NotificationStore } from './notificationStore';

beforeEach(() => {
  FakeWebSocket.reset();
});

describe('useNetifly()', () => {
  it('throws a clear error when used outside the provider', () => {
    // React logs the thrown render error to console.error even though we
    // assert on it via toThrow() — expected noise for this one case, silenced
    // so the test run stays pristine.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => renderHook(() => useNetifly())).toThrow(
        'useNetifly() must be used within a <NetiflyProvider>'
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe('<NetiflyProvider>', () => {
  it('creates exactly one client instance and ends with exactly one live socket under StrictMode', () => {
    const seenClients = new Set<unknown>();
    function Probe(): null {
      seenClients.add(useNetifly().client);
      return null;
    }

    render(
      <React.StrictMode>
        <NetiflyProvider url="ws://example.test/netifly">
          <Probe />
        </NetiflyProvider>
      </React.StrictMode>
    );

    // StrictMode's synthetic mount→cleanup→mount runs connect()/close() twice
    // on the SAME client (one instance, never two) — that churn legitimately
    // closes the first socket and opens a second, so exactly one of the two
    // constructed sockets should still be live and the other fully closed.
    // No scenario here should ever leave two sockets simultaneously live.
    //
    // Asserted via closeRequested rather than readyState: a real
    // WebSocket.close() is asynchronous (CLOSING, then CLOSED later), so
    // "is it still live" has to be "was close() ever asked for", not a
    // readyState snapshot that only works if the double closes
    // synchronously.
    expect(seenClients.size).toBe(1);
    const neverClosed = FakeWebSocket.instances.filter((s) => !s.closeRequested);
    expect(neverClosed).toHaveLength(1);
  });

  it('closes the socket on unmount', () => {
    const { unmount } = render(
      <NetiflyProvider url="ws://example.test/netifly">
        <div>child</div>
      </NetiflyProvider>
    );

    const socket = FakeWebSocket.latest();
    act(() => socket.simulateOpen());
    unmount();

    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it('calls store.dispose() exactly once on unmount', () => {
    let store: NotificationStore | undefined;
    function Probe(): null {
      store = useNetiflyContext().store;
      return null;
    }

    const { unmount } = render(
      <NetiflyProvider url="ws://example.test/netifly">
        <Probe />
      </NetiflyProvider>
    );
    if (!store) throw new Error('Probe did not run');
    const disposeSpy = jest.spyOn(store, 'dispose');

    unmount();

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('reconnects with a freshly-read getToken(), not the one captured at mount', async () => {
    function Harness(): React.ReactElement {
      const [token, setToken] = useState('token-a');
      return (
        <NetiflyProvider url="ws://example.test/netifly" getToken={() => token} baseDelayMs={10} maxDelayMs={20}>
          <button data-testid="bump" onClick={() => setToken('token-b')}>
            bump
          </button>
        </NetiflyProvider>
      );
    }

    jest.useFakeTimers();
    try {
      const { getByTestId } = render(<Harness />);
      // getToken() is provided here (unlike every other test in this file),
      // so openSocket() awaits it even though it returns synchronously —
      // that's still a real microtask tick `render()`'s sync act() doesn't
      // drain, deferring the first socket's construction by one tick.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const firstSocket = FakeWebSocket.latest();
      act(() => firstSocket.simulateOpen());
      expect(firstSocket.url).toContain('token=token-a');

      act(() => getByTestId('bump').click());

      // A transient disconnect triggers the client's own reconnect logic,
      // which calls getToken() again for the new connection attempt. Each
      // getToken() call is awaited internally (even for a sync return), so
      // flush a microtask tick between the timer firing and the new socket
      // actually being constructed.
      await act(async () => {
        firstSocket.simulateServerClose(1006, '', false);
      });
      await act(async () => {
        jest.advanceTimersByTime(50);
        await Promise.resolve();
        await Promise.resolve();
      });

      const secondSocket = FakeWebSocket.latest();
      expect(secondSocket).not.toBe(firstSocket);
      expect(secondSocket.url).toContain('token=token-b');
    } finally {
      jest.useRealTimers();
    }
  });
});
