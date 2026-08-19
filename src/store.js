// store.js
//
// WHY THIS FILE EXISTS:
// Something has to remember the jobs we pulled and the health of each source
// between requests. This is the whole persistence layer, and it is deliberately
// about sixty lines of logic.
//
// WHY A JSON FILE INSTEAD OF SQLITE OR POSTGRES:
// A database earns its keep when you need queries, joins, indexes, or several
// processes writing at once. We have one process, a few hundred records, and
// exactly two read patterns: "give me the jobs" and "give me source health".
// SQLite would also add a native dependency I would then have to explain.
// A file I can open in a text editor is the honest choice at this size.
//
// KNOWN LIMITATION, STATED ON PURPOSE:
// Render free instances have an ephemeral disk, so this file is wiped on every
// redeploy and on cold starts. That is acceptable for a demo -- the scheduler
// refills it within seconds -- and it is written down in the README rather than
// hidden. If this had to survive restarts, this is the one file that would be
// swapped for Postgres, and nothing else in the project would change.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

/**
 * The shape of everything we persist.
 *
 * `sources` is keyed by source id so health lookups are direct rather than a
 * scan, and so a source that has never run simply has no key yet.
 */
function emptyState() {
  return {
    version: 1,
    startedAt: new Date().toISOString(),
    // sourceId -> { status, lastRunAt, lastSuccessAt, jobCount, ... }
    sources: {},
    // sourceId -> Job[]  (kept per source so one broken source cannot
    // delete another source's data when we replace its results)
    jobsBySource: {},
    // A rolling activity log. This is what makes failures visible in the
    // dashboard instead of only existing in server logs nobody will read.
    events: [],
  };
}

// The live state lives in memory and is the single source of truth at runtime.
// The file on disk is a snapshot of it, not the other way around. That means
// reads never touch the disk, which is what keeps the API fast.
let state = emptyState();

let saveTimer = null;
let savingPromise = null;

/**
 * Load the snapshot from disk, if there is one.
 *
 * Every failure path here ends in "start fresh" rather than "crash". A corrupt
 * or missing store file must never stop the server from booting -- the data is
 * re-fetchable within one ingest cycle, so refusing to start would trade a
 * recoverable problem for an outage.
 */
export async function initStore() {
  try {
    await fsp.mkdir(path.dirname(config.storeFile), { recursive: true });
    const raw = await fsp.readFile(config.storeFile, 'utf8');
    const parsed = JSON.parse(raw);

    // Only accept a snapshot we recognise. If a future version changes the
    // shape, an old file is discarded rather than half-loaded into code that
    // expects different fields.
    if (parsed && parsed.version === 1) {
      state = { ...emptyState(), ...parsed, startedAt: new Date().toISOString() };
      return { loaded: true, jobs: countJobs() };
    }
    return { loaded: false, reason: 'unrecognised store version' };
  } catch (error) {
    // ENOENT just means first run. Anything else means a damaged file.
    const reason = error.code === 'ENOENT' ? 'no existing store' : `unreadable store (${error.message})`;
    state = emptyState();
    return { loaded: false, reason };
  }
}

export function getState() {
  return state;
}

function countJobs() {
  return Object.values(state.jobsBySource).reduce((total, list) => total + list.length, 0);
}

/**
 * Write the snapshot to disk, atomically.
 *
 * WHY THE TEMP FILE AND RENAME: if the process is killed halfway through a
 * plain write, the store file is left truncated and the next boot loses
 * everything. Writing to a temp file and then renaming means the real file is
 * only ever replaced in one indivisible step -- readers see either the old
 * complete snapshot or the new complete snapshot, never a half-written one.
 */
async function writeToDisk() {
  const tempFile = `${config.storeFile}.tmp`;
  const json = JSON.stringify(state);
  await fsp.mkdir(path.dirname(config.storeFile), { recursive: true });
  await fsp.writeFile(tempFile, json, 'utf8');
  await fsp.rename(tempFile, config.storeFile);
}

/**
 * Request a save.
 *
 * Debounced because one ingest run mutates the state dozens of times for what
 * is logically a single update. Without this we would perform dozens of disk
 * writes per run for no benefit.
 *
 * Returns a promise so tests and shutdown can await the flush; ordinary
 * callers can safely ignore it.
 */
