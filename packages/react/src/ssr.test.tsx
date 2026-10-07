import React from 'react';
import { renderToString } from 'react-dom/server';
import { NetiflyProvider } from './NetiflyProvider';
import { FakeWebSocket } from './test-utils/fakeWebSocket';

beforeEach(() => {
  FakeWebSocket.reset();
});

describe('SSR', () => {
  it('renderToString never opens a socket', () => {
    renderToString(
      <NetiflyProvider url="ws://example.test/netifly">
        <div>child</div>
      </NetiflyProvider>
    );

    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
