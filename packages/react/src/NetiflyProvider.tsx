'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  createNetiflyClient,
  NetiflyClient,
  type ConnectionState,
  type EventMap,
  type NetiflyClientOptions,
} from '@netiflyjs/client';
import { createNotificationStore } from './notificationStore';
import type { NotificationStore } from './notificationStore';

export interface NetiflyContextValue<Events extends EventMap = EventMap> {
  client: NetiflyClient<Events>;
  status: ConnectionState;
  store: NotificationStore;
}

const NetiflyContext = createContext<NetiflyContextValue<EventMap> | null>(null);

export type NetiflyProviderProps<Events extends EventMap = EventMap> = NetiflyClientOptions & {
  children: ReactNode;
};

/**
 * Creates and owns a single `NetiflyClient` (and its notification store),
 * connecting on mount and closing on unmount. Client and store are created
 * together inside one lazy `useState` initializer, so under StrictMode's
 * double-invoke only one pair ever gets attached to an effect — the
 * discarded pair never calls `connect()` and is simply garbage.
 */
export function NetiflyProvider<Events extends EventMap = EventMap>({
  children,
  ...options
}: NetiflyProviderProps<Events>): ReactNode {
  const [{ client, store }] = useState(() => {
    const client = createNetiflyClient<Events>(options);
    return { client, store: createNotificationStore(client) };
  });
  const [status, setStatus] = useState<ConnectionState>(client.state);

  useEffect(() => {
    const unsubscribe = client.onStateChange(setStatus);
    client.connect();
    return () => {
      unsubscribe();
      client.close();
    };
  }, [client]);

  const value: NetiflyContextValue<EventMap> = {
    client: client as unknown as NetiflyClient<EventMap>,
    status,
    store,
  };

  return <NetiflyContext.Provider value={value}>{children}</NetiflyContext.Provider>;
}

/** @internal shared by useNetifly/useEvent/useNotifications — not part of the public API. */
export function useNetiflyContext<Events extends EventMap = EventMap>(): NetiflyContextValue<Events> {
  const ctx = useContext(NetiflyContext);
  if (!ctx) {
    throw new Error('useNetifly() must be used within a <NetiflyProvider>');
  }
  return ctx as unknown as NetiflyContextValue<Events>;
}

/** Returns `{ client, status }` and throws when used outside a `<NetiflyProvider>`. */
export function useNetifly<Events extends EventMap = EventMap>(): NetiflyContextValue<Events> {
  return useNetiflyContext<Events>();
}
