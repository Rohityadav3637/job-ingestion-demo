// fetcher/rateLimiter.js
//
// WHY THIS FILE EXISTS:
// Two separate problems, both about WHEN we send requests rather than what we
// send.
//
// PROBLEM 1 -- volume. We must not exceed a rate the source is willing to
// serve. Solved with a token bucket.
//
// PROBLEM 2 -- rhythm. Even at a polite average rate, requests spaced at
// exactly 3.000s look like nothing a human ever produced. The variance of our
// inter-request intervals is itself a fingerprint, and it is cheap for a server
// to compute. Solved with jitter.
//
// THE TOKEN BUCKET, IN ONE PARAGRAPH:
// A bucket holds at most `capacity` tokens and refills continuously at
// `refillPerMinute`. Every request must take one token; if the bucket is empty
// the caller waits for one to drip in. The two properties that make this the
// standard choice: you can BURST up to capacity after being idle, but your
// long-run average can never exceed the refill rate. A fixed "sleep N seconds"
// gives you the average but forbids the burst. A plain counter gives you the
// burst but no long-run ceiling. The bucket gives you both.

/** Promise-based sleep. Used everywhere we need to wait without blocking. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A random delay in [min, max).
 *
 * WHY UNIFORM RANDOM, AND WHAT IT DOES NOT ACHIEVE:
 * Uniform is a large improvement over a constant delay -- it gives our
 * interval distribution real spread instead of near-zero variance. It is NOT
 * indistinguishable from human traffic, which is closer to log-normal: mostly
 * short gaps with a long tail. Modelling that properly is not worth the
 * complexity here, and pretending uniform is undetectable would be the kind of
 * overclaim this project is trying to avoid. It is written up in DESIGN.md.
 */
export function randomJitter({ min, max }) {
  if (max <= min) return min;
  return Math.floor(min + Math.random() * (max - min));
}

export class TokenBucket {
  constructor({ capacity, refillPerMinute }) {
    this.capacity = capacity;

    // Stored per-millisecond so refill is a plain multiplication by elapsed
    // time. Working in per-minute units here would mean dividing by 60000 on
    // every single refill for no benefit.
    this.refillPerMs = refillPerMinute / 60000;

    // Start full. A freshly booted process has not made any requests, so
    // there is no reason to make it wait for its first one.
    this.tokens = capacity;
    this.lastRefill = Date.now();

    // Set by pauseUntil(). A source telling us Retry-After should silence the
    // whole source, not just the one request that got the 429.
    this.pausedUntil = 0;

    // Requests queue up here so that two concurrent callers cannot both look
    // at the same single token and both decide it is theirs. Explained at
    // acquire() below.
    this.queue = Promise.resolve();

    // Observability -- surfaced on the dashboard so waiting is visible rather
    // than looking like the app has hung.
    this.totalWaitedMs = 0;
    this.grantCount = 0;
  }

  /**
   * Add the tokens that have accrued since we last looked.
   *
   * WHY LAZY REFILL INSTEAD OF A setInterval TIMER:
   * A timer ticking every 100ms for every source keeps the event loop busy
   * forever, even when nothing is being fetched, and it would keep the process
   * alive. Computing the tokens from elapsed time on demand gives an identical
   * result with no background work. Fewer moving parts, and nothing to leak.
   */
  refill(now = Date.now()) {
    const elapsedMs = Math.max(0, now - this.lastRefill);
    this.lastRefill = now;

    // Cap at capacity: an idle bucket must not accumulate a week of tokens and
    // then release a thousand requests at once. That cap is the entire reason
    // the long-run average holds.
    this.tokens = Math.min(this.capacity, this.tokens + elapsedMs * this.refillPerMs);
  }

