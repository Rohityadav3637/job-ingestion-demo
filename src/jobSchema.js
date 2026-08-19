// jobSchema.js
//
// WHY THIS FILE EXISTS:
// Three sources hand us three completely different shapes. Arbeitnow sends
// `company_name`, RemoteOK sends `company`, We Work Remotely sends an XML
// element. If every part of the app had to know about all three shapes, adding
// a fourth source would mean editing the dashboard, the store, and the API.
//
// So we define ONE canonical Job shape here. Adapters translate into it; the
// rest of the app only ever sees this shape and never learns where a job came
// from beyond the `source` label.
//
// This file also owns VALIDATION, and that is the important part. Validation is
// not bureaucracy here -- it is the mechanism that lets us tell "this source is
// healthy" apart from "this source silently changed its field names and we are
// now storing 200 rows of undefined".

import crypto from 'node:crypto';

// The canonical shape. Documented as a comment rather than a class because
// these are plain JSON objects that get sent straight to the browser.
//
//   id        string       stable, derived by us (not taken from the source)
//   title     string       required
//   company   string       required
//   location  string       required (we default it, never leave it blank)
//   url       string       required, absolute http(s)
//   source    string       required, e.g. "arbeitnow"
//   postedAt  string|null  ISO 8601, or null when the source does not say
//   fetchedAt string       ISO 8601, when WE saw it

/**
 * Collapse runs of whitespace and trim.
 *
 * RSS feeds in particular are full of newlines and doubled spaces that render
 * as broken-looking text in the dashboard. Returns an empty string for
 * anything that is not a usable string, so callers only need one falsy check.
 */
export function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Best-effort conversion of whatever a source calls a date into ISO 8601.
 *
 * We accept several input shapes because our three sources genuinely disagree:
 * Arbeitnow sends Unix SECONDS, RemoteOK sends an ISO string, and RSS sends
 * RFC-822 ("Mon, 18 Aug 2026 01:22:28 +0000"). JavaScript's Date can parse the
 * last two on its own; the first needs help.
 *
 * Returns null rather than throwing or inventing a date. A missing date is a
 * fact worth preserving -- defaulting to `new Date()` would quietly turn
 * "unknown" into "posted today", which is a lie the dashboard would display.
 */
export function toIsoDate(value) {
  if (value === null || value === undefined || value === '') return null;

  let date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'number') {
    // Unix timestamps arrive in two flavours. Anything below ~1e12 cannot be
    // milliseconds (that would put us in 1970), so it must be seconds.
    date = new Date(value < 1e12 ? value * 1000 : value);
  } else if (typeof value === 'string') {
    // A numeric string is still a timestamp; recurse rather than duplicate.
    const asNumber = Number(value);
    if (value.trim() !== '' && Number.isFinite(asNumber)) return toIsoDate(asNumber);
    date = new Date(value);
  } else {
    return null;
  }

  // `new Date("nonsense")` does not throw -- it returns an Invalid Date whose
  // getTime() is NaN. This check is the only reliable way to catch that.
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * A stable ID derived from source + url.
 *
 * WHY NOT use the source's own id? Because ids are only unique within a
 * source -- Arbeitnow job 42 and RemoteOK job 42 are different jobs. And some
 * sources (RSS) give us no id at all.
 *
 * WHY hash rather than use the URL directly as the key? Uniform id format
 * across every source, and short readable ids in the API and dashboard.
 *
 * The property that actually matters is DETERMINISM: the same listing always
 * produces the same id, so re-ingesting a feed updates rows instead of
 * duplicating them. sha1 is used as a checksum here, not for security, so its
 * cryptographic weaknesses are irrelevant to this use.
 */
export function makeJobId(source, url) {
  return crypto.createHash('sha1').update(source + '::' + url).digest('hex').slice(0, 16);
}

/**
 * Is this an absolute http(s) URL?
 *
 * We reject relative URLs and other schemes because the dashboard renders these
 * as clickable links. A relative URL would resolve against OUR domain, so a
 * broken adapter would produce links that look fine and go nowhere useful.
 */
function isUsableUrl(value) {
  if (typeof value !== 'string' || value === '') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    // The URL constructor throws on anything it cannot parse.
    return false;
  }
}

/**
 * Validate and normalise a single candidate job.
 *
 * Returns { ok: true, job } or { ok: false, errors: string[] }.
 *
 * WHY return errors instead of throwing? Because one malformed listing in a
 * feed of 175 is normal and must not abort the run. The pipeline collects
 * these errors, counts them, and uses the ratio to decide whether the SOURCE
 * is degraded. A thrown exception would lose that information and take the
 * other 174 good jobs down with it.
 */
export function validateJob(candidate, { source, fetchedAt }) {
  const errors = [];

  if (typeof candidate !== 'object' || candidate === null) {
    return { ok: false, errors: ['not an object'] };
  }

  const title = cleanText(candidate.title);
  const company = cleanText(candidate.company);
  const url = cleanText(candidate.url);
  const location = cleanText(candidate.location);

  if (!title) errors.push('missing title');
  if (!company) errors.push('missing company');
  if (!isUsableUrl(url)) errors.push('missing or unusable url');
  if (!source) errors.push('missing source');

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    job: {
      id: makeJobId(source, url),
      title,
      company,
      // Location is required by our schema but genuinely absent from some
      // listings. We fill a visible placeholder rather than an empty string so
      // the dashboard never renders a mysterious blank cell.
      location: location || 'Not specified',
      url,
      source,
      postedAt: toIsoDate(candidate.postedAt),
      fetchedAt,
    },
  };
}

/**
 * Validate a whole batch and report on it.
 *
 * The return value is deliberately richer than just the good rows.
 * `validRatio` and `errorSamples` are what stage 8 uses to mark a source
 * DEGRADED. This is the difference between "we stored 3 jobs" and "we stored
 * 3 jobs out of 175 because 172 of them no longer have a title field".
 */
export function validateBatch(candidates, { source, fetchedAt = new Date().toISOString() }) {
  const jobs = [];
  const errorSamples = [];
  let invalidCount = 0;

  // Defensive: a broken adapter might hand us undefined instead of an array.
  // Treating that as an empty batch keeps the run alive, and the resulting
  // zero counts will trip the DEGRADED check rather than pass as success.
  const list = Array.isArray(candidates) ? candidates : [];

  for (const candidate of list) {
    const result = validateJob(candidate, { source, fetchedAt });
    if (result.ok) {
      jobs.push(result.job);
    } else {
      invalidCount += 1;
      // Keep a few examples for the dashboard. Keeping all of them would let a
      // broken source flood the store with thousands of identical strings.
      if (errorSamples.length < 5) errorSamples.push(result.errors.join(', '));
    }
  }

  // De-duplicate within the batch. Feeds legitimately repeat entries across
  // pages, and we would otherwise display the same job twice.
  const seen = new Set();
  const deduped = [];
  for (const job of jobs) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    deduped.push(job);
  }

  return {
    jobs: deduped,
    receivedCount: list.length,
    validCount: deduped.length,
    invalidCount,
    duplicateCount: jobs.length - deduped.length,
    // Guard against divide-by-zero. An empty response means 0 received, and we
    // report a ratio of 0 rather than NaN -- NaN would make every downstream
    // comparison false and the source would fail OPEN, i.e. look healthy.
    validRatio: list.length === 0 ? 0 : deduped.length / list.length,
    errorSamples,
  };
}