export function saveSoon() {
  if (saveTimer) clearTimeout(saveTimer);

  savingPromise = new Promise((resolve) => {
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try {
        await writeToDisk();
      } catch (error) {
        // A failed snapshot must not take down the server. We lose durability,
        // not availability -- and we say so loudly rather than swallowing it.
        console.error('[store] failed to persist snapshot:', error.message);
      }
      resolve();
    }, config.storeSaveDebounceMs);
  });

  return savingPromise;
}

/** Force an immediate write, skipping the debounce. Used on shutdown. */
export async function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    await writeToDisk();
  } catch (error) {
    console.error('[store] failed to flush snapshot:', error.message);
  }
}

// --- Jobs -----------------------------------------------------------------

/**
 * Replace all jobs for one source.
 *
 * REPLACE, not append. Each poll returns the source's current view of the
 * world, so appending would accumulate stale listings forever with no way to
 * tell which ones the source has since removed.
 *
 * The important guard is the caller's: the pipeline only calls this when the
 * run was genuinely healthy. A blocked or degraded run must NOT reach this
 * function, because overwriting good data with an empty array is precisely the
 * silent failure this project is built to avoid.
 */
export function replaceJobs(sourceId, jobs) {
  state.jobsBySource[sourceId] = jobs.slice(0, config.maxJobsPerSource);
  saveSoon();
}

/** Every job we currently hold, newest first, flattened across sources. */
export function getAllJobs() {
  const all = [];
  for (const list of Object.values(state.jobsBySource)) all.push(...list);

  // Sort by posting date, newest first. Jobs without a date sort last rather
  // than first -- an unknown date is not evidence of freshness.
  return all.sort((a, b) => {
    if (a.postedAt === b.postedAt) return 0;
    if (a.postedAt === null) return 1;
    if (b.postedAt === null) return -1;
    return a.postedAt < b.postedAt ? 1 : -1;
  });
}

export function getJobsForSource(sourceId) {
  return state.jobsBySource[sourceId] || [];
}

// --- Source health --------------------------------------------------------

/**
 * Merge a partial update into one source's health record.
 *
 * Merge rather than replace so a caller that only knows about one field (say,
 * the breaker updating `status`) cannot accidentally erase fields it does not
 * know about (say, `lastSuccessAt`).
 */
export function updateSource(sourceId, patch) {
  const existing = state.sources[sourceId] || { id: sourceId };
  state.sources[sourceId] = { ...existing, ...patch };
  saveSoon();
  return state.sources[sourceId];
}

export function getSource(sourceId) {
  return state.sources[sourceId] || null;
}

export function getAllSources() {
  return Object.values(state.sources);
}

// --- Events ---------------------------------------------------------------

/**
 * Append to the rolling activity log.
 *
 * `level` is one of 'info' | 'warn' | 'error'. The dashboard colours by level,
 * which is how a failure becomes something you SEE rather than something you
 * would have to go looking for.
 */
export function addEvent({ level = 'info', sourceId = null, message, detail = null }) {
  state.events.unshift({
    at: new Date().toISOString(),
    level,
    sourceId,
    message,
    detail,
  });

  // Trim from the end so the newest entries survive. Without a cap this array
  // grows without bound for the lifetime of the process.
  if (state.events.length > config.maxEventsKept) {
    state.events.length = config.maxEventsKept;
  }

  saveSoon();
}

export function getEvents(limit = 50) {
  return state.events.slice(0, limit);
}

/**
 * Persist on the way down.
 *
 * Render sends SIGTERM before stopping a service. Without this the last few
 * seconds of state are lost on every redeploy. `fs.writeFileSync` is used
 * rather than the async version because the process is exiting and there is no
 * guarantee the event loop will run another tick.
 */
export function registerShutdownFlush() {
  const handler = () => {
    try {
      fs.mkdirSync(path.dirname(config.storeFile), { recursive: true });
      fs.writeFileSync(config.storeFile, JSON.stringify(state), 'utf8');
    } catch {
      // Nothing useful to do while exiting; losing the snapshot is survivable.
    }
    process.exit(0);
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}