  /** How long until a whole token exists, in ms. 0 if one is available now. */
  msUntilToken(now = Date.now()) {
    const pauseRemaining = Math.max(0, this.pausedUntil - now);
    if (pauseRemaining > 0) return pauseRemaining;
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.refillPerMs);
  }

  /**
   * Silence this source until a moment in time.
   *
   * Called when a 429 arrives with a Retry-After header. Applying it to the
   * bucket rather than to the individual retry means EVERY subsequent request
   * to this source respects it -- including the next scheduled ingest run.
   * Honouring Retry-After on only the failed request would let the very next
   * request walk straight back into the limit.
   */
  pauseUntil(timestampMs) {
    this.pausedUntil = Math.max(this.pausedUntil, timestampMs);
  }

  /**
   * Wait until a token is available, then consume it.
   * Resolves to the number of ms spent waiting (0 if it was immediate).
   *
   * WHY THE PROMISE QUEUE:
   * Suppose one token is left and two requests call acquire() at the same
   * moment. Both would refill, both would see tokens >= 1, and both would
   * subtract 1 -- leaving -1 tokens and two requests already sent. JavaScript
   * being single-threaded does not save us here, because there is an `await`
   * in the middle: the first caller suspends at the await and the second runs
   * before it resumes.
   *
   * Chaining every acquisition onto `this.queue` makes them strictly
   * sequential: caller two does not even look at the bucket until caller one
   * has finished taking its token. This is a mutex, built out of the one
   * primitive we already have.
   */
  acquire() {
    const run = async () => {
      const startedAt = Date.now();

      this.refill();
      const waitMs = this.msUntilToken();

      if (waitMs > 0) {
        await sleep(waitMs);
        // Refill again after sleeping -- time passed, so tokens accrued.
        this.refill();
      }

      // Guard against floating-point dust. refillPerMs is a fraction, so
      // repeated addition can land on 0.9999999999 instead of 1. Without this
      // the bucket could go very slightly negative and stall.
      this.tokens = Math.max(0, this.tokens - 1);

      const actualWait = Date.now() - startedAt;
      this.totalWaitedMs += actualWait;
      this.grantCount += 1;
      return actualWait;
    };

    // `.then(run, run)` rather than `.then(run)` so that a rejection earlier in
    // the chain does not permanently wedge the bucket for every later caller.
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  /** Read-only snapshot for the dashboard. */
  describe(now = Date.now()) {
    // Deliberately does not mutate: calling this from an HTTP handler must not
    // change limiter state, or reading the dashboard would alter the system
    // it is reporting on.
    const elapsedMs = Math.max(0, now - this.lastRefill);
    const projected = Math.min(this.capacity, this.tokens + elapsedMs * this.refillPerMs);

    return {
      capacity: this.capacity,
      tokensAvailable: Math.floor(projected),
      pausedForMs: Math.max(0, this.pausedUntil - now),
      totalWaitedMs: this.totalWaitedMs,
      grantCount: this.grantCount,
    };
  }
}

// --------------------------------------------------------------------------
// One bucket per source.
//
// Per source rather than global, because the limits belong to the source: our
// polite rate for a small volunteer-run API is not the same as for a
// CDN-backed one, and a slow source must not consume the budget of a fast one.
// --------------------------------------------------------------------------

const buckets = new Map();

export function getBucket(sourceId, rateLimit) {
  let bucket = buckets.get(sourceId);
  if (!bucket) {
    bucket = new TokenBucket(rateLimit);
    buckets.set(sourceId, bucket);
  }
  return bucket;
}

export function describeBucket(sourceId) {
  const bucket = buckets.get(sourceId);
  return bucket ? bucket.describe() : null;
}

/** Used by tests to get a clean slate. */
export function resetBuckets() {
  buckets.clear();
}

/**
 * The single call the fetcher makes before every request: wait for a token,
 * then pause a random extra moment.
 *
 * ORDER MATTERS. Jitter comes AFTER the token is granted, not before. If we
 * jittered first, the random pause would often overlap with time the bucket
 * was refilling anyway, and the jitter would frequently be absorbed into the
 * wait rather than adding spread to it. Jittering after the grant guarantees
 * the delay is genuinely applied to every request.
 */
export async function pace(sourceId, { rateLimit, jitterMs }) {
  const bucket = getBucket(sourceId, rateLimit);
  const rateLimitWaitMs = await bucket.acquire();

  const jitterWaitMs = randomJitter(jitterMs);
  await sleep(jitterWaitMs);

  return { rateLimitWaitMs, jitterWaitMs, totalWaitMs: rateLimitWaitMs + jitterWaitMs };
}
