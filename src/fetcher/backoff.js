// fetcher/backoff.js
//
// WHY THIS FILE EXISTS:
// Deciding WHETHER to try again, and HOW LONG to wait first.
//
// EXPONENTIAL BACKOFF is the obvious half: fail, wait 500ms; fail again, wait
// 1s, 2s, 4s. Back off quickly so a struggling server gets room to recover
// instead of a beating.
//
// THE JITTER IS THE PART THAT ACTUALLY MATTERS. Imagine a source is down for
// 30 seconds and every client uses the same doubling schedule. They all retry
// at t+0.5s together, all fail together, all retry at t+1s together. The
// server recovers and is instantly flattened by everybody's simultaneous
// retry, so it goes down again. Backoff without randomness does not spread
// load out -- it ORGANISES it. That is the thundering herd, and it is a real
// way that short outages become long ones.
//
// Three known variants:
//   no jitter    -> base * 2^n                  full synchronisation
//   equal jitter -> half + random(0, half)      halves the clumping
//   full jitter  -> random(0, base * 2^n)       what we use
//
// Full jitter samples across the WHOLE window. AWS published measurements
// showing it gives the lowest contention and, counterintuitively, the fastest
// overall completion, because clients stop colliding with one another.
//
// A NOTE ON THE SHAPE OF THIS FILE:
// Every function here is pure -- no network, no clock it does not accept as an
// argument, no state. That is deliberate. Retry logic is exactly the kind of
// code that is painful to test if it reaches for Date.now() internally, and
// exactly the kind of code you cannot afford to get wrong. Passing `now` in
// means the tests are instant and deterministic instead of needing sleeps or
// mocked timers.

/**
 * Which HTTP statuses are worth trying again?
 *
 * RETRYABLE -- the request might succeed unchanged if we simply wait:
 *   408 Request Timeout, 425 Too Early, 429 Too Many Requests,
 *   500/502/503/504 -- server-side faults, usually transient.
 *
 * NOT RETRYABLE -- repeating the identical request cannot help:
 *   400 Bad Request, 401/403 (an auth or access decision, not a hiccup),
 *   404 Not Found, 410 Gone.
 *
 * 403 IS THE INTERESTING CASE. It is not retryable, because sending the same
 * request again will earn the same 403. But it is also the classic "you have
 * been blocked" signal, so it warrants a different response entirely: rotate
 * identity and let the circuit breaker count it. That decision lives in the
 * fetcher (stage 6), not here -- this function answers only the narrow
 * question "would waiting and repeating this request help?".
 */
export function isRetryableStatus(status) {
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

/**
 * Network-level errors are retryable; programming errors are not.
 *
 * A dropped socket, a DNS blip or our own timeout are all transient and worth
 * another attempt. A TypeError is a bug in our code, and retrying a bug just
 * produces the same bug three times while hiding it behind a delay.
 */
export function isRetryableError(error) {
  if (!error) return false;

  // AbortError is what our own timeout produces (see httpClient, stage 6).
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;

  // Node surfaces socket/DNS problems as a `cause` with a code.
  const code = error.code || (error.cause && error.cause.code);
  const retryableCodes = [
    'ECONNRESET',   // connection dropped mid-flight
    'ECONNREFUSED', // nothing listening (yet)
    'ETIMEDOUT',    // OS-level timeout
    'ENOTFOUND',    // DNS lookup failed -- often transient
    'EAI_AGAIN',    // DNS temporary failure, explicitly retryable
    'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
  ];
  if (code && retryableCodes.includes(code)) return true;

  // Node's fetch wraps essentially every transport failure in this message.
  // Matching on a string is fragile, so it is the LAST check rather than the
  // first, and everything above catches the cases we can identify properly.
  return error.message === 'fetch failed';
}

/**
 * Parse a Retry-After header into milliseconds from now.
 *
 * The spec allows two completely different formats and servers use both:
 *   Retry-After: 120                                  (delta in SECONDS)
 *   Retry-After: Wed, 19 Aug 2026 07:28:00 GMT        (an HTTP date)
 *
 * Returns null when absent or unparseable, so the caller falls back to
 * computed backoff rather than treating a malformed header as "retry now".
 *
 * Note the seconds-to-milliseconds conversion. Reading `Retry-After: 120` as
 * 120ms is a genuinely easy mistake, and it turns respecting a rate limit into
 * hammering straight through one.
 */
export function parseRetryAfter(headerValue, now = Date.now()) {
  if (headerValue === null || headerValue === undefined) return null;

  const raw = String(headerValue).trim();
  if (raw === '') return null;

  // Form 1: delta-seconds.
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return null;
    return Math.round(seconds * 1000);
  }

  // Form 2: an HTTP date.
  const timestamp = Date.parse(raw);
  if (Number.isNaN(timestamp)) return null;

  // A date already in the past means "you may retry now", not "travel back in
  // time". Clamp at zero rather than returning a negative delay, which would
  // flow into setTimeout and fire immediately anyway but read as a bug.
  return Math.max(0, timestamp - now);
}

