// sources/remoteok.js
//
// Remote OK -- a remote-work job board with an open JSON API.
// https://remoteok.com/api
//
// TWO THINGS MAKE THIS SOURCE INTERESTING BEYOND "another JSON feed":
//
// 1. Element [0] of the array is NOT a job. It is a legal notice. Any adapter
//    written from the docs without looking at the actual bytes produces one
//    garbage row on every single run.
//
// 2. Their API terms require attribution with a followable link back. That is
//    a condition of use, not a suggestion, so the dashboard renders it. An
//    ingestion project that ignores the one explicit request its source makes
//    would be a strange place to claim good judgment about ToS.

import { cleanText } from '../jobSchema.js';

export const remoteok = {
  id: 'remoteok',
  label: 'Remote OK',
  homepage: 'https://remoteok.com',
  format: 'JSON API',
  url: 'https://remoteok.com/api',
  accept: 'application/json',

  robots: {
    checkedOn: '2026-08-19',
    policy: 'User-agent: * / Allow: /   (Cloudflare-managed, with Content-Signal directives)',
    note:
      'Content-Signal declares ai-train=no. We do not train models on this data -- we display ' +
      'listings with attribution and a link back, which is the use their API terms ask for.',
  },

  // Enforced by the dashboard, not just documented here.
  attribution: {
    required: true,
    text: 'Jobs from Remote OK',
    url: 'https://remoteok.com',
    note: 'Their API terms require a do-follow link back and a mention as the source.',
  },

  // Slower than Arbeitnow. This endpoint sits behind Cloudflare and returns
  // the full listing set in one response, so there is no reason to ask often.
  settings: {
    rateLimit: { capacity: 2, refillPerMinute: 6 },
  },

  minExpectedJobs: 20,

  parse(bodyText) {
    const body = JSON.parse(bodyText);

    if (!Array.isArray(body)) {
      throw new Error('expected a top-level array');
    }

    // Drop the legal notice, and ONLY the legal notice.
    //
    // WHY NOT `body.slice(1)`: that assumes the notice is always first and
    // always exactly one element. Testing for the `legal` key means we remove
    // the thing we actually mean to remove, and if they ever drop the notice
    // we do not silently discard a real job instead.
    //
    // WHY NOT `body.filter(r => r.position)`: that would also silently discard
    // malformed job rows -- which is exactly the evidence validateBatch needs
    // to notice a schema change. Filtering by "looks valid" before validating
    // would hide the drift we are trying to detect.
    const rows = body.filter((row) => !(row && typeof row.legal === 'string'));

    if (rows.length === body.length && body.length > 0) {
      // Not fatal -- just worth knowing that their response shape moved.
      // Returned rows are unaffected.
      this.lastParseNote = 'legal notice element was absent from the response';
    }

    return rows;
  },

  normalize(item) {
    return {
      // Their field is `position`, not `title`.
      title: item.position,
      company: item.company,
      // Location is frequently a trailing-comma fragment such as "Sydney, ".
      // cleanText collapses whitespace; we strip the dangling comma so the
      // dashboard does not render "Sydney,".
      location: cleanText(item.location).replace(/,\s*$/, '') || 'Remote',
      url: item.url,
      // Both `epoch` (Unix seconds) and `date` (ISO) are present. We prefer
      // epoch because it is unambiguous, and fall back to date if a row is
      // missing it.
      postedAt: item.epoch || item.date,
    };
  },
};
