// fetcher/identities.js
//
// WHY THIS FILE EXISTS:
// A server deciding whether we are a bot does not look at our User-Agent in
// isolation. It looks at whether the whole BUNDLE of headers corresponds to a
// browser that actually exists.
//
// A real browser emits its headers from one engine, so they are internally
// consistent by construction:
//   - Chromium browsers send `sec-ch-ua` client hints. Firefox and Safari
//     NEVER do.
//   - Chrome defaults to `Accept-Language: en-US,en;q=0.9`.
//     Firefox defaults to `en-US,en;q=0.5`.
//   - Each engine has its own distinctive `Accept` string for documents.
//
// So the beginner move -- copy a Chrome UA string onto an HTTP client and send
// nothing else -- is worse than sending no UA at all. You have now claimed to
// be Chrome while omitting every header Chrome always sends. That is not
// invisible, it is conspicuous. The tell is not a FAKE User-Agent, it is an
// INCOHERENT one.
//
// This module therefore stores whole identities, never loose UA strings. You
// cannot accidentally mix a Firefox UA with Chrome client hints, because the
// two never exist as separate values anywhere in the codebase.

import { config } from '../config.js';

// --------------------------------------------------------------------------
// THE ETHICAL DECISION IN THIS FILE, STATED PLAINLY
// --------------------------------------------------------------------------
// There are two pools.
//
// `honest` identifies this project by name with a contact URL. Every REAL
// source in this project uses it. Arbeitnow, RemoteOK and We Work Remotely all
// publish open feeds and none of them fingerprint us -- I tested that directly
// (no User-Agent, curl's default UA, and a python-requests UA all returned an
// identical 200). They have not asked me to prove I am a browser, so I am not
// going to pretend to be one. If they ever want to rate-limit or block this
// client, the honest UA is what makes that possible for them, and I think they
// are entitled to that.
//
// `browser` is a coherent set of real browser fingerprints. It is the pattern
// you would need against a genuinely hostile target, so it is fully built and
// fully tested -- but in this project it is only ever pointed at our own chaos
// endpoint. That way the rotation machinery is demonstrated live and honestly,
// without misrepresenting ourselves to anyone who did not ask for it.
//
// Same rotation code drives both. Only the pool contents differ.
// --------------------------------------------------------------------------

/**
 * Coherent browser identities.
 *
 * Note what is DELIBERATELY ABSENT from the Firefox and Safari entries:
 * no `sec-ch-ua`, no `sec-ch-ua-mobile`, no `sec-ch-ua-platform`. Those are
 * Chromium-only. Including them would be exactly the incoherence described
 * above, and there is a test in this project that asserts they stay absent.
 */
const BROWSER_IDENTITIES = [
  {
    id: 'chrome-131-win',
    label: 'Chrome 131 / Windows',
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'upgrade-insecure-requests': '1',
    },
  },
  {
    id: 'firefox-133-mac',
    label: 'Firefox 133 / macOS',
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
      // Firefox's real default q-value is 0.5, not Chrome's 0.9.
      'accept-language': 'en-US,en;q=0.5',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'upgrade-insecure-requests': '1',
    },
  },
  {
    id: 'safari-18-mac',
    label: 'Safari 18 / macOS',
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
      'accept-language': 'en-GB,en;q=0.9',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    },
  },
];

/**
 * The honest pool. One entry, because there is nothing to vary: we are not
 * hiding, so there is no signature to spread out.
 *
 * The rotation code below still runs against it unchanged -- rotating a
 * one-entry pool is simply a no-op. That is intentional: the mechanism is not
 * special-cased for the honest path, so switching a source to 'browser' mode
 * is a one-word config change, not a code change.
 */
function honestIdentities() {
  return [
    {
      id: 'honest-bot',
      label: 'job-ingestion bot (self-identifying)',
      headers: {
        'user-agent': `job-ingestion/1.0 (+${config.identity.contactUrl})`,
        'accept-language': 'en',
        // A machine-readable hint that this is automated traffic. Some CDNs
        // use it to route bots to cached responses rather than block them.
        'x-robots-purpose': 'job-aggregation-demo',
      },
    },
  ];
}

const POOLS = {
  honest: honestIdentities(),
  browser: BROWSER_IDENTITIES,
};

export function getPool(mode) {
  return POOLS[mode] || POOLS.honest;
}

