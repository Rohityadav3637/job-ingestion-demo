# Design Document

**Project:** resilient job-listing ingestion
**Live demo:** https://job-ingestion-hgqi.onrender.com · **Repo:** https://github.com/Rohityadav3637/job-ingestion-demo

This document covers four things: what gives an automated client away, how this
system pulls data without becoming a nuisance, what keeps it running when a
source changes or disappears, and where I stop.

**Scope note up front.** The live demo runs against three public sources that
publish open, unauthenticated feeds: Arbeitnow, Remote OK, and We Work
Remotely. It does not touch LinkedIn, Indeed, Naukri or Wellfound. Sections 1
and 2 describe how the same pattern applies to a hostile target; section 4 is
about the difference between those two situations, which I think is the real
question being asked.

---

## Architecture

```
                          ┌───────────────┐
                          │   scheduler   │  every 10 min, overlap-guarded
                          └───────┬───────┘
                                  ▼
                          ┌───────────────┐
                          │   pipeline    │  sequential, staggered
                          └───────┬───────┘
                                  │  for each source
        ┌─────────────────────────▼─────────────────────────┐
        │                 resilientFetch                     │
        │                                                    │
        │  1  circuit breaker  ── may we ask at all? ────────┼──► CIRCUIT_OPEN
        │  2  token bucket + jitter  ── pacing               │    (0 ms, no
        │  3  identity pool  ── coherent headers, sticky     │     request sent)
        │  4  chaos injector  ── demo faults, local only     │
        │  5  fetch  ── with timeout                         │
        │  6  classify  ── 429 pauses bucket, 403 rotates    │
        │  7  retry  ── full-jitter backoff / Retry-After    │
        │  8  report  ── unconditionally, to the breaker     │
        └─────────────────────────┬─────────────────────────┘
                                  ▼
              adapter.parse ──► adapter.normalize ──► validateBatch
                                  │                        │
                                  │              yield + valid ratio
                                  ▼                        ▼
                          ┌──────────────────────────────────┐
                          │           classifyRun            │
                          │  HEALTHY / DEGRADED / BLOCKED /  │
                          │  RATE_LIMITED / CIRCUIT_OPEN /   │
                          │  ERROR                           │
                          └───────────────┬──────────────────┘
                                          │ shouldPersist?
                              ┌───────────┴───────────┐
                            yes                       no
                              │                        │
                        replace jobs           keep last-known-good
                              │                        │
                              └───────────┬────────────┘
                                          ▼
                                    store  ──►  API  ──►  dashboard
```

The important structural property: `resilientFetch` is the **only** path to the
network in the codebase. An adapter knows its URL and its field names and
nothing else, so a new source inherits pacing, retries, identity and the
breaker automatically — and cannot skip them even by accident.

---

## 1. Detection surface

A server deciding whether a client is automated has signals at four layers.
Below is what each layer offers, what this design does about it, and — the part
I care more about — what it deliberately does not.

### 1.1 Transport layer (TLS / TCP)

| Signal | How it identifies you | This design |
|---|---|---|
| **JA3 / JA4 TLS fingerprint** | The cipher suites, extensions, elliptic curves and their **order** in your ClientHello are a stable hash. Chrome's differs from curl's, which differs from Node's. A UA claiming Chrome over a Node TLS handshake is a direct contradiction. | ❌ **Not addressed** |
| **HTTP/2 SETTINGS fingerprint** | Frame order, window sizes and pseudo-header order differ per client stack. Same idea, one layer up. | ❌ **Not addressed** |
| **TCP/IP stack (p0f)** | Initial window size, TTL, MSS leak the OS. | ❌ Not addressed |

**Why not.** Node's `fetch` gives no control over the TLS ClientHello. Matching
Chrome's JA3 requires either a patched TLS stack (`curl-impersonate`, a Go
client with a custom uTLS profile) or driving a real browser. Both are real
answers to a real problem — and both are a different project than this one.

