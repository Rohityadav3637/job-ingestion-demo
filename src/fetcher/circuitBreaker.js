// fetcher/circuitBreaker.js
//
// WHY THIS FILE EXISTS:
// Retries handle a HICCUP. A circuit breaker handles a CONDITION. They are
// different problems and conflating them is how pipelines end up hammering a
// source that has already told them to go away.
//
// THREE STATES:
//
//   CLOSED     normal. Requests flow. We count CONSECUTIVE failures.
//   OPEN       tripped. Requests are rejected instantly WITHOUT being sent.
//   HALF_OPEN  after a cooldown, exactly ONE probe is allowed through.
//              It succeeds -> CLOSED. It fails -> OPEN with a longer cooldown.
//
//        failures >= threshold          cooldown elapsed
//   CLOSED ------------------> OPEN ---------------------> HALF_OPEN
//     ^                         ^                              |
//     |                         |         probe fails          |
//     |                         +------------------------------+
//     |            probe succeeds                              |
//     +--------------------------------------------------------+
//
// WHY DELIBERATELY REFUSING TO TRY IS THE CORRECT MOVE:
//
// For the source -- it is already struggling, or has already told us to stop.
// More traffic makes both facts worse, and makes any block against us harder.
//
// For us -- every doomed request costs a full timeout. Fifteen seconds spent
// re-learning something we already knew. With three sources and one dead, the
// breaker turns a 45-second stall into an instant skip.
//
// AND THAT IS WHAT MAKES FAILOVER POSSIBLE. The pipeline (stage 8) asks the
// breaker before spending any time on a source. Hearing OPEN, it moves to a
// healthy source immediately rather than blocking. Without a breaker there is
// nothing to fail over ON.

import { config } from '../config.js';

export const STATE = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
};

export class CircuitBreaker {
  constructor(sourceId, settings = config.defaults.breaker) {
    this.sourceId = sourceId;
    this.settings = settings;

    this.state = STATE.CLOSED;

    // CONSECUTIVE, not cumulative. A source that fails once an hour is flaky,
    // not broken -- tripping on a running total would eventually trip on every
    // source that has ever been alive long enough. Any success resets this to
    // zero, which is what makes "consecutive" meaningful.
    this.consecutiveFailures = 0;

    this.openedAt = 0;
    this.reopenCount = 0;      // how many times a probe has failed
    this.lastFailureReason = null;
    this.lastStateChangeAt = Date.now();

    // Only one probe may be in flight in HALF_OPEN. Without this flag, three
    // sources polled concurrently would all be told "you may probe" and we
    // would send three requests to a source we believe is broken -- which is
    // precisely the traffic the breaker exists to prevent.
    this.probeInFlight = false;

    // Counters for the dashboard. A breaker that trips invisibly is no better
    // than no breaker at all.
    this.totalTrips = 0;
    this.totalRejected = 0;
  }

  /**
   * How long this cooldown lasts, given how many probes have already failed.
   *
   * Doubles each reopen: 60s, 120s, 240s... capped at maxOpenMs. A source
   * still down after three probes needs minutes, not seconds, and continuing
   * to ask every 60s is just a slower version of hammering it.
   */
  currentCooldownMs() {
    const escalated = this.settings.openMs * Math.pow(2, this.reopenCount);
    return Math.min(this.settings.maxOpenMs, escalated);
  }

  transitionTo(state) {
    if (this.state === state) return;
    this.state = state;
    this.lastStateChangeAt = Date.now();
  }

  /**
   * May we send a request right now?
   *
   * Returns { allowed, state, reason, retryInMs, isProbe }.
   *
   * Callers MUST report back via recordSuccess/recordFailure. `isProbe` is
   * true when this permission is the single HALF_OPEN probe -- the caller does
   * not need to treat it differently, but the dashboard shows it, because
   * "we are cautiously testing the water" and "everything is fine" deserve to
   * look different to a human reading the screen.
   *
   * NOTE: this method mutates (OPEN can become HALF_OPEN here). That is why
   * the dashboard uses describe() instead -- reading the screen must never
   * consume the one probe a real request should have had.
   */
  canRequest(now = Date.now()) {
    if (this.state === STATE.CLOSED) {
      return { allowed: true, state: this.state, isProbe: false, retryInMs: 0 };
    }

    if (this.state === STATE.OPEN) {
      const elapsed = now - this.openedAt;
      const cooldown = this.currentCooldownMs();

      if (elapsed < cooldown) {
        this.totalRejected += 1;
        return {
          allowed: false,
          state: STATE.OPEN,
          isProbe: false,
          retryInMs: cooldown - elapsed,
          reason: `circuit open after ${this.consecutiveFailures} consecutive failures (${this.lastFailureReason})`,
        };
      }

      // Cooldown served. Move to HALF_OPEN and let this caller be the probe.
      this.transitionTo(STATE.HALF_OPEN);
      this.probeInFlight = true;
      return { allowed: true, state: STATE.HALF_OPEN, isProbe: true, retryInMs: 0 };
    }

    // HALF_OPEN: exactly one probe at a time.
    if (this.probeInFlight) {
      this.totalRejected += 1;
      return {
        allowed: false,
        state: STATE.HALF_OPEN,
        isProbe: false,
        retryInMs: 0,
        reason: 'a probe is already in flight',
      };
    }

    this.probeInFlight = true;
    return { allowed: true, state: STATE.HALF_OPEN, isProbe: true, retryInMs: 0 };
  }

