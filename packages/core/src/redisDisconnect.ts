import type Redis from 'ioredis';

/**
 * Safety margin above ioredis's own `disconnectTimeout` (default 2000ms —
 * see below) before we give up waiting for a graceful `'end'`.
 */
const FALLBACK_BUFFER_MS = 500;
const IOREDIS_DEFAULT_DISCONNECT_TIMEOUT_MS = 2000;

/**
 * Disconnects an ioredis client and waits for it to actually finish closing,
 * rather than firing `disconnect()` and moving on.
 *
 * `disconnect()` itself is fire-and-forget: it calls the underlying socket's
 * `end()` and arms ioredis's own fallback timer (`options.disconnectTimeout`,
 * default 2000ms) that force-`destroy()`s the socket if it hasn't closed on
 * its own — cleared only once the socket's own `'close'` event fires. If
 * nothing waits for that, the timer can still be armed at the moment a
 * caller considers shutdown complete — in a test suite, that's exactly what
 * Jest's own end-of-run open-handle check can catch, producing "Jest did not
 * exit" / `--detectOpenHandles` noise, even for a handle that was always
 * going to clear itself shortly after.
 *
 * ioredis emits its own `'end'` event once a connection is fully, finally
 * closed — which happens after that fallback timer has already been
 * cleared — so awaiting it here is what actually closes the race, for a
 * connection that closes normally.
 *
 * For a connection that never established a healthy socket (e.g. still
 * retrying against an unreachable host — see `redisRouter.test.ts`'s
 * "surfaces connection errors" case), the underlying stream may not be able
 * to end gracefully at all, and ioredis's own fallback timer is what
 * eventually force-destroys it — `'end'` only fires once that happens. This
 * is bounded by a fallback here too, so `close()` can't hang forever, but
 * that bound is deliberately set *past* ioredis's own `disconnectTimeout`
 * (using the client's actual configured value, not a hardcoded guess) so our
 * own fallback never fires first and leaves ioredis's timer still pending —
 * that mismatch was the exact bug this function exists to fix, verified via
 * `--detectOpenHandles` before and after.
 */
export function disconnectRedis(redis: Redis): Promise<void> {
  if (redis.status === 'end') {
    return Promise.resolve();
  }

  const ioredisDisconnectTimeout =
    redis.options.disconnectTimeout ?? IOREDIS_DEFAULT_DISCONNECT_TIMEOUT_MS;
  const timeoutMs = ioredisDisconnectTimeout + FALLBACK_BUFFER_MS;

  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    redis.once('end', () => {
      clearTimeout(timer);
      resolve();
    });
    redis.disconnect();
  });
}
