import type { NetiflyTransport, UserId } from '../types';

/**
 * A single-process, dependency-free NetiflyTransport for local development
 * and tests — no Redis required (NOT-20 design spec §8). Models exactly one
 * process: `receivers()` here means "subscribed on this process," not
 * cluster-wide presence.
 */

interface SubscriberCallback {
  cb: ((userId: UserId, message: string) => void) | undefined;
}

const globalSubscriptions = new Map<UserId, Map<string, SubscriberCallback>>();
let instanceCounter = 0;

export function memoryTransport(): NetiflyTransport {
  const id = `instance-${instanceCounter++}`;
  const callbackRef: SubscriberCallback = { cb: undefined };
  let onErrorCb: ((error: Error) => void) | undefined;

  return {
    async subscribe(userId) {
      if (!globalSubscriptions.has(userId)) {
        globalSubscriptions.set(userId, new Map());
      }
      globalSubscriptions.get(userId)!.set(id, callbackRef);
    },

    async unsubscribe(userId) {
      globalSubscriptions.get(userId)?.delete(id);
      if (globalSubscriptions.get(userId)?.size === 0) {
        globalSubscriptions.delete(userId);
      }
    },

    async publish(userId, message) {
      const receivers = globalSubscriptions.get(userId)?.size ?? 0;
      if (receivers > 0) {
        // Delivered asynchronously, not in the same tick as publish() —
        // code/tests written against one transport must not accidentally
        // depend on timing behavior that only this transport happens to
        // provide (NOT-20 design spec §8).
        queueMicrotask(() => {
          globalSubscriptions.get(userId)?.forEach((subscriberRef) => {
            subscriberRef.cb?.(userId, message);
          });
        });
      }
      return { receivers };
    },

    async receivers(userIds) {
      const counts: Record<UserId, number> = {};
      for (const userId of userIds) {
        counts[userId] = globalSubscriptions.get(userId)?.size ?? 0;
      }
      return counts;
    },

    onMessage(cb) {
      callbackRef.cb = cb;
    },

    // Realistically never invoked — there is no background connection that
    // can fail for an in-memory transport. Exists to satisfy the interface.
    onError(cb) {
      onErrorCb = cb;
    },

    async close() {
      for (const subscribers of globalSubscriptions.values()) {
        subscribers.delete(id);
      }
      for (const [userId, subscribers] of globalSubscriptions) {
        if (subscribers.size === 0) {
          globalSubscriptions.delete(userId);
        }
      }
      callbackRef.cb = undefined;
      onErrorCb = undefined;
    },
  };
}
