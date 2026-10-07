import React from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { NetiflyProvider, useNetifly } from './NetiflyProvider';
import { FakeWebSocket } from './test-utils/fakeWebSocket';

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
    expect(seenClients.size).toBe(1);
    const live = FakeWebSocket.instances.filter((s) => s.readyState !== FakeWebSocket.CLOSED);
    expect(live).toHaveLength(1);
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
});
