'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
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

export type NetiflyProviderProps = NetiflyClientOptions & {
  children: ReactNode;
};

/**
 * Creates and owns a single `NetiflyClient` (and its notification store),
 * connecting on mount and closing on unmount. Client and store are created
 * together inside one lazy `useState` initializer, so under StrictMode's
 * double-invoke only one pair ever gets attached to an effect — the
 * discarded pair never calls `connect()` and is simply garbage.
 *
 * `url`/`getToken`/etc. are read once at mount, not reconnected on change —
 * except `getToken` itself, which is re-read from a ref on every (re)connect
 * attempt so a token obtained from a later render (e.g. after a refresh) is
 * what a subsequent reconnect actually presents, not the closure captured
 * when the client was first constructed.
 */
export function NetiflyProvider<Events extends EventMap = EventMap>({
  children,
  ...options
}: NetiflyProviderProps): ReactNode {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [{ client, store }] = useState(() => {
    const client = createNetiflyClient<Events>({
      ...optionsRef.current,
      getToken: optionsRef.current.getToken ? () => optionsRef.current.getToken!() : undefined,
    });
    return { client, store: createNotificationStore(client) };
  });
  const [status, setStatus] = useState<ConnectionState>(client.state);

  useEffect(() => {
    const unsubscribe = client.onStateChange(setStatus);
    client.connect();
    return () => {
      unsubscribe();
      client.close();
      store.dispose();
    };
  }, [client, store]);

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
