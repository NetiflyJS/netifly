import { TokenBucket } from './rateLimiter';

describe('TokenBucket', () => {
  it('allows up to ratePerSecond attempts at the same instant', () => {
    const bucket = new TokenBucket(5, 0);
    for (let i = 0; i < 5; i++) {
      expect(bucket.tryRemoveToken(0)).toBe(true);
    }
    expect(bucket.tryRemoveToken(0)).toBe(false);
  });

  it('refills to full capacity after a full second has elapsed', () => {
    const bucket = new TokenBucket(3, 0);
    expect(bucket.tryRemoveToken(0)).toBe(true);
    expect(bucket.tryRemoveToken(0)).toBe(true);
    expect(bucket.tryRemoveToken(0)).toBe(true);
    expect(bucket.tryRemoveToken(0)).toBe(false);

    expect(bucket.tryRemoveToken(1000)).toBe(true);
    expect(bucket.tryRemoveToken(1000)).toBe(true);
    expect(bucket.tryRemoveToken(1000)).toBe(true);
    expect(bucket.tryRemoveToken(1000)).toBe(false);
  });

  it('refills partially, proportional to elapsed time', () => {
    const bucket = new TokenBucket(10, 0);
    for (let i = 0; i < 10; i++) {
      expect(bucket.tryRemoveToken(0)).toBe(true);
    }
    expect(bucket.tryRemoveToken(0)).toBe(false);

    // 500ms at 10/sec refills ~5 tokens.
    expect(bucket.tryRemoveToken(500)).toBe(true);
    expect(bucket.tryRemoveToken(500)).toBe(true);
    expect(bucket.tryRemoveToken(500)).toBe(true);
    expect(bucket.tryRemoveToken(500)).toBe(true);
    expect(bucket.tryRemoveToken(500)).toBe(true);
    expect(bucket.tryRemoveToken(500)).toBe(false);
  });

  it('always rejects when configured with a rate of 0', () => {
    const bucket = new TokenBucket(0, 0);
    expect(bucket.tryRemoveToken(0)).toBe(false);
    expect(bucket.tryRemoveToken(1000)).toBe(false);
  });
});
