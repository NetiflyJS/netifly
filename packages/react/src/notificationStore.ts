import type { ActionAckInfo, NetiflyClient, WireNotification } from '@netiflyjs/client';

export type NotificationStatus = 'unread' | 'read' | 'answered' | 'expired';
export type RespondResult = ActionAckInfo['status'];

export interface NotificationItem {
  id: string;
  receivedAt: number;
  status: NotificationStatus;
  notification: WireNotification;
}

export interface NotificationStore {
  getSnapshot(): NotificationItem[];
  subscribe(listener: () => void): () => void;
  markRead(id: string): void;
  markAllRead(): void;
  dismiss(id: string): void;
  respond(notificationId: string, actionId: string, input?: unknown): Promise<RespondResult>;
}

/**
 * One small in-memory store per `NetiflyProvider` instance — not a hook, so
 * every `useNotifications()` call sharing a provider shares the same state.
 */
export function createNotificationStore(client: NetiflyClient): NotificationStore {
  let items: NotificationItem[] = [];
  const listeners = new Set<() => void>();
  const pendingResponses = new Map<string, (status: RespondResult) => void>();
  const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function emit(): void {
    for (const listener of [...listeners]) listener();
  }

  function setItems(next: NotificationItem[]): void {
    items = next;
    emit();
  }

  function markStatus(id: string, status: NotificationStatus): void {
    setItems(items.map((item) => (item.id === id ? { ...item, status } : item)));
  }

  function expire(id: string): void {
    expiryTimers.delete(id);
    const current = items.find((item) => item.id === id);
    if (!current || current.status === 'answered' || current.status === 'expired') return;
    markStatus(id, 'expired');
  }

  function scheduleExpiry(item: NotificationItem): void {
    const expiresAt = item.notification.expiresAt;
    if (expiresAt === undefined) return;
    const delay = expiresAt - Date.now();
    if (delay <= 0) {
      expire(item.id);
      return;
    }
    expiryTimers.set(
      item.id,
      setTimeout(() => expire(item.id), delay)
    );
  }

  client.onNotification((notification, envelope) => {
    const item: NotificationItem = {
      id: envelope.id,
      receivedAt: envelope.ts,
      status: 'unread',
      notification,
    };
    setItems([item, ...items]);
    scheduleExpiry(item);
  });

  client.onActionAck(({ id, action, status }) => {
    pendingResponses.get(`${id}:${action}`)?.(status);
    pendingResponses.delete(`${id}:${action}`);
    if (status === 'accepted' || status === 'already_answered') {
      markStatus(id, 'answered');
    } else if (status === 'expired') {
      markStatus(id, 'expired');
    }
  });

  client.onResolved(({ id }) => {
    markStatus(id, 'answered');
  });

  return {
    getSnapshot: () => items,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    markRead(id) {
      client.markRead(id);
      setItems(
        items.map((item) => (item.id === id && item.status === 'unread' ? { ...item, status: 'read' } : item))
      );
    },
    markAllRead() {
      const unread = items.filter((item) => item.status === 'unread');
      if (unread.length === 0) return;
      for (const item of unread) client.markRead(item.id);
      setItems(items.map((item) => (item.status === 'unread' ? { ...item, status: 'read' } : item)));
    },
    dismiss(id) {
      const timer = expiryTimers.get(id);
      if (timer !== undefined) {
        clearTimeout(timer);
        expiryTimers.delete(id);
      }
      setItems(items.filter((item) => item.id !== id));
    },
    respond(notificationId, actionId, input) {
      const item = items.find((i) => i.id === notificationId);
      const action =
        item && item.notification.kind === 'action'
          ? item.notification.actions.find((a) => a.id === actionId)
          : undefined;
      if (!action) {
        return Promise.resolve('invalid');
      }
      return new Promise((resolve) => {
        pendingResponses.set(`${notificationId}:${actionId}`, resolve);
        client.respondToAction(notificationId, actionId, action.token, input);
      });
    },
  };
}
