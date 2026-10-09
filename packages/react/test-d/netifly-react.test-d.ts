import { expectType } from 'tsd';
import { useEvent } from '../src/index';

// This file is never executed — tsd only feeds it through the TypeScript
// compiler and checks the resulting diagnostics, same convention as
// @netiflyjs/client's test-d/netifly-client.test-d.ts.

type Events = {
  'export.ready': { url: string };
};

function Component(): null {
  useEvent<Events, 'export.ready'>('export.ready', (data) => {
    expectType<{ url: string }>(data);
  });

  // @ts-expect-error - 'no.such.event' is not a key of Events
  useEvent<Events, 'no.such.event'>('no.such.event', () => undefined);

  return null;
}

void Component;