I would rather state plainly that JA3 is unaddressed than ship a UA-rotation
layer and let it imply I had solved fingerprinting. **Against a serious target,
TLS fingerprinting alone defeats everything else in this document.** That is
the single most important honest sentence here.

### 1.2 HTTP layer

| Signal | How it identifies you | This design |
|---|---|---|
| **Header coherence** | Chromium sends `sec-ch-ua`; Firefox and Safari never do. Chrome's `Accept-Language` defaults to `q=0.9`, Firefox's to `q=0.5`. A Chrome UA arriving without client hints is *more* conspicuous than no UA at all. | ✅ **Addressed.** Identities are stored as whole bundles; a bare UA string exists nowhere in the codebase, so the mismatch is unrepresentable rather than merely discouraged. |
| **Missing headers** | Browsers always send `Accept`, `Accept-Language`, `sec-fetch-*`. HTTP libraries send almost nothing. | ✅ Addressed. Full plausible header set per identity. |
| **Header order** | Browsers emit headers in a stable, engine-specific order. Libraries use insertion or alphabetical order. | ❌ **Not addressed** — Node's `fetch` does not expose ordering. |
| **`Accept-Encoding` mismatch** | Claiming `br` and then failing to decode Brotli is a tell. | ⚠️ Sidestepped: we let Node own the header and the decompression rather than claiming support we might not honour. |

### 1.3 Behavioural layer

This is where most naive scrapers actually die, and where a client that cannot
control its TLS fingerprint can still do a lot of good.

| Signal | How it identifies you | This design |
|---|---|---|
| **Interval regularity** | Requests at 3.000s intervals have near-zero variance. Humans never produce that, and variance is cheap to compute server-side. | ✅ Randomised jitter before every request. Measured: mean 891 ms, **σ = 348 ms** (a constant delay gives σ = 0). |
| **Burst on the tick** | Three simultaneous requests the instant a timer fires is a machine signature. | ✅ Sources run sequentially with a 2 s stagger, never `Promise.all`. |
| **Sustained rate** | Volume no human could produce. | ✅ Token bucket per source: burst ≤ capacity, long-run average capped at the refill rate. |
| **No idle periods** | Identical traffic at 04:00 and 14:00 is not a person. | ⚠️ **Partially.** We poll on a flat 10-minute schedule. A diurnal profile would be more convincing and is not implemented. |
| **No asset loading** | A real browser fetches CSS, JS, fonts and images alongside the HTML. Fetching only the document is a strong signal. | ❌ Not addressed — irrelevant for API/RSS endpoints, would matter against HTML scraping. |
| **Crawl shape** | Perfectly breadth-first traversal, no dead ends, no back-navigation. | ➖ N/A: we hit fixed endpoints, we do not crawl. |

### 1.4 Identity and network layer

| Signal | How it identifies you | This design |
|---|---|---|
| **IP reputation / ASN** | A datacenter ASN (AWS, Render, Hetzner) is trivially separable from residential. Many defences start here and never look further. | ❌ **Not addressed.** The demo runs from one Render datacenter IP. See below. |
| **Per-IP rate correlation** | All identities sharing one IP defeats the rotation entirely. | ⚠️ Acknowledged, not solved. Rotation without IP diversity is theatre against a serious target. |
| **Session continuity** | A client whose UA changes between two requests from the same IP is not a browser. | ✅ **Addressed.** Identities are sticky per source and rotate on a *reason* (403/429), on use count (25), or on age (30 min) — never per request. |
| **Cookie handling** | Real browsers accept, persist and return cookies. | ➖ N/A here (no cookies issued); for a hostile target this needs a persistent jar bound to each identity. |

**On IP rotation.** The honest position: I have not implemented it, and I have
not simulated it either. A residential proxy pool is the standard answer and it
is also the point where scraping stops being a technical exercise and starts
being a commercial one, with real questions about how those residential IPs
were obtained. Section 4 covers where that sits relative to my line.

### 1.5 Browser layer — why not using a browser is a design position

Not using a headless browser means this system has **no** headless fingerprint
surface at all: no `navigator.webdriver`, no canvas/WebGL entropy, no missing
plugin arrays, no CDP artifacts, no timezone/locale contradictions.

