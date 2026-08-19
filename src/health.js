// health.js
//
// WHY THIS FILE EXISTS:
// This is the honesty layer. Everything before it moved bytes around. This is
// where we decide what those bytes MEAN, and specifically where we refuse to
// let a failure render as a success.
//
// THE CENTRAL PROBLEM:
// At the HTTP layer, all three of these are a 200 OK:
//
//   a) the source returned 175 good jobs
//   b) the source returned an empty list because we were soft-blocked
//   c) the source returned 40 rows whose fields were all renamed overnight
//
// A pipeline that only checks response.ok records all three as success. For
// (b) it writes zero jobs over yesterday's good data and reports "healthy".
// For (c) it writes 40 rows of nulls and reports "healthy". Nothing goes red,
// nothing gets logged, and the failure is discovered days later by a human
// noticing the numbers look wrong.
//
// So status is computed from THREE signals, not one:
//   1. the transport outcome  (did we get a response at all)
//   2. the yield              (how many valid jobs came out)
//   3. the valid ratio        (what fraction of rows still fit the schema)
//
// Ratio is what separates (b) from (c). An empty response has no rows to fail
// validation; a drifted response has plenty of rows and almost none pass.

import { OUTCOME } from './fetcher/httpClient.js';
import { config } from './config.js';

export const STATUS = {
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  RATE_LIMITED: 'RATE_LIMITED',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  BLOCKED: 'BLOCKED',
  ERROR: 'ERROR',
  NEVER_RUN: 'NEVER_RUN',
};

/**
 * Severity ordering, used by the dashboard to sort and colour.
 * Higher means louder. HEALTHY is 0 so a healthy row never draws the eye.
 */
export const SEVERITY = {
  [STATUS.HEALTHY]: 0,
  [STATUS.NEVER_RUN]: 1,
  [STATUS.RATE_LIMITED]: 2,
  [STATUS.DEGRADED]: 3,
  [STATUS.BLOCKED]: 4,
  [STATUS.CIRCUIT_OPEN]: 4,
  [STATUS.ERROR]: 4,
};

/**
 * Decide a source's status from one run.
 *
 * Returns { status, reason, shouldPersist }.
 *
 * `reason` is a full sentence, not a code. It goes straight onto the dashboard
 * and into the event log, because "DEGRADED" alone tells an operator nothing
 * about what to do next -- and this dashboard is meant to be the evidence that
 * failures are visible, which means readable.
 *
 * `shouldPersist` answers the question that actually protects the data: may
 * this run's jobs overwrite what we already hold?
 */
