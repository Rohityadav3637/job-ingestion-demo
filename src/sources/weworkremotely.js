// sources/weworkremotely.js
//
// We Work Remotely -- an RSS feed, not a JSON API.
// https://weworkremotely.com/remote-jobs.rss
//
// WHY A THIRD SOURCE IN A DIFFERENT FORMAT WAS A DELIBERATE CHOICE:
// With three JSON feeds, every adapter's normalize() would look nearly
// identical and the "one canonical Job schema" abstraction would be
// decorative -- it would look like architecture without doing any work.
// An XML source forces the boundary to be real. Everything downstream of
// normalize() -- validation, dedupe, storage, the dashboard, the API -- is
// completely unaware that one of its three sources is not JSON.

import { XMLParser } from 'fast-xml-parser';
import { cleanText } from '../jobSchema.js';

/**
 * WHY processEntities IS FALSE -- and this is not a style preference.
 *
 * The first time I parsed this feed for real it CRASHED:
 *
 *   Error: Entity expansion limit exceeded: 1086 > 1000
 *
 * Each <description> carries a full HTML job ad with hundreds of escaped
 * entities, and the parser's default expansion limit exists to stop
 * "billion laughs" XML bombs -- a small document whose entities expand
 * recursively until they exhaust memory.
 *
 * Two ways out: raise the limit, or stop expanding entities. Raising the
 * limit keeps a recursive-expansion attack surface open on third-party XML we
 * do not control, in exchange for decoding a field we never read. Turning
 * expansion off removes the surface entirely and is faster.
 *
 * The cost is that the five predefined XML entities arrive literal --
 * "Product &amp; Strategy" -- so we decode exactly those five, by hand, below.
 * That substitution is flat and non-recursive, so it cannot be made to expand.
 *
 * This is worth knowing because it is a bug the demo would only have hit in
 * production: it needs a real feed with real ad copy to trigger.
 */
const parser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  processEntities: false,
});

/**
 * Decode only the five entities XML itself defines.
 *
 * Deliberately NOT a general HTML entity decoder. This handles what the
 * feed actually contains in the fields we use, and nothing recursive.
 * `&amp;` is replaced LAST so that "&amp;lt;" decodes to the literal text
 * "&lt;" rather than being double-decoded into "<".
 */
function decodeXmlEntities(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export const weworkremotely = {
  id: 'weworkremotely',
  label: 'We Work Remotely',
  homepage: 'https://weworkremotely.com',
  format: 'RSS / XML',
  url: 'https://weworkremotely.com/remote-jobs.rss',
  accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',

  robots: {
    checkedOn: '2026-08-19',
    policy: 'User-agent: * / Allow: /   (only /admin/, /account/ and profile paths disallowed)',
    note: 'An RSS feed is published specifically to be consumed by automated clients.',
  },

  attribution: {
    required: false,
    text: 'Jobs via We Work Remotely',
    url: 'https://weworkremotely.com',
  },

  settings: {
    rateLimit: { capacity: 2, refillPerMinute: 6 },
  },

  minExpectedJobs: 20,

  parse(bodyText) {
    const doc = parser.parse(bodyText);

    const channel = doc && doc.rss && doc.rss.channel;
    if (!channel) throw new Error('expected rss > channel in the response');

    const items = channel.item;
    if (!items) throw new Error('no <item> elements in the feed');

    // fast-xml-parser returns a bare OBJECT when there is exactly one <item>,
    // and an ARRAY when there are several. Code written against the 100-item
    // case breaks the day the feed is quiet -- and breaks in the confusing way,
    // by iterating the object's keys. Normalising here means the rest of the
    // adapter only ever sees an array.
    return Array.isArray(items) ? items : [items];
  },

  normalize(item) {
    // WWR encodes the company in the title: "Acme Corp: Senior Engineer".
    // I verified this against the live feed -- all 100 of 100 items matched
    // the pattern -- but the code does not assume it holds forever.
    const rawTitle = decodeXmlEntities(cleanText(item.title));
    const separator = rawTitle.indexOf(':');

    let company = '';
    let title = rawTitle;

    if (separator > 0) {
      company = rawTitle.slice(0, separator).trim();
      title = rawTitle.slice(separator + 1).trim();
    }
    // No colon -> company stays empty and validateJob rejects the row, which
    // shows up in the invalid count. That is the correct outcome: better one
    // visibly rejected listing than a row claiming the company is the whole
    // title string. Splitting on the FIRST colon matters too, because roles
    // legitimately contain colons later in the string.

    // region / country / state are separate elements and any of them can be
    // an empty string. We take the first that has content.
    const location =
      cleanText(item.region) || cleanText(item.country) || cleanText(item.state) || 'Remote';

    return {
      title,
      company,
      location: decodeXmlEntities(location),
      url: item.link,
      // RFC-822: "Tue, 18 Aug 2026 21:22:10 +0000". toIsoDate handles it.
      postedAt: item.pubDate,
    };
  },
};
