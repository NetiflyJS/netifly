import type { NetiflyTransport, UserId } from '../types';

/**
 * A single-process, dependency-free NetiflyTransport for local development
 * and tests — no Redis required (NOT-20 design spec §8). Models exactly one
 * process: `receivers()` here means "subscribed on this process," not
 * cluster-wide presence.
 */
export function memoryTransport(): NetiflyTransport {
  const subscribers = new Set<UserId>();
  let onMessageCb: ((userId: UserId, message: string) => void) | undefined;
  let onErrorCb: ((error: Error) => void) | undefined;

  return {
    async subscribe(userId) {
      subscribers.add(userId);
    },

    async unsubscribe(userId) {
      subscribers.delete(userId);
    },

    async publish(userId, message) {
      const receivers = subscribers.has(userId) ? 1 : 0;
      if (receivers > 0) {
        // Delivered asynchronously, not in the same tick as publish() —
        // code/tests written against one transport must not accidentally
        // depend on timing behavior that only this transport happens to
        // provide (NOT-20 design spec §8).
        queueMicrotask(() => onMessageCb?.(userId, message));
      }
      return { receivers };
    },

    async receivers(userIds) {
      const counts: Record<UserId, number> = {};
      for (const userId of userIds) {
        counts[userId] = subscribers.has(userId) ? 1 : 0;
      }
      return counts;
    },

    onMessage(cb) {
      onMessageCb = cb;
    },

    // Realistically never invoked — there is no background connection that
    // can fail for an in-memory transport. Exists to satisfy the interface.
    onError(cb) {
      onErrorCb = cb;
    },

    async close() {
      subscribers.clear();
      onMessageCb = undefined;
      onErrorCb = undefined;
    },
  };
}
