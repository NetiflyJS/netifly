import { expectType } from 'tsd';
import { createNetiflyClient } from '../src/index';
import type { Notification } from '@netiflyjs/core';

// NOT-37: proves a typed `NetiflyClient<Events>` can subscribe to notify()'s
// wire type — add a `notification: Notification` entry to the app's own
// `Events` map, then `client.on('notification', ...)` type-checks like any
// other event. See the README's "Events vs. notifications" section.
//
// This file is never executed — tsd only feeds it through the TypeScript
// compiler and checks the resulting diagnostics against the `expectType`
// assertion below.

type Events = {
  'export.ready': { url: string };
  notification: Notification;
};

const client = createNetiflyClient<Events>({ url: 'wss://example.com/netifly' });

client.on('notification', (data) => {
  expectType<Notification>(data);
});