// --------------------------------------------------------------------------
// STICKY SESSIONS
// --------------------------------------------------------------------------
// The second, less obvious tell: rotating on EVERY request is itself a
// signature. A real browser does not change its User-Agent between two
// requests from the same IP. A client whose UA changes every single time is
// not blending in -- it has swapped one recognisable pattern for a weirder
// one.
//
// So an identity is held per source ("sticky") and rotated for a REASON:
//   - we got blocked, so this identity may be burned  -> rotateIdentity()
//   - it has been used a lot                          -> maxUsesPerIdentity
//   - it has been alive a long time                   -> maxAgeMs
//
// Per SOURCE rather than globally, so being blocked by one source does not
// throw away a perfectly good identity that another source is happy with.
// --------------------------------------------------------------------------

/** sourceId -> { identity, mode, uses, startedAt, rotations } */
const sessions = new Map();

function pickFromPool(pool, previousId) {
  if (pool.length === 1) return pool[0];

  // Avoid handing back the identity we just retired. If we rotate BECAUSE we
  // were blocked, reusing the same identity would make the rotation pointless.
  const candidates = pool.filter((identity) => identity.id !== previousId);
  const usable = candidates.length > 0 ? candidates : pool;
  return usable[Math.floor(Math.random() * usable.length)];
}

function newSession(sourceId, mode, previousId, rotations) {
  const session = {
    identity: pickFromPool(getPool(mode), previousId),
    mode,
    uses: 0,
    startedAt: Date.now(),
    rotations,
  };
  sessions.set(sourceId, session);
  return session;
}

/**
 * Get the identity this source should use right now, rotating if it is due.
 *
 * Increments the use counter, so callers should call this once per request.
 * Returns the identity plus a little session metadata, because the dashboard
 * displays which identity was used -- rotation you cannot see is rotation you
 * cannot demonstrate.
 */
export function getIdentity(sourceId, mode = 'honest') {
  let session = sessions.get(sourceId);

  const expired =
    session &&
    (session.mode !== mode ||
      session.uses >= config.identity.maxUsesPerIdentity ||
      Date.now() - session.startedAt >= config.identity.maxAgeMs);

  if (!session) {
    session = newSession(sourceId, mode, null, 0);
  } else if (expired) {
    session = newSession(sourceId, mode, session.identity.id, session.rotations + 1);
  }

  session.uses += 1;

  return {
    id: session.identity.id,
    label: session.identity.label,
    headers: { ...session.identity.headers },
    uses: session.uses,
    rotations: session.rotations,
  };
}

/**
 * Force a rotation, because we have reason to believe the current identity is
 * burned (a 403, a 429, a challenge page).
 *
 * This is called by the fetcher, not by adapters. An adapter should not have
 * to know identities exist.
 */
export function rotateIdentity(sourceId, reason = 'unspecified') {
  const session = sessions.get(sourceId);
  if (!session) return null;

  const next = newSession(sourceId, session.mode, session.identity.id, session.rotations + 1);
  return {
    from: session.identity.id,
    to: next.identity.id,
    reason,
    rotations: next.rotations,
  };
}

/** Read-only peek for the dashboard and for tests. Does not count as a use. */
export function describeSession(sourceId) {
  const session = sessions.get(sourceId);
  if (!session) return null;
  return {
    identityId: session.identity.id,
    identityLabel: session.identity.label,
    mode: session.mode,
    uses: session.uses,
    rotations: session.rotations,
    ageMs: Date.now() - session.startedAt,
  };
}

/** Used by tests to get a clean slate. */
export function resetSessions() {
  sessions.clear();
}

/**
 * Build the final header set for one request.
 *
 * `accept` is passed in by the caller rather than stored on the identity,
 * because it depends on what we are FETCHING, not on who we are: the RSS
 * adapter wants XML, the API adapters want JSON. A browser varies this header
 * per request too, so keeping it separate is both cleaner and more accurate.
 *
 * DELIBERATELY NOT SET HERE:
 *
 * - `accept-encoding`. Node's fetch sets it and transparently decompresses the
 *   response. If we set it by hand we risk receiving a gzip body that nothing
 *   decodes, turning a working source into mystery garbage. Control over
 *   compression is not worth a decoding bug.
 *
 * - `host`, `connection`, `content-length`. These are forbidden headers -- the
 *   fetch spec makes the runtime own them and silently ignores attempts to set
 *   them. Trying anyway would be code that looks like it does something and
 *   does not, which is the kind of line I do not want in this repo.
 *
 * - Header ORDER. Real browsers emit headers in a stable, engine-specific
 *   order, and that order is itself a fingerprint. Node's fetch does not
 *   expose it. This is a real limitation, it is written up in DESIGN.md
 *   section 1 under what this design consciously does not address, and it is
 *   not something I am going to pretend to have solved.
 */
export function buildHeaders(identity, { accept } = {}) {
  const headers = { ...identity.headers };
  if (accept) headers.accept = accept;
  return headers;
}
