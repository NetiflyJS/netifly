import { useMemo, useSyncExternalStore } from 'react';
import type { EventMap } from '@netiflyjs/client';
import { useNetiflyContext } from './NetiflyProvider';
import type { NotificationItem, RespondResult } from './notificationStore';

export interface UseNotificationsResult {
  items: NotificationItem[];
  unreadCount: number;
  markRead: (id: string) => void;
  markAllRead: () => void;
  dismiss: (id: string) => void;
  respond: (notificationId: string, actionId: string, input?: unknown) => Promise<RespondResult>;
}

/** Reads the provider's shared notification store via `useSyncExternalStore`. */
export function useNotifications<Events extends EventMap = EventMap>(): UseNotificationsResult {
  const { store } = useNetiflyContext<Events>();
  const items = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const unreadCount = useMemo(() => items.filter((item) => item.status === 'unread').length, [items]);

  return {
    items,
    unreadCount,
    markRead: store.markRead,
    markAllRead: store.markAllRead,
    dismiss: store.dismiss,
    respond: store.respond,
  };
}