That is a genuine advantage, and it comes with a genuine cost: **we cannot
execute JavaScript, so any JS challenge or client-rendered page is simply out
of reach.** For a target that serves data through an API or feed, that trade is
strongly favourable. For one that renders everything client-side behind a
challenge, it is disqualifying, and the answer is a browser tier — which brings
back every fingerprint in this section.

### 1.6 What the live demo actually proves

I tested all three sources with no `User-Agent`, with curl's default UA, and
with `python-requests/2.31.0`. **All three returned identical HTTP 200s.**

So: these sources do not fingerprint us. The identity layer is real, unit
tested, and **unexercised in production**. I could have pointed it at them and
shown "rotation working"; that would have demonstrated nothing except that the
code runs. Instead rotation is demonstrated against the chaos injector, where a
403 provably triggers it, and this document says which parts of the design are
evidence and which are argument.

---

## 2. Ingestion strategy

### 2.1 Prefer the front door

```
  Tier 1   Official / public API        ← Arbeitnow, Remote OK
  Tier 2   RSS / sitemap / feed         ← We Work Remotely
  Tier 3   HTML parsing                 (not needed here)
  Tier 4   Headless browser             (not implemented; see §1.5)
```

Every tier down costs more requests, more fragility, and more of the source's
goodwill. All three sources here are tier 1 or 2, which is why the demo is
boring to run and hard to break — the correct outcome.

### 2.2 Pacing

| Control | Setting | Why |
|---|---|---|
| Token bucket | capacity 2–3, refill 6–20/min per source | Burst when idle, hard ceiling on the long-run average |
| Jitter | uniform 300–1500 ms | Destroys interval regularity (§1.3) |
| Stagger | 2 s between sources | No synchronised burst on the timer tick |
| Poll interval | 10 min | These feeds change hourly at most; faster adds load for zero information |
| Timeout | 15 s | A hung socket must not stall the run indefinitely |
| Overlap guard | one run at a time | Otherwise a *slow* source causes *more* traffic |

**Jitter is uniform, not log-normal.** Human inter-action timing has a long
tail; uniform does not reproduce that. It is a large improvement on a constant
delay and it is not indistinguishable from a person.

### 2.3 Identity management

Two pools, one mechanism:

- **`honest`** — `job-ingestion/1.0 (+<repo URL>)`. Used by all three real
  sources. They do not ask us to prove we are a browser, so we do not pretend
  to be one, and a source operator who wants to identify or rate-limit this
  client can.
- **`browser`** — coherent Chrome/Firefox/Safari bundles for the hostile case.
  Built and tested; in this project only ever aimed at the chaos injector.

Switching a source between them is a one-word config change, not a code change.
Rotation triggers: a 403/429 (identity may be burned), 25 uses, or 30 minutes.
Sessions are keyed **per source**, so being blocked by one never discards an
identity another is happy with.

### 2.4 Plan B: what happens when a source shuts us out next week

The instinct is to answer with better evasion. I think that is the wrong answer
architecturally and the wrong answer commercially, because it is a race you
re-run every quarter against a better-funded opponent.

**The durable Plan B is source diversity.** Losing one of three sources costs
27% of listings, not 100%, and the breaker makes that degradation automatic
rather than an outage. A fourth source is one file, roughly forty lines. That
is a property of the architecture, not a promise.

The escalation ladder, in the order I would actually try it:

```
  B1  Back off             halve the rate, add a diurnal profile,
                           poll during their quiet hours
  B2  Change the door      RSS instead of API, sitemap, partner feed,
                           regional endpoint
  B3  Rotate identity      within a bounded, coherent pool
  B4  Add sources          HN "Who is hiring" via the Algolia API is
                           already scoped and held in reserve; also
                           Greenhouse / Lever / Ashby public boards,
                           which are per-company and rarely defended
  B5  Ask                  request an API key, a partner feed, or a
                           commercial agreement. Boring, and the only
                           option that is stable in twelve months
  ────────────────────────────────────────────────────────────────────
      ↓ below this line I stop — see §4
  ✗   Residential proxy rotation to defeat a deliberate block
  ✗   CAPTCHA-solving services
  ✗   Authenticated scraping / borrowed credentials
  ✗   TLS impersonation specifically to evade a block that names us
```

