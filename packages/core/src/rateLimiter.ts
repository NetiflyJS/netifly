/**
 * A simple continuous-refill token bucket, one per WebSocket connection, used
 * to bound how many inbound client frames (ack/read/response) a single
 * connection may send per second (see NOT-30 spec §9). `now` is an injectable
 * clock, defaulting to `Date.now()`, purely so tests can be deterministic
 * without real sleeps.
 */
export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private tokens: number;
  private lastRefillAt: number;

  constructor(ratePerSecond: number, now: number = Date.now()) {
    this.capacity = ratePerSecond;
    this.refillPerMs = ratePerSecond / 1000;
    this.tokens = ratePerSecond;
    this.lastRefillAt = now;
  }

  tryRemoveToken(now: number = Date.now()): boolean {
    const elapsedMs = Math.max(0, now - this.lastRefillAt);
    this.tokens = Math.min(this.capacity, this.tokens + elapsedMs * this.refillPerMs);
    this.lastRefillAt = now;

    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }
}
