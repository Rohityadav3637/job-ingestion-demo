// sources/index.js
//
// The source registry. Everything that knows "which sources exist" reads from
// here, so adding a fourth source is one import and one array entry.
//
// ------------------------------------------------------------------------
// THE ADAPTER CONTRACT
// ------------------------------------------------------------------------
// Every adapter is a plain object with:
//
//   id              string   stable key, used for buckets, breakers, storage
//   label           string   human name for the dashboard
//   homepage        string   where a human goes to see this source
//   format          string   'JSON API' | 'RSS / XML'  -- shown on the dashboard
//   url             string   the endpoint we fetch
//   accept          string   the Accept header this source should receive
//   robots          object   { checkedOn, policy, note }
//   attribution     object   { required, text, url }
//   settings        object   per-source overrides for the fetcher
//   minExpectedJobs number   below this, the source is DEGRADED not healthy
//
//   parse(bodyText)   -> array of raw source objects.  THROWS if unparseable.
//   normalize(item)   -> { title, company, location, url, postedAt }
//
// parse() and normalize() are separate on purpose. parse() is about the
// TRANSPORT FORMAT (is this valid JSON, valid XML, is the envelope shaped the
// way we expect). normalize() is about FIELD MAPPING. Keeping them apart means
// a schema change shows up as a normalize problem with rows still counted,
// which validateBatch reports as a low valid-ratio -- rather than as a total
// parse failure that tells us nothing about how much of the feed still works.
//
// ------------------------------------------------------------------------
// ON robots.txt: WHY IT IS RECORDED HERE RATHER THAN FETCHED AT RUNTIME
// ------------------------------------------------------------------------
// I fetched and read all three robots.txt files by hand on 2026-08-19 and
// recorded what they say, with the date, next to each adapter.
//
// A runtime robots.txt fetcher-and-parser is genuinely the right answer for a
// crawler that discovers URLs it has never seen. This project has three fixed,
// known endpoints that I have personally checked. Building a parser for
// wildcard rules and crawl-delay directives would be more code -- code I would
// have to defend -- protecting against a case that cannot arise here.
//
// The honest version of this decision is written up in DESIGN.md rather than
// implied by a library import: a dated manual check, recorded in the repo,
// re-checked if a source misbehaves. If this ever grew to discovered URLs, a
// runtime fetch-cache-enforce module becomes mandatory, and it belongs in
// fetcher/ next to the other cross-cutting concerns.

import { arbeitnow } from './arbeitnow.js';
import { remoteok } from './remoteok.js';
import { weworkremotely } from './weworkremotely.js';

export const sources = [arbeitnow, remoteok, weworkremotely];

export function getSourceById(id) {
  return sources.find((source) => source.id === id) || null;
}

export function listSourceIds() {
  return sources.map((source) => source.id);
}

/**
 * The public description of a source -- safe to send to the browser.
 *
 * Deliberately omits parse/normalize (functions do not survive JSON anyway)
 * and exists so the dashboard can render provenance: which sources we pull,
 * in what format, under what robots policy, with what attribution owed.
 * Making that visible on the page is part of the point.
 */
export function describeSource(source) {
  return {
    id: source.id,
    label: source.label,
    homepage: source.homepage,
    format: source.format,
    url: source.url,
    robots: source.robots,
    attribution: source.attribution,
    minExpectedJobs: source.minExpectedJobs,
  };
}