B4 is the one that actually pays. If ingestion is a business input, the
resilient design is *many shallow sources*, not one deep and adversarial one.

---

## 3. Resilience

The design goal is not "never fails." It is **"never fails silently."** Every
failure below has a detector, a response, and a place it becomes visible to a
human.

### 3.1 Failure catalogue

| Failure | How we detect it | Response | Where it shows |
|---|---|---|---|
| **Markup / schema change** | `validRatio` — rows arrive, most fail schema validation | `DEGRADED`; persist only the rows that passed; keep the rest of the stored set | Card shows *"Only 12 of 40 listings passed validation (30%)… probably renamed or removed fields"* + sample rejection reasons |
| **Response format change** | `parse()` **throws** (deliberately not `return []`) | `DEGRADED`, nothing persisted | Card shows the parser's own error message |
| **Rate limited (429)** | Status + `Retry-After` | Pause the **whole source's** bucket for the stated duration; do not sleep in-run; breaker counts it | `RATE_LIMITED` + limiter shows the pause |
| **Blocked (403/401)** | Status | Rotate identity; do **not** retry (same request earns the same answer); breaker counts it | `BLOCKED` |
| **Repeated failure** | 3 consecutive | Breaker opens: requests refused in 0 ms without being sent; cooldown doubles per failed probe | `CIRCUIT_OPEN` + countdown |
| **Empty 200** | `receivedCount === 0` | `DEGRADED`, **refuse to persist** | *"either a genuinely empty feed or a silent block — we cannot tell from here, so previously stored jobs are kept"* |
| **Low yield** | `validCount < minExpectedJobs` | `DEGRADED`, but persist (data is real) | Card shows expected vs actual |
| **Timeout / socket** | `AbortSignal.timeout`, error codes | Full-jitter exponential backoff, 3 attempts | `TIMEOUT` / `NETWORK_ERROR` |
| **Run outlasts interval** | Scheduler `running` flag | Skip the overlapping run | `warn` event |
| **Our own bug** | `TypeError` is classified non-retryable | Fail fast and loudly rather than retrying a bug behind a delay | `error` event |

### 3.2 The rule that protects the data

```js
if (health.shouldPersist && validation && validation.jobs.length > 0)
```

Blocked, rate-limited, circuit-open and empty-200 runs **do not get to replace
stored jobs.** And `lastSuccessAt` advances only on a genuinely healthy run, so
a source serving 175 stored listings while its last real success was an hour
ago says exactly that on the dashboard. Serving stale data silently is the same
sin as reporting empty-as-success, just slower.

### 3.3 Failover

There is no primary source to fall back *from* — the three are peers and the
aggregate feed is the product. Failover is three concrete properties:

1. `runSource` never throws, so one source dying cannot abort the run
2. A circuit-open source is skipped in **0 ms** rather than burning 3 × 15 s of
   timeouts, so a dead source costs the run essentially nothing
3. The run summary separates `servedFresh` from `servedStale`, so *"375 jobs"*
   can never hide that a third of them are an hour old

### 3.4 Proving it rather than claiming it

Chaos mode injects `429 / 403 / 503 / empty-200 / schema-drift` **inside our own
client, before the network call** — no request reaches a real source during a
demo. It returns genuine `Response` objects, so chaos integration is one
expression in `httpClient` and every downstream layer runs its normal path
rather than a test-only branch. Faults auto-disarm after five minutes.

### 3.5 Three bugs this philosophy caught in my own code

Worth recording, because they are all the same bug wearing different clothes —
**a comparison against a missing value is `false`, so the guard fails open and
the system reports healthy:**

1. `0/0 = NaN`, and every comparison with `NaN` is false — an empty batch would
   have passed the `validRatio < 0.7` check and reported HEALTHY.