export function classifyRun({
  outcome,
  parseError = null,
  validation = null,
  source,
}) {
  // --- 1. We never got a usable response -------------------------------
  // In every one of these cases we have NO data, so persisting would mean
  // replacing real jobs with nothing. shouldPersist is false throughout.

  if (outcome === OUTCOME.CIRCUIT_OPEN) {
    return {
      status: STATUS.CIRCUIT_OPEN,
      reason: 'Circuit breaker is open - no request was sent. Serving previously stored jobs.',
      shouldPersist: false,
    };
  }

  if (outcome === OUTCOME.RATE_LIMITED) {
    return {
      status: STATUS.RATE_LIMITED,
      reason: 'Source returned 429. Backing off and serving previously stored jobs.',
      shouldPersist: false,
    };
  }

  if (outcome === OUTCOME.BLOCKED) {
    return {
      status: STATUS.BLOCKED,
      reason: 'Source returned 403/401 - we appear to be blocked. Identity rotated for next run.',
      shouldPersist: false,
    };
  }

  if (outcome !== OUTCOME.OK) {
    return {
      status: STATUS.ERROR,
      reason: `Fetch failed: ${outcome}. Serving previously stored jobs.`,
      shouldPersist: false,
    };
  }

  // --- 2. We got a 200, but could not read it --------------------------
  // The body arrived and was not the shape we expect. This is the signature
  // of a source that changed its response format -- a real event that must be
  // loud, because every later run will fail the same way until someone looks.

  if (parseError) {
    return {
      status: STATUS.DEGRADED,
      reason: `Response could not be parsed (${parseError}). The source format may have changed.`,
      shouldPersist: false,
    };
  }

  // --- 3. We got a 200 and parsed it. Now the interesting part. ---------

  const { receivedCount, validCount, invalidCount, validRatio } = validation;

  // Resolve thresholds against config defaults.
  //
  // THIS LINE EXISTS BECAUSE OF A REAL BUG. Adapters declare minExpectedJobs
  // but not minValidRatio, which lives in config.defaults. Reading
  // `source.minValidRatio` directly therefore compared against undefined --
  // and `0 < undefined` is false, so the drift check never fired. Schema-drift
  // detection was silently disabled and only appeared to work because the
  // low-yield check happened to catch the same case.
  //
  // Note the failure mode, because it is the third time this shape has come up
  // in this project: a comparison against a missing value is false, so the
  // guard fails OPEN and the system reports healthy. Same family as the
  // 0/0 -> NaN guard in jobSchema.js. Any threshold read from a partially
  // populated object needs an explicit fallback.
  const minValidRatio = source.minValidRatio ?? config.defaults.minValidRatio;
  const minExpectedJobs = source.minExpectedJobs ?? config.defaults.minExpectedJobs;

  // 3a. EMPTY. Zero rows in a 200 response.
  //
  // This is the single most dangerous case in the whole project, because it
  // is completely silent: no error, no exception, no red anything. It is what
  // a soft block looks like, and what a broken query looks like, and it is
  // indistinguishable from "genuinely no jobs today" from inside the process.
  //
  // We resolve that ambiguity by ADMITTING it rather than guessing. The
  // status says the source returned nothing and that we do not know why, and
  // shouldPersist is false so yesterday's real jobs survive.
  if (receivedCount === 0) {
    return {
      status: STATUS.DEGRADED,
      reason:
        'Source returned HTTP 200 with zero listings. This is either a genuinely empty feed or a ' +
        'silent block - we cannot tell from here, so previously stored jobs are kept rather than ' +
        'overwritten with nothing.',
      shouldPersist: false,
    };
  }

  // 3b. SCHEMA DRIFT. Plenty of rows, but most fail validation.
  //
  // The response is well-formed and the right size, so volume checks pass.
  // Only field-level validation catches it. This is why validateBatch returns
  // a ratio and not just an array.
  if (validRatio < minValidRatio) {
    return {
      status: STATUS.DEGRADED,
      reason:
        `Only ${validCount} of ${receivedCount} listings passed validation ` +
        `(${Math.round(validRatio * 100)}%, expected at least ${Math.round(minValidRatio * 100)}%). ` +
        'The source has probably renamed or removed fields.',
      // Note: we DO persist the rows that passed. They are real jobs and
      // showing 12 real listings beside a loud DEGRADED banner is more useful
      // than showing none. What we must never do is call this HEALTHY.
      shouldPersist: validCount > 0,
    };
  }

  // 3c. LOW YIELD. Rows are valid, but there are far fewer than usual.
  //
  // Weaker evidence than drift -- a source can legitimately be quiet -- so it
  // is a warning rather than a verdict, and we DO store the jobs because they
  // are real.
  if (validCount < minExpectedJobs) {
    return {
      status: STATUS.DEGRADED,
      reason:
        `Only ${validCount} valid listings returned, below the expected minimum of ` +
        `${minExpectedJobs}. The source may be partially blocking us or returning a truncated feed.`,
      shouldPersist: true,
    };
  }

  // --- 4. Genuinely healthy --------------------------------------------
  const note = invalidCount > 0 ? ` (${invalidCount} malformed rows skipped)` : '';
  return {
    status: STATUS.HEALTHY,
    reason: `${validCount} valid listings ingested${note}.`,
    shouldPersist: true,
  };
}

/**
 * How stale is the data we are serving for this source?
 *
 * Matters because a source can sit in CIRCUIT_OPEN for an hour while the
 * dashboard happily shows 175 jobs. Those jobs are real, but they are old, and
 * a screen that does not say so is quietly misleading -- which is the same sin
 * as reporting empty-as-success, just slower.
 */
export function describeFreshness(lastSuccessAt, now = Date.now()) {
  if (!lastSuccessAt) return { ageMs: null, label: 'never' };

  const ageMs = now - new Date(lastSuccessAt).getTime();
  const minutes = Math.floor(ageMs / 60000);

  if (minutes < 1) return { ageMs, label: 'just now' };
  if (minutes < 60) return { ageMs, label: `${minutes}m ago` };

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { ageMs, label: `${hours}h ago` };
  return { ageMs, label: `${Math.floor(hours / 24)}d ago` };
}
