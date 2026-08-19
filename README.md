# Job Ingestion

A resilient ingestion pipeline that pulls live job listings from three public
sources, normalises them into one schema, and — the actual point — **makes its
own failures visible instead of hiding them**.

**Live demo:** https://job-ingestion-hgqi.onrender.com
**Design document:** [DESIGN.md](DESIGN.md) · **Decisions:** [DECISIONS.md](DECISIONS.md)

---

## What this is

The brief was "get data out of a platform that doesn't want to give it to you."
The interesting half of that problem is not parsing — it is staying alive:
pacing, identity, retries, breakers, and knowing the difference between *"no
jobs today"* and *"we just got blocked."*

Per the scope guardrail, the live demo runs against **benign public sources
that permit programmatic access**. LinkedIn, Indeed and Naukri are not touched.
[DESIGN.md](DESIGN.md) covers how the same pattern would apply to a hostile
target, and where I would stop.

### Sources

| Source | Format | robots.txt (checked 2026-08-19) |
|---|---|---|
| [Arbeitnow](https://www.arbeitnow.com) | JSON API | `Disallow:` (empty — allows all) |
| [Remote OK](https://remoteok.com) | JSON API | `Allow: /` — attribution required by their API terms |
| [We Work Remotely](https://weworkremotely.com) | RSS / XML | `Allow: /` |

The third source is XML on purpose. With three JSON feeds every `normalize()`
would look alike and the shared-schema abstraction would be decorative rather
than load-bearing.

---

## Running locally

Requires **Node 18+** (uses built-in `fetch` and `AbortSignal.timeout`).

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # same, with --watch
```

The first ingest runs at startup, then every 10 minutes. Data lands in
`data/store.json`.

```bash
PORT=8080 INGEST_INTERVAL_MS=60000 npm start
```

---

## Proving it works (the 60-second demo)

The point of this project is resilience, so there is a switch that breaks a
source on demand. Faults are injected **inside our own client**, before the
network call — no request is sent to the real source while chaos is armed.

```bash
# 1. Everything healthy   (swap in the live URL to run this against production)
curl localhost:3000/api/health | jq '.overall, .totalJobs'

# 2. Break a source: it starts returning 403
curl -X POST localhost:3000/api/chaos \
  -H 'content-type: application/json' \
  -d '{"source":"remoteok","mode":"forbidden"}'

# 3. Run three times — the breaker trips on the third consecutive failure
for i in 1 2 3; do
  curl -sX POST localhost:3000/api/ingest \
    -H 'content-type: application/json' -d '{"source":"remoteok"}' | jq -r .status
done
# BLOCKED, BLOCKED, BLOCKED

# 4. Now it fails fast — no request sent, no timeout burned
curl -sX POST localhost:3000/api/ingest \
  -H 'content-type: application/json' -d '{"source":"remoteok"}' | jq '.status, .jobCount'
# "CIRCUIT_OPEN", 100   <- stored jobs still served

# 5. Full run: the healthy sources carry it, and the summary says so
curl -sX POST localhost:3000/api/ingest | jq '{totalJobs, servedFresh, servedStale, failedOver}'

# 6. Reset
curl -X POST localhost:3000/api/chaos/reset
```

### The mode that matters most

`forbidden` and `rate_limit` are the loud failures. The genuinely dangerous
one is **`empty`** — HTTP 200 with zero results:

```bash
curl -X POST localhost:3000/api/chaos \
  -H 'content-type: application/json' \
  -d '{"source":"arbeitnow","mode":"empty"}'
curl -sX POST localhost:3000/api/ingest \
  -H 'content-type: application/json' -d '{"source":"arbeitnow"}' | jq '.status, .jobCount, .lastRun.persisted'
```

A naive pipeline records this as success, writes zero jobs over yesterday's
good data, and shows green. This one returns `DEGRADED`, refuses to persist,
and keeps all 175 stored listings.

`schema_drift` is the same trap wearing a better disguise: 40 well-formed rows
with every field renamed. Volume checks pass; only schema validation catches
it.

**Chaos auto-disarms after 5 minutes**, so a demo left in a broken state heals
itself.

---

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness — is the process up (used by Render) |
| `GET` | `/api/health` | Per-source status, limiter, breaker, identity, scheduler |
| `GET` | `/api/jobs` | Normalised listings. `?source=` `?q=` `?limit=` (max 500) |
| `GET` | `/api/sources` | Provenance: format, robots policy, attribution owed |
| `GET` | `/api/events` | Rolling activity log |
| `POST` | `/api/ingest` | Run now. Optional `{"source":"..."}` |
| `POST` | `/api/chaos` | `{"source":"...","mode":"..."}` |
| `POST` | `/api/chaos/reset` | Disarm everything, reset all breakers |

Chaos modes: `off`, `rate_limit`, `forbidden`, `empty`, `schema_drift`,
`server_error`.

---

## How it fits together

```
scheduler ──> pipeline ──> for each source:
                             │
                             ├─ resilientFetch ─┬─ circuit breaker  (may we ask?)
                             │                  ├─ token bucket + jitter (pacing)
                             │                  ├─ identity pool    (who are we?)
                             │                  ├─ chaos or network
                             │                  └─ retry / backoff / Retry-After
                             ├─ adapter.parse      (format)
                             ├─ adapter.normalize  (field mapping)
                             ├─ validateBatch      (yield + valid ratio)
                             ├─ classifyRun        (HEALTHY / DEGRADED / ...)
                             └─ persist ONLY IF the run earned it
```

`src/fetcher/` holds every cross-cutting concern, so an adapter knows only its
URL and its field names — about 40 lines each. There is no unprotected path to
the network in this codebase, which means a rushed new adapter *cannot* skip
the polite behaviour.

| File | Role |
|---|---|
| `config.js` | Every tunable number, in one place |
| `jobSchema.js` | Canonical `Job` + validation (returns a *ratio*, not just rows) |
| `store.js` | In-memory state, atomic JSON snapshot |
| `fetcher/identities.js` | Coherent header bundles, sticky sessions, rotation |
| `fetcher/rateLimiter.js` | Token bucket + jitter |
| `fetcher/backoff.js` | Full-jitter exponential backoff, `Retry-After` |
| `fetcher/circuitBreaker.js` | CLOSED → OPEN → HALF_OPEN state machine |
| `fetcher/httpClient.js` | Composes all of the above into one call |
| `sources/*.js` | Three adapters |
| `health.js` | Turns a response into an honest status |
| `pipeline.js` | Orchestration + failover |

---

## Deploying

Render Blueprint is committed as [`render.yaml`](render.yaml). Connect the repo
in Render and it picks it up; free plan, no database.

The health check points at `/healthz` (process alive) rather than
`/api/health` (data quality) — otherwise one degraded source could fail an
otherwise perfect deploy.

---

## Known limitations, stated rather than hidden

- **Storage is a JSON file, and Render's free disk is ephemeral.** The store
  resets on redeploy and cold start. Acceptable for a demo — the scheduler
  refills it in seconds — and `store.js` is the only file that would change if
  this needed real durability.
- **The free instance sleeps after inactivity**, so the scheduler only runs
  while the service is awake. A cold request triggers a startup ingest, so the
  data a visitor sees is fresh, but it is not a continuously running crawler.
- **Identity rotation is real but unexercised against the live sources.** I
  tested all three with no User-Agent, curl's default, and a `python-requests`
  UA — all returned identical 200s. They do not fingerprint us, so rotation is
  demonstrated against chaos mode rather than pretended into the demo.
- **TLS/JA3 fingerprinting and HTTP header ordering are not addressed.** Node's
  `fetch` exposes neither. These are among the strongest real-world detection
  signals and are covered in DESIGN.md §1 as conscious omissions rather than
  oversights.
- **Jitter is uniform, not log-normal.** A large improvement on a constant
  delay; not indistinguishable from human traffic.
- **Chaos endpoints are unauthenticated.** Reasoning and mitigations in
  DESIGN.md §4.
- **One page per source.** Arbeitnow paginates; we take page 1. Full coverage
  belongs as one queued job per page so pacing and the breaker still apply per
  request — not a loop inside the adapter.
