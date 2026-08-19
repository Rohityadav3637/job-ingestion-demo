// chaos.js
//
// WHY THIS FILE EXISTS:
// I can claim the circuit breaker works. Claiming is cheap. This file lets me
// DEMONSTRATE it, live, on a deployed URL, in about fifteen seconds.
//
// Flip a source into chaos mode and its next requests come back 429 / 403 /
// empty. The breaker trips, the dashboard turns red, the pipeline fails over
// to a healthy source, and the reviewer watches the whole thing happen instead
// of reading a paragraph asserting that it would.
//
// WHERE THE FAULT IS INJECTED, AND WHY IT MATTERS ETHICALLY:
// Inside OUR OWN CLIENT, immediately before the network call. We do not send
// anything to the real source while chaos is armed -- the request is replaced,
// not corrupted. Arbeitnow never sees a single extra request because of a
// chaos demo. Simulating a hostile source by actually abusing a friendly one
// would be a strange way to demonstrate good judgment.
//
// WHY IT RETURNS A REAL `Response` OBJECT:
// Node has a global Response, so a synthetic failure is a genuine Response
// with a status and headers. The consequence is that httpClient.js contains
// exactly ONE line of chaos awareness -- pick the injected response or make a
// real request -- and every layer downstream (retry, breaker, parsing,
// validation) runs its normal path with no test-only branches at all.
//
// That is the whole design argument for this file: a fault injector that
// needed special-casing throughout the codebase would be testing the
// special-cases, not the system. This one exercises the real code path.

import { addEvent } from './store.js';
import { config } from './config.js';

export const CHAOS_MODES = {
  OFF: 'off',
  RATE_LIMIT: 'rate_limit',   // 429 + Retry-After -> pauses the bucket, trips the breaker
  FORBIDDEN: 'forbidden',     // 403               -> identity rotation, trips the breaker
  EMPTY: 'empty',             // 200 with zero results -- the silent failure case
  SCHEMA_DRIFT: 'schema_drift', // 200, plenty of rows, all fields renamed
  SERVER_ERROR: 'server_error', // 503 -> retried with backoff, then trips
};

const DESCRIPTIONS = {
  [CHAOS_MODES.RATE_LIMIT]: '429 Too Many Requests with Retry-After: 30',
  [CHAOS_MODES.FORBIDDEN]: '403 Forbidden (simulates being blocked)',
  [CHAOS_MODES.EMPTY]: '200 OK with an empty result set',
  [CHAOS_MODES.SCHEMA_DRIFT]: '200 OK with renamed fields (simulates a markup change)',
  [CHAOS_MODES.SERVER_ERROR]: '503 Service Unavailable',
};

/** sourceId -> { mode, armedAt, injectedCount } */
const armed = new Map();

export function setChaos(sourceId, mode) {
  if (mode === CHAOS_MODES.OFF) {
    armed.delete(sourceId);
    addEvent({
      level: 'info',
      sourceId,
      message: 'Chaos mode disarmed',
      detail: 'source will now receive real requests again',
    });
    return { sourceId, mode: CHAOS_MODES.OFF };
  }

  if (!Object.values(CHAOS_MODES).includes(mode)) {
    throw new Error(`unknown chaos mode: ${mode}`);
  }

  armed.set(sourceId, { mode, armedAt: Date.now(), injectedCount: 0 });

  // Logged at 'warn' so it is impossible to look at the dashboard and mistake
  // an injected failure for a real one. Fake failures that look real would
  // undermine the exact honesty this dashboard is meant to prove.
  addEvent({
    level: 'warn',
    sourceId,
    message: `CHAOS ARMED: ${mode}`,
    detail: `${DESCRIPTIONS[mode]} -- injected locally, no requests are sent to the real source`,
  });

  return { sourceId, mode };
}

export function clearAllChaos() {
  const cleared = [...armed.keys()];
  armed.clear();
  return cleared;
}

export function describeChaos() {
  const out = {};
  for (const [sourceId, entry] of armed) {
    out[sourceId] = {
      mode: entry.mode,
      description: DESCRIPTIONS[entry.mode],
      armedAt: new Date(entry.armedAt).toISOString(),
      expiresInMs: Math.max(0, config.chaos.autoDisarmMs - (Date.now() - entry.armedAt)),
      injectedCount: entry.injectedCount,
    };
  }
  return out;
}

export function isArmed(sourceId) {
  return armed.has(sourceId);
}

/**
 * Called by httpClient immediately before the real network call.
 *
 * Returns a Response to use INSTEAD of making a request, or null to proceed
 * normally.
 */
export function intercept(sourceId) {
  const entry = armed.get(sourceId);
  if (!entry) return null;

  // Self-disarm. Checked here rather than on a timer so there is no background
  // work and nothing to leak -- the same lazy-evaluation reasoning as the
  // token bucket refill.
  if (Date.now() - entry.armedAt > config.chaos.autoDisarmMs) {
    armed.delete(sourceId);
    addEvent({
      level: 'info',
      sourceId,
      message: 'Chaos mode auto-disarmed',
      detail: `expired after ${Math.round(config.chaos.autoDisarmMs / 60000)} minutes; real requests resume`,
    });
    return null;
  }

  entry.injectedCount += 1;

  // A header on every synthetic response. If a confusing result ever shows up
  // in a log or a demo, this is the thing that proves where it came from.
  const chaosHeaders = { 'x-chaos-injected': entry.mode };

  switch (entry.mode) {
    case CHAOS_MODES.RATE_LIMIT:
      // Retry-After: 30 is deliberately longer than our per-attempt backoff,
      // so the demo shows the bucket being paused rather than a quick retry
      // quietly papering over the failure.
      return new Response('{"error":"rate limited"}', {
        status: 429,
        headers: { ...chaosHeaders, 'retry-after': '30', 'content-type': 'application/json' },
      });

    case CHAOS_MODES.FORBIDDEN:
      return new Response('<html><body>Access denied</body></html>', {
        status: 403,
        headers: { ...chaosHeaders, 'content-type': 'text/html' },
      });

    case CHAOS_MODES.SERVER_ERROR:
      return new Response('{"error":"upstream unavailable"}', {
        status: 503,
        headers: { ...chaosHeaders, 'content-type': 'application/json' },
      });

    case CHAOS_MODES.EMPTY:
      // THE MOST IMPORTANT MODE. A 200 with no results is the failure that
      // looks like success: no error to log, no exception to catch, nothing
      // red anywhere. A naive pipeline records "0 jobs, OK" and overwrites
      // yesterday's good data with nothing.
      //
      // Every source shape gets an empty container here, because the adapter
      // that receives this is source-specific and we want the ADAPTER's normal
      // parse path to run and legitimately produce zero jobs.
      return new Response('{"data":[],"jobs":[],"results":[]}', {
        status: 200,
        headers: { ...chaosHeaders, 'content-type': 'application/json' },
      });

    case CHAOS_MODES.SCHEMA_DRIFT: {
      // Simulates the 3am markup change: the response is healthy, well-formed,
      // and the right size -- but every field has been renamed. Volume checks
      // pass. Only schema validation catches this, which is precisely why
      // validation is a health signal in this project and not decoration.
      const rows = Array.from({ length: 40 }, (_, i) => ({
        job_headline: `Renamed Field Job ${i}`,
        employer: `Company ${i}`,
        where: 'Remote',
        permalink: `https://example.com/job/${i}`,
      }));
      return new Response(JSON.stringify({ data: rows, jobs: rows, results: rows }), {
        status: 200,
        headers: { ...chaosHeaders, 'content-type': 'application/json' },
      });
    }

    default:
      return null;
  }
}
