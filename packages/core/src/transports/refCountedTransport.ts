import type { NetiflyTransport, UserId } from '../types';

/**
 * Ref-counts subscribe()/unsubscribe() per userId on top of any raw
 * NetiflyTransport, so overlapping callers (e.g. two WebSocket connections
 * for the same user) can never tear down each other's subscription (NOT-5).
 * The wrapped transport's own subscribe()/unsubscribe() are called only on
 * the first-in/last-out transition — every other method passes straight
 * through unchanged. `createNetifly()` always wraps whichever raw transport
 * it ends up with in this class; it is not exported from `index.ts` — it's
 * internal wiring, not part of the public transport contract (NOT-20 design
 * spec §5).
 */
export class RefCountedTransport implements NetiflyTransport {
  private readonly refCounts = new Map<UserId, number>();

  constructor(private readonly raw: NetiflyTransport) {}

  async subscribe(userId: UserId): Promise<void> {
    const count = this.refCounts.get(userId) ?? 0;
    this.refCounts.set(userId, count + 1);
    if (count > 0) return; // someone else already holds this open

    try {
      await this.raw.subscribe(userId);
    } catch (error) {
      const current = this.refCounts.get(userId) ?? 1;
      if (current <= 1) this.refCounts.delete(userId);
      else this.refCounts.set(userId, current - 1);
      throw error;
    }
  }

  async unsubscribe(userId: UserId): Promise<void> {
    const count = this.refCounts.get(userId) ?? 0;
    if (count <= 1) {
      this.refCounts.delete(userId);
      if (count === 1) {
        await this.raw.unsubscribe(userId);
      }
      return;
    }
    this.refCounts.set(userId, count - 1);
  }

  publish(userId: UserId, message: string): Promise<{ receivers: number }> {
    return this.raw.publish(userId, message);
  }

  receivers(userIds: UserId[]): Promise<Record<UserId, number>> {
    return this.raw.receivers(userIds);
  }

  onMessage(cb: (userId: UserId, message: string) => void): void {
    this.raw.onMessage(cb);
  }

  onError(cb: (error: Error) => void): void {
    this.raw.onError(cb);
  }

  async close(): Promise<void> {
    this.refCounts.clear();
    await this.raw.close();
  }
}
