// config.js
//
// WHY THIS FILE EXISTS:
// Every tunable number in this project lives here and nowhere else. During the
// live demo I will want to say things like "the breaker opens after 3 failures"
// or "we wait 60 seconds before probing again" -- and I want to be able to point
// at ONE file when asked "where is that set?".
//
// The alternative was scattering these numbers inline where they are used
// (`if (failures > 3)`). That reads fine when you write it and is miserable
// three days later, because tuning the system means hunting through five files
// and hoping you found every magic number.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM has no __dirname, so we rebuild it from import.meta.url.
// We need an absolute path because the process may be started from any
// working directory (Render starts it from the repo root, I might start it
// from src/ while debugging) and a relative path would silently point
// somewhere different in each case.
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(thisDir, '..');

export const config = {
  // --- Web server ---------------------------------------------------------
  // Hosts like Render tell us which port to listen on via the PORT env var.
  // Hardcoding 3000 would work locally and fail in production.
  port: Number(process.env.PORT) || 3000,

  // --- Persistence --------------------------------------------------------
  storeFile: process.env.STORE_FILE || path.join(projectRoot, 'data', 'store.json'),

  // We batch disk writes instead of writing on every single mutation.
  // One ingest run touches the store dozens of times; without this we would
  // do dozens of file writes for what is logically one update.
  storeSaveDebounceMs: 250,

  // Hard caps so a long-running process cannot grow its memory (and its JSON
  // file) forever. This is a demo box with limited RAM, not a data warehouse.
  maxJobsPerSource: 200,
  maxEventsKept: 300,

  // --- Ingestion loop -----------------------------------------------------
  ingest: {
    // How often we re-poll every source. 10 minutes is deliberately slow:
    // these listings change hourly at most, so polling faster would add load
    // to someone else's free API for zero extra information.
    intervalMs: Number(process.env.INGEST_INTERVAL_MS) || 10 * 60 * 1000,

    // Run once on boot so a freshly deployed instance is not an empty screen.
    runOnStartup: true,

    // Sources are ingested one at a time with a gap between them, rather than
    // all at once. Firing three simultaneous requests the instant the process
    // boots is a recognisable machine signature; humans do not do that.
    staggerMs: 2000,
  },

  // --- Identity rotation --------------------------------------------------
  identity: {
    // How many requests one identity is used for before we rotate.
    // Deliberately NOT 1. A real browser does not change its User-Agent
    // between two requests from the same IP, so rotating on every request
    // replaces one signature with a stranger one. We rotate on a REASON
    // (getting blocked) or after a stretch of use, not reflexively.
    maxUsesPerIdentity: 25,

    // Also rotate if an identity has simply been in use a long time, so a
    // low-traffic source does not keep one identity alive for days.
    maxAgeMs: 30 * 60 * 1000,

    // Where a curious sysadmin can find out who we are, used by the honest
    // identity pool. Overridable so the deployed instance can point at the
    // real repo.
    contactUrl: process.env.CONTACT_URL || 'https://github.com/Rohityadav3637/job-ingestion',
  },

  // --- Per-source defaults ------------------------------------------------
  // Individual source adapters may override any of these. Putting sensible
  // defaults here means a new adapter inherits the full safety net for free
  // and only has to declare what makes it different.
  defaults: {
    // Abandon a request that hangs. Without a timeout a single stalled socket
    // blocks the whole ingest run indefinitely -- a silent failure, which is
    // exactly the thing this project is supposed to prevent.
    timeoutMs: 15000,

    // Token bucket: at most `capacity` requests back-to-back, refilling at
    // `refillPerMinute`. Explained properly in stage 3.
    rateLimit: {
      capacity: 3,
      refillPerMinute: 20,
    },

    // Random pause before each request so our traffic is not metronomic.
    // Explained properly in stage 3.
    jitterMs: { min: 300, max: 1500 },

    // Retry policy for transient failures. 3 attempts total, not 10:
    // if a source is genuinely down, hammering it is both rude and useless.
    retry: {
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 15000,

      // Upper bound on how long we will obey a Retry-After header.
      // A server (buggy, or hostile) can answer "Retry-After: 86400" and, if
      // we obeyed literally, one response would stall that source for a day
      // while the dashboard showed it merely "waiting". Past this ceiling we
      // stop waiting and let the circuit breaker own the problem instead,
      // which is a state the dashboard reports honestly as CIRCUIT-OPEN.
      maxRetryAfterMs: 5 * 60 * 1000,

      // The longest we will sleep INSIDE a run before giving up on this
      // attempt. Separate from maxRetryAfterMs on purpose.
      //
      // When a source answers "Retry-After: 30" we have two ways to obey it:
      // sleep 30s here, or pause the source's token bucket for 30s and let
      // the next scheduled run pick it up. The bucket pause is strictly
      // better -- it is durable, it covers EVERY later request rather than
      // just this one, and it does not hold the other two sources hostage
      // while we sit in a sleep. So past this ceiling we stop retrying in-run
      // and let pacing plus the scheduler do the waiting.
      maxInRunWaitMs: 5000,
    },

    breaker: {
      // Consecutive failures (429 / 403 / empty / transport) before we trip.
      // Consecutive, not cumulative: a source that fails once an hour is
      // flaky, not broken, and tripping on that would be an overreaction.
      failureThreshold: 3,

      // How long we stay OPEN before allowing one probe through.
      openMs: 60 * 1000,

      // Each time a probe fails, the next cooldown doubles: 60s, 120s, 240s.
      // A source that is still down after three probes probably needs
      // minutes, not seconds, and we should stop asking so often.
      maxOpenMs: 15 * 60 * 1000,
    },

    // --- Honesty thresholds ---
    // These two numbers are how we tell "the source is fine and quiet" apart
    // from "the source is broken and we did not notice".
    //
    // If a source that normally returns hundreds of jobs suddenly returns 2,
    // something changed -- their markup, their API, or our access. That is
    // DEGRADED, not success.
    minExpectedJobs: 5,

    // If we received plenty of raw items but most of them fail schema
    // validation, the source probably renamed its fields. Also DEGRADED.
    minValidRatio: 0.7,

    // Which identity pool to draw from: 'honest' or 'browser'.
    // See identities.js for why every real source in this project uses
    // 'honest' and 'browser' is exercised only against our own chaos endpoint.
    identityMode: 'honest',
  },
};

// Freeze so a typo like `config.port = ...` at runtime throws instead of
// silently changing behaviour halfway through a run.
Object.freeze(config);
Object.freeze(config.ingest);
Object.freeze(config.identity);
Object.freeze(config.defaults);
