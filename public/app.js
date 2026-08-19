// app.js
//
// The dashboard's whole client. No framework, no build step, no dependencies.
//
// It does three things: poll the API, render what came back, and send the
// chaos/ingest commands. Everything it displays was already decided by the
// server -- statuses, reasons and counts are computed in health.js and
// pipeline.js. The browser does no interpretation of its own, because two
// places deciding what "degraded" means is two places that can disagree, and
// then the screen stops being evidence.

const REFRESH_MS = 5000;

const CHAOS_MODES = [
  ['off', 'Healthy (no chaos)'],
  ['rate_limit', '429 Rate limited'],
  ['forbidden', '403 Blocked'],
  ['empty', '200 but empty  ← the silent one'],
  ['schema_drift', '200 but fields renamed'],
  ['server_error', '503 Server error'],
];

const $ = (id) => document.getElementById(id);

/**
 * Escape anything that came from a source before putting it in the DOM.
 *
 * Job titles and company names are third-party strings we do not control. Any
 * of them could contain markup, so interpolating them into innerHTML without
 * escaping is a stored-XSS hole -- served from our own origin, which is where
 * the chaos endpoints live. Cheap to prevent, so prevented everywhere.
 */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return response.json();
}

function post(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

// --- rendering ------------------------------------------------------------

function renderOverall(health) {
  const ok = health.overall === 'HEALTHY';
  const box = $('overall');

  box.className = `overall ${ok ? 'is-ok' : 'is-bad'}`;
  $('overall-status').textContent = health.overall;
  $('total-jobs').textContent = health.totalJobs;
  $('source-count').textContent = health.sourceCount;

  $('unhealthy-note').textContent = ok
    ? 'all sources reporting normally'
    : `${health.unhealthyCount} source${health.unhealthyCount === 1 ? '' : 's'} need attention`;

  const next = health.scheduler.nextRunAt;
  $('next-run').textContent = next ? `next scheduled run ${new Date(next).toLocaleTimeString()}` : '';
}

function renderChaosBanner(chaos) {
  const armed = Object.entries(chaos);
  const banner = $('chaos-banner');

  if (armed.length === 0) {
    banner.classList.add('hidden');
    return;
  }

  // Spelling out that nothing is being sent to the real source matters: this
  // is the page that claims to be honest about failure, so a simulated failure
  // has to be labelled as simulated.
  banner.classList.remove('hidden');
  banner.innerHTML =
    `<strong>Chaos mode is armed.</strong> Faults are injected inside this app, before the network call &mdash; ` +
    `no requests are being sent to the real sources. ` +
    armed
      .map(
        ([id, entry]) =>
          `<br><code>${esc(id)}</code>: ${esc(entry.description)} ` +
          `<span class="muted">(auto-disarms in ${Math.ceil(entry.expiresInMs / 1000)}s, ` +
          `${entry.injectedCount} injected)</span>`,
      )
      .join('');
}

function renderSources(sources) {
  $('sources').innerHTML = sources
    .map((source) => {
      const key = source.status.toLowerCase();
      const run = source.lastRun || {};
      const fresh = source.freshness || {};

      // Stale data is called out explicitly. A source can be showing 175 jobs
      // while its last real success was an hour ago, and a screen that does
      // not say so is quietly misleading.
      const staleClass = source.status !== 'HEALTHY' && source.jobCount > 0 ? ' class="stale"' : '';

      const options = CHAOS_MODES.map(
        ([value, label]) => `<option value="${value}">${esc(label)}</option>`,
      ).join('');

      return `
      <article class="card s-${key}">
        <div class="card-head">
          <div>
            <h3>${esc(source.label)}</h3>
            <div class="card-format">${esc(source.format || '')}</div>
          </div>
          <span class="badge b-${key}">${esc(source.status.replace('_', ' '))}</span>
        </div>

        <p class="reason">${esc(source.reason || '')}</p>

        <div class="stats">
          <div><span>Jobs held</span><span${staleClass}>${source.jobCount ?? 0}</span></div>
          <div><span>Last success</span><span${staleClass}>${esc(fresh.label || 'never')}</span></div>
          <div><span>Valid ratio</span><span>${run.validRatio ?? '-'}</span></div>
          <div><span>Received</span><span>${run.receivedCount ?? '-'}</span></div>
          <div><span>Breaker</span><span>${esc(source.breaker ? source.breaker.state : '-')}</span></div>
          <div><span>Failures</span><span>${source.breaker ? source.breaker.consecutiveFailures : '-'}/${source.breaker ? source.breaker.failureThreshold : '-'}</span></div>
          <div><span>Tokens</span><span>${source.limiter ? `${source.limiter.tokensAvailable}/${source.limiter.capacity}` : '-'}</span></div>
          <div><span>Identity</span><span>${esc(source.identity ? source.identity.identityId : '-')}</span></div>
        </div>

        <div class="chaos-row">
          <select data-chaos-for="${esc(source.id)}">${options}</select>
          <button class="btn" data-arm="${esc(source.id)}">Apply</button>
        </div>
      </article>`;
    })
    .join('');

  // Keep each dropdown showing the mode that is actually armed, so the control
  // reflects reality after a refresh rather than resetting to "Healthy" while
  // the source is still broken.
  for (const source of sources) {
    const select = document.querySelector(`[data-chaos-for="${source.id}"]`);
    const armed = window.__chaos && window.__chaos[source.id];
    if (select) select.value = armed ? armed.mode : 'off';
  }
}

function renderJobs(jobs, total) {
  $('jobs-count').textContent = `${jobs.length} shown of ${total}`;

  if (jobs.length === 0) {
    $('jobs').innerHTML = '<div class="empty">No listings match.</div>';
    return;
  }

  $('jobs').innerHTML = jobs
    .map((job) => {
      const posted = job.postedAt ? new Date(job.postedAt).toLocaleDateString() : 'date unknown';
      return `
      <a class="job" href="${esc(job.url)}" target="_blank" rel="noopener">
        <span class="job-src">${esc(job.source)}</span>
        <div class="job-title">${esc(job.title)}</div>
        <div class="job-meta">${esc(job.company)} &middot; ${esc(job.location)} &middot; ${esc(posted)}</div>
      </a>`;
    })
    .join('');
}

function renderEvents(events) {
  $('events').innerHTML = events
    .map(
      (event) => `
      <div class="event ${esc(event.level)}">
        <div class="event-time">${new Date(event.at).toLocaleTimeString()}</div>
        <div>${esc(event.message)}</div>
        ${event.detail ? `<div class="event-detail">${esc(event.detail)}</div>` : ''}
      </div>`,
    )
    .join('');
}

function renderAttribution(sources) {
  // Remote OK's API terms require a mention and a followable link back. This
  // renders whatever each adapter declares, so honouring a new source's terms
  // is a data change rather than an HTML edit somebody has to remember.
  const credits = sources
    .filter((source) => source.attribution)
    .map(
      (source) =>
        `<a href="${esc(source.attribution.url)}" target="_blank">${esc(source.attribution.text)}</a>`,
    );
  $('attribution').innerHTML = credits.join(' &middot; ');
}

// --- polling --------------------------------------------------------------

let sourceFilterPopulated = false;

async function refresh() {
  try {
    const health = await api('/api/health');
    window.__chaos = health.chaos;

    renderOverall(health);
    renderChaosBanner(health.chaos);
    renderSources(health.sources);
    renderAttribution(health.sources);

    if (!sourceFilterPopulated && health.sources.length) {
      const select = $('source-filter');
      for (const source of health.sources) {
        const option = document.createElement('option');
        option.value = source.id;
        option.textContent = source.label;
        select.append(option);
      }
      sourceFilterPopulated = true;
    }

    const params = new URLSearchParams({ limit: '200' });
    if ($('search').value.trim()) params.set('q', $('search').value.trim());
    if ($('source-filter').value) params.set('source', $('source-filter').value);

    const jobs = await api(`/api/jobs?${params}`);
    renderJobs(jobs.jobs, jobs.total);

    const events = await api('/api/events?limit=40');
    renderEvents(events.events);

    $('refresh-note').textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    // If the dashboard cannot reach its own API, it says so. Leaving the last
    // successful render on screen would show stale numbers as if they were
    // current -- the browser-side version of the exact bug this project is
    // about.
    $('refresh-note').textContent = `dashboard cannot reach the API: ${error.message}`;
  }
}

// --- actions --------------------------------------------------------------

async function withButton(button, work) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Working…';
  try {
    await work();
    await refresh();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// Delegated so the handler survives the source cards being re-rendered on
// every poll. Binding directly to each button would attach listeners to nodes
// that are replaced five seconds later.
document.addEventListener('click', (event) => {
  const armButton = event.target.closest('[data-arm]');
  if (armButton) {
    const sourceId = armButton.dataset.arm;
    const mode = document.querySelector(`[data-chaos-for="${sourceId}"]`).value;
    withButton(armButton, async () => {
      await post('/api/chaos', { source: sourceId, mode });
      // Run immediately so the effect is visible now rather than at the next
      // scheduled poll. A demo where you arm chaos and then wait ten minutes
      // proves nothing to anyone watching.
      await post('/api/ingest', { source: sourceId });
    });
  }
});

$('run-now').addEventListener('click', (event) =>
  withButton(event.target, () => post('/api/ingest')),
);

$('reset-all').addEventListener('click', (event) =>
  withButton(event.target, () => post('/api/chaos/reset')),
);

let searchTimer = null;
$('search').addEventListener('input', () => {
  // Debounced: without this every keystroke fires a request, and a fast typist
  // generates a dozen in-flight fetches whose responses can arrive out of
  // order and render the wrong result last.
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refresh, 250);
});
$('source-filter').addEventListener('change', refresh);

refresh();
setInterval(refresh, REFRESH_MS);
