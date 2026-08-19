// sources/arbeitnow.js
//
// Arbeitnow -- a European job board with a documented, open, unauthenticated
// JSON API. https://www.arbeitnow.com/api/job-board-api
//
// NOTICE WHAT IS NOT IN THIS FILE: no rate limiting, no retries, no headers,
// no identity, no circuit breaker, no chaos awareness. An adapter knows its
// URL and its field names. Everything else is applied by httpClient.js for
// every source uniformly, which is why adding a source is a small job and why
// a rushed adapter cannot accidentally skip the polite behaviour.

import { cleanText } from '../jobSchema.js';

export const arbeitnow = {
  id: 'arbeitnow',
  label: 'Arbeitnow',
  homepage: 'https://www.arbeitnow.com',
  format: 'JSON API',
  url: 'https://www.arbeitnow.com/api/job-board-api',
  accept: 'application/json',

  // Recorded rather than fetched at runtime. See sources/index.js for why.
  robots: {
    checkedOn: '2026-08-19',
    policy: 'User-agent: * / Disallow:   (an empty Disallow means allow all)',
    note: 'This is a published public API endpoint, not a page we are scraping around.',
  },

  attribution: {
    required: false,
    text: 'Jobs via Arbeitnow',
    url: 'https://www.arbeitnow.com',
  },

  // Roughly 175 jobs per page, so a full page is one request. We poll every
  // ten minutes at most, which is far below any plausible limit for a public
  // API, and we take page 1 only -- see the note on pagination below.
  settings: {
    rateLimit: { capacity: 2, refillPerMinute: 10 },
  },

  // This source reliably returns ~175 jobs. Anything below 20 means something
  // changed, and "something changed" must show up as DEGRADED rather than
  // being quietly accepted.
  minExpectedJobs: 20,

  /**
   * Body text -> array of raw source objects.
   *
   * Throws on anything unparseable. That is deliberate: the pipeline catches
   * it and records a PARSE_ERROR, which is a loud, specific, visible state.
   * Returning [] instead would be indistinguishable from "the source has no
   * jobs today" -- the precise ambiguity this project exists to eliminate.
   */
  parse(bodyText) {
    const body = JSON.parse(bodyText);

    if (!body || !Array.isArray(body.data)) {
      throw new Error('expected an object with a `data` array');
    }

    // PAGINATION, AND WHY WE TAKE ONE PAGE:
    // The API exposes `links.next`. We deliberately do not follow it. One page
    // is 175 current listings, which is plenty for a demo, and walking every
    // page would multiply our request count against someone else's free API
    // for data nobody is going to read. If this needed full coverage, the
    // right shape is one queued job per page rather than a loop here -- so
    // that pacing and the breaker still apply per request.
    return body.data;
  },

  /**
   * One raw source object -> our canonical candidate shape.
   * Validation happens afterwards in validateBatch, not here.
   */
  normalize(item) {
    return {
      title: item.title,
      company: item.company_name,
      // `remote: true` with a blank location is common here. Reporting
      // "Remote" is more truthful to a reader than the "Not specified"
      // placeholder validateJob would otherwise fill in.
      location: cleanText(item.location) || (item.remote ? 'Remote' : ''),
      url: item.url,
      // Unix SECONDS. toIsoDate() handles the conversion; reading this as
      // milliseconds would date every job to January 1970.
      postedAt: item.created_at,
    };
  },
};