2. A shallow settings spread left `refillPerMinute` undefined →
   `refillPerMs = NaN` → `setTimeout(NaN)` = 0. The rate limiter silently
   became a no-op, with no crash and nothing in the logs.
3. `classifyRun` read `source.minValidRatio`, which adapters never set — so
   `0 < undefined` was false and **schema-drift detection was entirely
   disabled**. It only appeared to work because the low-yield check caught the
   same case for the wrong reason.

Also found by testing against live data rather than documentation: Remote OK's
array element `[0]` is a legal notice rather than a job, and `fast-xml-parser`
crashed on the real We Work Remotely feed with *"Entity expansion limit
exceeded: 1086 > 1000"* — a limit that exists to stop billion-laughs XML bombs.
Neither is discoverable from a mock.

---

## 4. Where I would stop

### 4.1 The line

I will engineer around **incidental obstacles** — flaky networks, rate limits,
format changes, ambiguous data. Those are the source's systems behaving
imperfectly, and working around them harms nobody.

I will not engineer around a **deliberate access decision**. A login wall, a
CAPTCHA, or a block that specifically names my client is the operator saying
*no*. Routing around that is not a technical problem I happen to be able to
solve; it is a consent problem I have decided to ignore. That distinction is
the whole of my personal line, and everything below follows from it.

### 4.2 How the design encodes it

| Commitment | Where it lives in the code |
|---|---|
| Only public endpoints published for programmatic consumption | Three fixed URLs in `sources/*.js`; no discovery, no crawling |
| robots.txt respected | Fetched and read by hand 2026-08-19, recorded with a date beside each adapter |
| No authenticated scraping | No credential handling exists anywhere in the codebase |
| No CAPTCHA circumvention | No browser tier, no solver integration, no path to one |
| Identify ourselves | `job-ingestion/1.0 (+repo URL)` on every real request |
| Stay well under any plausible limit | Token bucket + 10-minute interval |
| Honour attribution terms | Remote OK's required do-follow link is rendered on the dashboard from adapter config |
| Stop when told to stop | Breaker opens after 3 consecutive failures and backs off with escalating cooldown |
| Be reachable | The contact URL in our UA is a real repo |

### 4.3 The grey area, stated rather than glossed

**Rotating identity on a 403 is evasion-shaped.** I want to be straight about
it rather than let it sit quietly in `httpClient.js`.

The mitigations are structural, not merely intended: the pool is small and
bounded (3 identities, not thousands), all real sources run the single-identity
`honest` pool where rotation is a no-op, and — the part that matters — **the
circuit breaker counts 403s regardless of rotation.** After three we stop
entirely and back off with a doubling cooldown. The system therefore cannot
grind through faces looking for one that works; it tries at most a couple and
then respects the answer.

If a source blocked us and I believed the block was deliberate and aimed at us,
the correct action is to stop and email them, not to widen the pool. The honest
UA exists precisely so that conversation is possible.

### 4.4 On the sources actually used

Every source here publishes an open feed for programmatic consumption. Remote
OK's API terms ask for attribution and a followable link back; that is honoured
in the UI, from adapter config, so a future source's terms are a data change
rather than something someone has to remember to hand-edit.

The scope guardrail in the brief said to demo against a low-risk source rather
than a live LinkedIn account. I would have chosen the same constraint
unprompted: there is no version of this exercise where breaching someone's ToS
on a reviewer's behalf demonstrates good judgment.

### 4.5 Known compromise: the chaos endpoints are unauthenticated

`POST /api/chaos` mutates state without auth, which is normally indefensible.
The reasoning: a reviewer must be able to break a source for the demo to prove
anything, and a password in a README submitted alongside the URL is theatre.

Mitigations: blast radius is one demo instance holding public job listings;
every chaos action is logged at `warn` and displayed on the dashboard; faults
auto-disarm after five minutes; one-click reset. **If this held anything
private, or if a bad state cost more than five minutes, it would need auth.**
Recording that here rather than waiting for someone to find it.
