// fetcher/httpClient.js
//
// WHY THIS FILE EXISTS:
// Stages 2-5 each solved one problem in isolation: identity, pacing, retry,
// breaker. This file is the only place they are composed, and it exposes ONE
// function to the rest of the app.
//
// That is the central design bet of the project. An adapter (stage 7) knows
// its URL and its field names, and nothing else. It does not know that rate
// limiting exists, or retries, or identities, or chaos. So adding a fourth
// source is roughly forty lines and it inherits the entire safety net for
// free -- and, just as importantly, a rushed new adapter CANNOT accidentally
// skip the polite behaviour, because there is no unprotected way to make a
// request in this codebase.
//
// THE ORDER OF THE LAYERS IS THE DESIGN. Reading downwards:
//
//   1. BREAKER   -- may we talk to this source at all? Cheapest check first:
//                   it can reject in microseconds with no request and no wait.
//                   Pacing before this would mean waiting a second and a half
//                   for permission to do nothing.
//   2. PACE      -- token bucket, then jitter. We now intend to send.
//   3. IDENTITY  -- who are we this time.
//   4. CHAOS     -- one line: injected response, or the real thing.
//   5. FETCH     -- with a timeout.
//   6. CLASSIFY  -- 429 pauses the bucket, 403 rotates identity.
//   7. RETRY     -- backoff decides; loop or give up.
//   8. REPORT    -- tell the breaker what happened. Non-negotiable: a breaker
//                   that is not told about failures is a breaker that never
//                   trips.

import { config } from '../config.js';
import { getIdentity, rotateIdentity, buildHeaders } from './identities.js';
import { pace, getBucket } from './rateLimiter.js';
import { decideRetry, parseRetryAfter } from './backoff.js';
import { getBreaker } from './circuitBreaker.js';
import { sleep } from './rateLimiter.js';
import * as chaos from '../chaos.js';

/**
 * The outcome vocabulary of this project.
 *
 * WHY THESE ARE NOT JUST `ok: true/false`:
 * A boolean cannot tell "we were blocked" apart from "there genuinely are no
 * jobs today", and those demand opposite responses -- one should page someone,
 * the other is Tuesday. Every one of these names ends up visible on the
 * dashboard, so the screen distinguishes them too.
 */
export const OUTCOME = {
  OK: 'OK',                       // 2xx with a body
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',   // never sent; breaker refused
  RATE_LIMITED: 'RATE_LIMITED',   // 429
  BLOCKED: 'BLOCKED',             // 403 / 401 -- an access decision about us
  SERVER_ERROR: 'SERVER_ERROR',   // 5xx
  CLIENT_ERROR: 'CLIENT_ERROR',   // other 4xx -- usually our bug, not theirs
  TIMEOUT: 'TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
};

/** Map an HTTP status onto our vocabulary. */
function classifyStatus(status) {
  if (status >= 200 && status < 300) return OUTCOME.OK;
  if (status === 429) return OUTCOME.RATE_LIMITED;
  if (status === 403 || status === 401) return OUTCOME.BLOCKED;
  if (status >= 500) return OUTCOME.SERVER_ERROR;
  return OUTCOME.CLIENT_ERROR;
}

function classifyError(error) {
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return OUTCOME.TIMEOUT;
  return OUTCOME.NETWORK_ERROR;
}

/**
 * Fetch a URL with the full resilience stack applied.
 *
 * Returns a result object -- it does NOT throw. Callers are the pipeline and
 * adapters, and for them a failed fetch is an expected, describable event, not
 * an exception. Throwing would push every caller into try/catch and, worse,
 * would make it easy to catch broadly and lose the outcome distinction that
 * this project is built around.
 *
 *   {
 *     ok, outcome, status, bodyText,
 *     meta: { attempts, identity, waits, chaosMode, durationMs, notes[] }
 *   }
 */
