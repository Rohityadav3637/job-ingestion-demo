# Decisions

## 1. Why this ingestion strategy, and what I rejected

**Chosen:** a thin, honest HTTP client with the resilience in a shared layer —
token bucket, jitter, coherent sticky identities, full-jitter backoff, and a
per-source circuit breaker — pointed at public APIs and feeds. Adapters know
only their URL and field names; `resilientFetch` is the only path to the
network, so a new source inherits every protection and cannot skip it.

**Rejected: Playwright with stealth patches.** It is the obvious answer and it
was wrong here. It costs a ~400 MB image on a free tier, it cannot run on
Render's free plan comfortably, and — the real objection — it would have been a
*claim* rather than a capability. Driving a headless browser at endpoints that
serve clean JSON buys nothing, while adding an enormous fingerprint surface
(`navigator.webdriver`, canvas/WebGL entropy, CDP artifacts) that I would then
have to defend patch by patch. Not using a browser means there is no headless
fingerprint to detect. The cost is that we cannot execute JS challenges, which
is disqualifying against a client-rendered hostile target and irrelevant here.

**Rejected: aiming the browser identity pool at the real sources.** I tested
all three with no User-Agent, curl's default, and `python-requests/2.31.0` —
identical 200s every time. They do not fingerprint us, so impersonating Chrome
would have been dishonesty that bought nothing. The pool is built and tested
for the hostile case and demonstrated against the chaos injector instead.

**Rejected: better evasion as Plan B.** The durable answer to being blocked is
*source diversity*, not a proxy arms race. Losing one of three sources costs
27% of listings, not 100%, and a fourth source is ~40 lines.

## 2. The trade-off I made under time pressure

**I chose depth on failure semantics over breadth of sources and coverage.**

What that bought: the system distinguishes "blocked" from "rate limited" from
"the feed is genuinely empty" from "they renamed their fields" — and refuses to
overwrite good data on any of them. Empty-200 and schema-drift both arrive as
HTTP 200, and both are caught.

What it cost:
- **One page per source.** Arbeitnow paginates; we take page 1 (175 jobs).
- **No persistent storage.** A JSON file on an ephemeral disk; it resets on
  redeploy. `store.js` is the only file that would change.
- **No automated test suite in the repo.** Every stage was verified with
  throwaway scripts against live data — which found three real bugs — but that
  verification is not committed as tests.

**With a real week:** the test suite first, as fixture-driven parser tests so
schema drift is caught in CI rather than in production. Then Postgres and a
queue, with one job per page so pacing and the breaker apply per request rather
than per source. Then a diurnal request profile, since a flat 10-minute
interval is still a behavioural signature. Then a proper `robots.txt`
fetch-parse-cache module — currently a dated manual check, which is honest for
three fixed endpoints and insufficient the moment URLs are discovered.

## 3. Where I used AI, and what I verified myself

I used Claude throughout, as a pair-programmer: I described what each module
had to do and why, it drafted, and I reviewed every line before it landed. The
architecture, the layer ordering, and every ethical boundary in DESIGN.md are
my calls.

**What I verified personally, and changed as a result:**

- **Every source was probed live before a line of adapter code was written.**
  That is how I found Remote OK's array element `[0]` is a legal notice rather
  than a job, and that `fast-xml-parser` crashes on the real We Work Remotely
  feed with *"Entity expansion limit exceeded: 1086 > 1000"*. Neither is
  discoverable from documentation or a mock.
- **I found and fixed a 60-second stall.** Honouring `Retry-After: 30` by
  sleeping in-run cost 60 s per 429 and held the other two sources hostage. The
  bucket pause was already the durable fix, so past a 5 s ceiling we defer to
  the next scheduled run. 60,000 ms → 57 ms, `Retry-After` still fully honoured.
- **I found that schema-drift detection was silently disabled.** `classifyRun`
  read `source.minValidRatio`, which adapters never set, so the check evaluated
  `0 < undefined` → `false`. It only looked like it worked because the low-yield
  check caught the same case for the wrong reason.
- **I renamed `servedBy` to `servedFresh`/`servedStale`** after noticing the run
  summary listed a circuit-open source as having served the run — true, since
  its stored jobs were still being returned, but it read as a successful fetch
  when no request had been sent.
- **I decided the honest-vs-browser identity split**, and that all real sources
  use the honest pool.

Three of those four bugs are the same shape: **a comparison against a missing
value is `false`, so the guard fails open and the system reports healthy.**
Noticing that pattern in my own code is the thing I would most want to be
judged on here.
