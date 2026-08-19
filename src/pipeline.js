// pipeline.js
//
// WHY THIS FILE EXISTS:
// One place that runs the whole sequence for a source, and one place that runs
// every source. Everything it needs already exists -- this file mostly decides
// the ORDER of things and what to do with the answers.
//
//   fetch (all resilience applied)  ->  parse  ->  normalize  ->  validate
//        ->  classify health  ->  persist ONLY IF the run earned it
//
// THE RULE THAT MATTERS MOST IS THE LAST ONE.
// Persisting is conditional on health.shouldPersist. A run that was blocked,
// rate limited, circuit-broken or returned an empty 200 does NOT get to
// replace stored jobs. That single condition is what stops the pipeline
// destroying good data on a bad day -- and it is why classifyRun returns
// shouldPersist rather than leaving the caller to infer it from the status.

import { sources, getSourceById } from './sources/index.js';
import { resilientFetch, OUTCOME } from './fetcher/httpClient.js';
import { validateBatch } from './jobSchema.js';
import { classifyRun, STATUS, SEVERITY } from './health.js';
import { describeBreaker } from './fetcher/circuitBreaker.js';
import { describeBucket } from './fetcher/rateLimiter.js';
import { describeSession } from './fetcher/identities.js';
import { sleep } from './fetcher/rateLimiter.js';
import { config } from './config.js';
import * as store from './store.js';

/**
 * Run one source, end to end.
 *
 * NEVER THROWS. A source failing is an ordinary, expected event that must be
 * recorded and survived, not an exception that aborts the run and takes the
 * other two sources with it. Everything that can throw -- parse() especially
 * -- is caught and converted into a status.
 */
export async function runSource(sourceId) {
  const source = getSourceById(sourceId);
  if (!source) throw new Error(`unknown source: ${sourceId}`);

  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  // --- fetch -----------------------------------------------------------
  const fetchResult = await resilientFetch(source.id, source.url, {
    ...source.settings,
    accept: source.accept,
  });

  // --- parse + normalize + validate ------------------------------------
  // Only attempted if we actually have a body. parse() is expected to throw
  // on an unrecognised format; that throw is the signal, so we catch it here
  // and hand the message to classifyRun rather than letting it escape.
  let parseError = null;
  let validation = null;
  let rawCount = 0;

  if (fetchResult.ok) {
    try {
      const rawItems = source.parse(fetchResult.bodyText);
      rawCount = rawItems.length;

      const candidates = rawItems.map((item) => source.normalize(item));
      validation = validateBatch(candidates, { source: source.id, fetchedAt: startedAt });
    } catch (error) {
      parseError = error.message;
    }
  }

  // --- classify --------------------------------------------------------
  const health = classifyRun({
    outcome: fetchResult.outcome,
    parseError,
    validation,
    source,
  });

  // --- persist, but only if this run earned the right to ---------------
  const previousCount = store.getJobsForSource(source.id).length;
  let storedCount = previousCount;

  if (health.shouldPersist && validation && validation.jobs.length > 0) {
    store.replaceJobs(source.id, validation.jobs);
    storedCount = validation.jobs.length;
  }

  // --- record ----------------------------------------------------------
  const existing = store.getSource(source.id) || {};
  const durationMs = Date.now() - t0;

  const record = {
    id: source.id,
    label: source.label,
    format: source.format,
    homepage: source.homepage,
    attribution: source.attribution,

    status: health.status,
    reason: health.reason,

    lastRunAt: startedAt,
    // Only advanced on a genuinely healthy run. This is what powers the
    // staleness indicator: a source can be showing 175 jobs while its last
    // real success was an hour ago, and the dashboard has to be able to say so.
    lastSuccessAt: health.status === STATUS.HEALTHY ? startedAt : existing.lastSuccessAt || null,

    durationMs,
    jobCount: storedCount,

    // Kept for the dashboard so a human can see the arithmetic behind the
    // verdict rather than having to trust it.
    lastRun: {
      outcome: fetchResult.outcome,
      httpStatus: fetchResult.status,
      attempts: fetchResult.meta.attempts,
      rawCount,
      receivedCount: validation ? validation.receivedCount : 0,
      validCount: validation ? validation.validCount : 0,
      invalidCount: validation ? validation.invalidCount : 0,
      duplicateCount: validation ? validation.duplicateCount : 0,
      validRatio: validation ? Number(validation.validRatio.toFixed(3)) : null,
      errorSamples: validation ? validation.errorSamples : [],
      parseError,
      persisted: health.shouldPersist && Boolean(validation) && validation.jobs.length > 0,
      identity: fetchResult.meta.identity,
      waitedMs: fetchResult.meta.totalWaitMs,
      chaosMode: fetchResult.meta.chaosMode,
      notes: fetchResult.meta.notes,
    },
  };

  store.updateSource(source.id, record);

  // --- narrate ---------------------------------------------------------
  // Every run writes an event. Silence is not evidence of health, so a source
  // that is failing produces a visible trail rather than simply not appearing.
  store.addEvent({
    level: health.status === STATUS.HEALTHY ? 'info' : SEVERITY[health.status] >= 4 ? 'error' : 'warn',
    sourceId: source.id,
    message: `${source.label}: ${health.status}`,
    detail: health.reason,
  });

  return record;
}