/**
 * Full-jitter exponential backoff.
 *
 * `attempt` is 0-based: 0 is the wait before the FIRST retry.
 *
 *   window = min(maxDelayMs, baseDelayMs * 2^attempt)
 *   delay  = random(0, window)
 *
 * The `random` parameter is injectable purely so tests can pin it to 0 and 1
 * and assert the window boundaries exactly, instead of asserting something
 * vague about a random number.
 */
export function computeBackoffMs(attempt, { baseDelayMs, maxDelayMs }, random = Math.random) {
  const exponentialWindow = baseDelayMs * Math.pow(2, Math.max(0, attempt));

  // The cap matters: without it, attempt 20 would be base * 1,048,576 -- about
  // six days. Growth has to stop somewhere sane.
  const window = Math.min(maxDelayMs, exponentialWindow);

  return Math.floor(random() * window);
}

/**
 * The single decision the fetcher asks for after a failed attempt:
 * do we retry, and if so, after how long?
 *
 * Returns { retry: boolean, delayMs: number, reason: string }.
 *
 * PRECEDENCE, AND WHY:
 * 1. Out of attempts             -> stop. A budget that bends is not a budget.
 * 2. Not retryable               -> stop. Repeating a 404 cannot fix it.
 * 3. Retry-After present         -> obey it. The server told us exactly when
 *                                   to come back; guessing would be rude and
 *                                   would earn a harder block.
 * 4. Retry-After absurdly large  -> stop and hand the problem to the circuit
 *                                   breaker. See the note below.
 * 5. Otherwise                   -> full-jitter exponential backoff.
 *
 * ON RULE 4: a server can answer "Retry-After: 86400". Obeying literally would
 * park that source for a day while the dashboard cheerfully showed it as
 * "waiting" -- a pipeline that has silently stopped, which is the exact
 * failure mode this project exists to prevent. Past the ceiling we stop
 * retrying and let the breaker open, which the dashboard reports honestly as
 * CIRCUIT-OPEN with the reason attached.
 */
export function decideRetry({
  attempt,
  maxAttempts,
  status = null,
  error = null,
  retryAfterHeader = null,
  policy,
  now = Date.now(),
  random = Math.random,
}) {
  // `attempt` is 0-based and counts attempts already MADE, so with
  // maxAttempts: 3 the valid retry attempts are 0, 1 -- three total tries.
  if (attempt >= maxAttempts - 1) {
    return { retry: false, delayMs: 0, reason: `exhausted ${maxAttempts} attempts` };
  }

  const retryable = error ? isRetryableError(error) : isRetryableStatus(status);
  if (!retryable) {
    return {
      retry: false,
      delayMs: 0,
      reason: error ? `non-retryable error: ${error.message}` : `non-retryable status ${status}`,
    };
  }

  const retryAfterMs = parseRetryAfter(retryAfterHeader, now);
  if (retryAfterMs !== null) {
    if (retryAfterMs > policy.maxRetryAfterMs) {
      return {
        retry: false,
        delayMs: 0,
        reason: `Retry-After ${Math.round(retryAfterMs / 1000)}s exceeds our ${Math.round(
          policy.maxRetryAfterMs / 1000,
        )}s ceiling; handing over to circuit breaker`,
      };
    }
    // Obeying a long Retry-After by sleeping here would stall the whole
    // ingest run -- and it is redundant, because the caller has already
    // paused this source's token bucket for the same duration. The pause is
    // the better instrument: durable, applies to every later request, and it
    // does not block the other sources. So we stop retrying and let pacing
    // plus the next scheduled run serve out the wait.
    if (retryAfterMs > policy.maxInRunWaitMs) {
      return {
        retry: false,
        delayMs: 0,
        reason: `Retry-After ${Math.round(retryAfterMs / 1000)}s honoured by pausing the source; deferring to the next scheduled run rather than stalling this one`,
      };
    }

    return { retry: true, delayMs: retryAfterMs, reason: 'honouring Retry-After header' };
  }

  return {
    retry: true,
    delayMs: computeBackoffMs(attempt, policy, random),
    reason: 'full-jitter exponential backoff',
  };
}