export async function resilientFetch(sourceId, url, options = {}) {
  const settings = {
    ...config.defaults,
    ...options,
    // Nested objects need explicit merging: a spread is shallow, so an adapter
    // overriding only `rateLimit.capacity` would otherwise wipe out
    // `refillPerMinute` entirely and silently.
    rateLimit: { ...config.defaults.rateLimit, ...(options.rateLimit || {}) },
    jitterMs: { ...config.defaults.jitterMs, ...(options.jitterMs || {}) },
    retry: { ...config.defaults.retry, ...(options.retry || {}) },
    breaker: { ...config.defaults.breaker, ...(options.breaker || {}) },
  };

  const breaker = getBreaker(sourceId, settings.breaker);
  const bucket = getBucket(sourceId, settings.rateLimit);
  const startedAt = Date.now();

  // A running commentary of what happened, surfaced on the dashboard. When a
  // source misbehaves I want to read the story, not guess it from a status
  // code.
  const notes = [];
  const meta = {
    attempts: 0,
    identity: null,
    chaosMode: chaos.isArmed(sourceId) ? 'armed' : null,
    totalWaitMs: 0,
    notes,
  };

  // --- LAYER 1: may we talk to this source at all? -------------------------
  // First, because it is the only check that can say no for free.
  const gate = breaker.canRequest();
  if (!gate.allowed) {
    notes.push(gate.reason);
    return {
      ok: false,
      outcome: OUTCOME.CIRCUIT_OPEN,
      status: null,
      bodyText: null,
      meta: {
        ...meta,
        breakerState: gate.state,
        retryInMs: gate.retryInMs,
        durationMs: Date.now() - startedAt,
      },
    };
  }
  if (gate.isProbe) notes.push('circuit half-open: this request is the recovery probe');

  let lastOutcome = OUTCOME.NETWORK_ERROR;
  let lastStatus = null;

  for (let attempt = 0; attempt < settings.retry.maxAttempts; attempt += 1) {
    meta.attempts = attempt + 1;

    // --- LAYER 2: pacing -------------------------------------------------
    const waited = await pace(sourceId, settings);
    meta.totalWaitMs += waited.totalWaitMs;

    // --- LAYER 3: identity -----------------------------------------------
    const identity = getIdentity(sourceId, settings.identityMode);
    meta.identity = { id: identity.id, label: identity.label, uses: identity.uses };
    const headers = buildHeaders(identity, { accept: settings.accept });

    let response;
    try {
      // --- LAYER 4 + 5: chaos or the real network --------------------------
      // The entire chaos integration is this one expression. Everything below
      // runs identically for injected and real responses, which is why the
      // demo exercises the real code path rather than a test-only branch.
      const injected = chaos.intercept(sourceId);
      if (injected) {
        response = injected;
        meta.chaosMode = injected.headers.get('x-chaos-injected');
        notes.push(`chaos injected: ${meta.chaosMode} (no request sent to the real source)`);
      } else {
        response = await fetch(url, {
          headers,
          // AbortSignal.timeout is the built-in way to bound a request. Without
          // it, one stalled socket hangs the whole ingest run indefinitely --
          // which presents as "still running" rather than "broken", the exact
          // silent failure this project exists to prevent.
          signal: AbortSignal.timeout(settings.timeoutMs),
          redirect: 'follow',
        });
      }
    } catch (error) {
      lastOutcome = classifyError(error);
      lastStatus = null;
      notes.push(`attempt ${attempt + 1}: ${lastOutcome} (${error.message})`);

      const decision = decideRetry({
        attempt,
        maxAttempts: settings.retry.maxAttempts,
        error,
        policy: settings.retry,
      });
      if (!decision.retry) {
        notes.push(decision.reason);
        break;
      }
      notes.push(`retrying in ${decision.delayMs}ms (${decision.reason})`);
      await sleep(decision.delayMs);
      continue;
    }

    lastStatus = response.status;
    lastOutcome = classifyStatus(response.status);

    // --- LAYER 6: react to WHY we failed, not just THAT we failed ---------

    if (lastOutcome === OUTCOME.RATE_LIMITED) {
      // Apply Retry-After to the BUCKET, so it silences every later request to
      // this source too -- including the next scheduled run. Honouring it on
      // this one request only would let the very next request walk straight
      // back into the same limit.
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      if (retryAfterMs !== null) {
        bucket.pauseUntil(Date.now() + retryAfterMs);
        notes.push(`Retry-After ${Math.round(retryAfterMs / 1000)}s applied to the whole source`);
      }
    }

    if (lastOutcome === OUTCOME.BLOCKED) {
      // 403 is the classic "this identity is burned" signal. Retrying is
      // pointless (same request, same answer), but the NEXT request should
      // wear a different face. Rotating here rather than in backoff.js keeps
      // that decision next to the evidence that motivated it.
      const rotation = rotateIdentity(sourceId, `${response.status} blocked`);
      if (rotation) notes.push(`identity rotated ${rotation.from} -> ${rotation.to} after ${response.status}`);
    }

    if (lastOutcome === OUTCOME.OK) {
      const bodyText = await response.text();
      breaker.recordSuccess();
      return {
        ok: true,
        outcome: OUTCOME.OK,
        status: response.status,
        bodyText,
        meta: { ...meta, durationMs: Date.now() - startedAt },
      };
    }

    notes.push(`attempt ${attempt + 1}: HTTP ${response.status} -> ${lastOutcome}`);

    // --- LAYER 7: retry or give up ---------------------------------------
    const decision = decideRetry({
      attempt,
      maxAttempts: settings.retry.maxAttempts,
      status: response.status,
      retryAfterHeader: response.headers.get('retry-after'),
      policy: settings.retry,
    });
    if (!decision.retry) {
      notes.push(decision.reason);
      break;
    }
    notes.push(`retrying in ${decision.delayMs}ms (${decision.reason})`);
    await sleep(decision.delayMs);
  }

  // --- LAYER 8: report the failure -------------------------------------
  // Every failure path converges here. A breaker that is not told about
  // failures is a breaker that never trips, so this must be unconditional --
  // which is exactly why there is a single exit point rather than a `return`
  // scattered inside each failure branch above.
  const reason = lastStatus ? `${lastStatus} ${lastOutcome}` : lastOutcome;
  const trip = breaker.recordFailure(reason);
  if (trip.tripped) {
    notes.push(`CIRCUIT BREAKER TRIPPED -- pausing this source for ${Math.round(trip.cooldownMs / 1000)}s`);
  }

  return {
    ok: false,
    outcome: lastOutcome,
    status: lastStatus,
    bodyText: null,
    meta: {
      ...meta,
      breakerState: breaker.state,
      breakerTripped: trip.tripped,
      durationMs: Date.now() - startedAt,
    },
  };
}