/**
 * Run every source, one after another.
 *
 * SEQUENTIAL, NOT Promise.all. Three simultaneous outbound requests the
 * instant a timer fires is a recognisable machine signature, and it also
 * defeats the point of per-source pacing by bunching all our traffic into the
 * same instant. The stagger costs a few seconds we do not need.
 *
 * FAILOVER, CONCRETELY:
 * There is no "primary" source to fall back FROM -- all three are peers, and
 * the aggregate feed is what the user consumes. So failover here means:
 *
 *   1. one source failing never stops the others (each runSource is isolated)
 *   2. a source whose breaker is open is skipped in microseconds instead of
 *      burning three timeouts, so a dead source costs the run almost nothing
 *   3. jobs from the healthy sources still serve the request, and the summary
 *      names which sources carried it
 *
 * That last point is why this returns servedBy/failedOver rather than a bare
 * array: the dashboard has to be able to say "Remote OK is down, these 275
 * jobs came from the other two" instead of quietly showing fewer results.
 */
export async function runAll({ reason = 'scheduled' } = {}) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const results = [];

  for (const [index, source] of sources.entries()) {
    // Stagger between sources, not before the first one.
    if (index > 0) await sleep(config.ingest.staggerMs);
    results.push(await runSource(source.id));
  }

  const servedBy = results.filter((r) => r.jobCount > 0).map((r) => r.id);
  const failedOver = results.filter((r) => r.status !== STATUS.HEALTHY).map((r) => r.id);
  const totalJobs = results.reduce((sum, r) => sum + r.jobCount, 0);

  const summary = {
    startedAt,
    durationMs: Date.now() - t0,
    reason,
    totalJobs,
    sourcesRun: results.length,
    healthy: results.filter((r) => r.status === STATUS.HEALTHY).length,
    servedBy,
    failedOver,
  };

  // One summary line per run, so the event log reads as a story of the
  // system over time rather than a pile of disconnected errors.
  if (failedOver.length === 0) {
    store.addEvent({
      level: 'info',
      message: `Ingest run complete: ${totalJobs} jobs from ${servedBy.length} sources`,
      detail: `${summary.durationMs}ms, triggered by ${reason}`,
    });
  } else {
    store.addEvent({
      level: 'warn',
      message: `Ingest run degraded: ${failedOver.length} of ${results.length} sources unhealthy`,
      detail:
        `Unhealthy: ${failedOver.join(', ')}. Failing over -- ${totalJobs} jobs still served ` +
        `by ${servedBy.join(', ') || 'no sources'}.`,
    });
  }

  return summary;
}

/**
 * Everything the dashboard needs, assembled in one place.
 *
 * Pulls live limiter/breaker/identity state alongside the stored record, so
 * the screen shows the system as it is right now rather than as it was at the
 * end of the last run. All three use describe(), which is non-mutating -- see
 * the note in circuitBreaker.js about why that is not optional.
 */
export function getSourceHealth() {
  return sources
    .map((source) => {
      const stored = store.getSource(source.id);

      if (!stored) {
        return {
          id: source.id,
          label: source.label,
          format: source.format,
          homepage: source.homepage,
          attribution: source.attribution,
          status: STATUS.NEVER_RUN,
          reason: 'No ingest run has completed yet.',
          jobCount: 0,
          severity: SEVERITY[STATUS.NEVER_RUN],
        };
      }

      return {
        ...stored,
        severity: SEVERITY[stored.status] ?? 0,
        limiter: describeBucket(source.id),
        breaker: describeBreaker(source.id),
        identity: describeSession(source.id),
      };
    })
    .sort((a, b) => b.severity - a.severity);
}