  /**
   * The request worked.
   *
   * Resets everything, including reopenCount -- a source that has recovered
   * gets a clean slate. Carrying the escalation forward would mean a source
   * that broke once last week is still punished with a 15-minute cooldown
   * today, which stops reflecting reality.
   */
  recordSuccess() {
    const wasOpen = this.state !== STATE.CLOSED;

    this.probeInFlight = false;
    this.consecutiveFailures = 0;
    this.reopenCount = 0;
    this.lastFailureReason = null;
    this.transitionTo(STATE.CLOSED);

    return { recovered: wasOpen };
  }

  /**
   * The request failed. `reason` is a short human string that ends up on the
   * dashboard -- "429 rate limited", "403 forbidden", "empty response".
   *
   * A failure during HALF_OPEN reopens IMMEDIATELY without waiting to count to
   * three again. We already had our evidence; the probe was the tiebreaker and
   * it came back negative. Counting to three again would send two more
   * requests we already know will fail.
   */
  recordFailure(reason, now = Date.now()) {
    this.lastFailureReason = reason;
    this.consecutiveFailures += 1;

    if (this.state === STATE.HALF_OPEN) {
      this.probeInFlight = false;
      this.reopenCount += 1;
      this.openedAt = now;
      this.transitionTo(STATE.OPEN);
      return { tripped: true, state: this.state, cooldownMs: this.currentCooldownMs() };
    }

    if (this.consecutiveFailures >= this.settings.failureThreshold && this.state === STATE.CLOSED) {
      this.openedAt = now;
      this.totalTrips += 1;
      this.transitionTo(STATE.OPEN);
      return { tripped: true, state: this.state, cooldownMs: this.currentCooldownMs() };
    }

    return { tripped: false, state: this.state, cooldownMs: 0 };
  }

  /**
   * Read-only snapshot for the dashboard.
   *
   * Crucially this does NOT transition OPEN -> HALF_OPEN the way canRequest()
   * does. If it did, loading the dashboard would consume the probe that a real
   * request should have used -- so watching the system would change it, and
   * the recovery you observed would not be the recovery that happened.
   */
  describe(now = Date.now()) {
    const cooldownMs = this.currentCooldownMs();
    const retryInMs =
      this.state === STATE.OPEN ? Math.max(0, cooldownMs - (now - this.openedAt)) : 0;

    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      failureThreshold: this.settings.failureThreshold,
      lastFailureReason: this.lastFailureReason,
      cooldownMs,
      retryInMs,
      reopenCount: this.reopenCount,
      totalTrips: this.totalTrips,
      totalRejected: this.totalRejected,
      probeInFlight: this.probeInFlight,
    };
  }

  /**
   * Manual reset, used by the chaos endpoint so a live demo can be re-run
   * without waiting out a 60-second cooldown in front of an audience.
   */
  reset() {
    this.state = STATE.CLOSED;
    this.consecutiveFailures = 0;
    this.reopenCount = 0;
    this.openedAt = 0;
    this.probeInFlight = false;
    this.lastFailureReason = null;
    this.lastStateChangeAt = Date.now();
  }
}

// One breaker per source, for the same reason there is one bucket per source:
// RemoteOK being down says nothing whatsoever about Arbeitnow.
const breakers = new Map();

export function getBreaker(sourceId, settings) {
  let breaker = breakers.get(sourceId);
  if (!breaker) {
    breaker = new CircuitBreaker(sourceId, settings || config.defaults.breaker);
    breakers.set(sourceId, breaker);
  }
  return breaker;
}

export function describeBreaker(sourceId) {
  const breaker = breakers.get(sourceId);
  return breaker ? breaker.describe() : null;
}

export function resetBreaker(sourceId) {
  const breaker = breakers.get(sourceId);
  if (breaker) breaker.reset();
  return breaker ? breaker.describe() : null;
}

/** Used by tests to get a clean slate. */
export function resetAllBreakers() {
  breakers.clear();
}
