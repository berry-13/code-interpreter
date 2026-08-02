/*
 * Shared connection-rate limiter.
 *
 * Lives in its own module because both socket proxies need it and
 * tool-call-socket-proxy.ts carries a `require.main === module` entrypoint
 * block — importing that file for one helper would drag a CLI into whatever
 * imports it. tool-call-socket-proxy.ts re-exports these names so its existing
 * API and tests are unchanged.
 */

/** Monotonic-ish token bucket. Tokens refill continuously at a configured
 * rate up to a burst cap. `tryConsume()` returns false instead of waiting
 * when empty — callers drop the connection synchronously, which is the
 * right behavior for a SOCK_STREAM accept handler (queuing in JS would
 * still hold the kernel socket struct alive, defeating the point). */
export interface TokenBucket {
  tryConsume(): boolean;
  tokens(): number;
}

export function createTokenBucket(opts: {
  burst: number;
  refillPerSec: number;
  now?: () => number;
}): TokenBucket {
  const now = opts.now ?? Date.now;
  const refillPerMs = opts.refillPerSec / 1000;
  let tokens = opts.burst;
  let last = now();

  function refill(): void {
    const t = now();
    const elapsed = t - last;
    if (elapsed <= 0) return;
    tokens = Math.min(opts.burst, tokens + elapsed * refillPerMs);
    last = t;
  }

  return {
    tryConsume(): boolean {
      refill();
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      return false;
    },
    tokens(): number {
      refill();
      return tokens;
    },
  };
}
