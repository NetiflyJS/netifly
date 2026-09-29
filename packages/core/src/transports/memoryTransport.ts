import type { NetiflyTransport, UserId } from '../types';

/**
 * A single-process, dependency-free NetiflyTransport for local development
 * and tests — no Redis required (NOT-20 design spec §8). Models exactly one
 * process: `receivers()` here means "subscribed on this process," not
 * cluster-wide presence.
 */
export function memoryTransport(): NetiflyTransport {
  const subscribers = new Set<UserId>();
  const claims = new Map<string, number>(); // key -> epoch ms the claim expires at
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
        queueMicrotask(() => {
          try {
            onMessageCb?.(userId, message);
          } catch (error) {
            onErrorCb?.(error instanceof Error ? error : new Error(String(error)));
          }
        });
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

    async claim(key, ttlSeconds) {
      const now = Date.now();
      const expiresAt = claims.get(key);
      if (expiresAt !== undefined && expiresAt > now) {
        return false;
      }
      claims.set(key, now + ttlSeconds * 1000);
      return true;
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
      claims.clear();
      onMessageCb = undefined;
      onErrorCb = undefined;
    },
  };
}
