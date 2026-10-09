import { useEffect, useRef } from 'react';
import type { Envelope, EventMap } from '@netiflyjs/client';
import { useNetiflyContext } from './NetiflyProvider';

/**
 * Subscribes to one application event type, typed against `Events`. Always
 * calls the latest `handler` without resubscribing when it changes identity,
 * and unsubscribes on unmount.
 */
export function useEvent<Events extends EventMap, K extends keyof Events & string>(
  type: K,
  handler: (data: Events[K], envelope: Envelope<Events[K]>) => void
): void {
  const { client } = useNetiflyContext<Events>();
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    return client.on(type, (data, envelope) => handlerRef.current(data, envelope));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, type]);
}
