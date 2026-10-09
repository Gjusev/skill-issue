/* Skill Issue viewer — vanilla JS, no build step. */

const $app = document.getElementById("app");
const $drawer = document.getElementById("drawer");
const $drawerTitle = document.getElementById("drawer-title");
const $drawerBody = document.getElementById("drawer-body");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function fmtMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

async function j(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/* ---------- evidence drawer ---------- */

let lastFocus = null;
function openDrawer(title, html) {
  lastFocus = document.activeElement;
  $drawerTitle.textContent = title;
  $drawerBody.innerHTML = html;
  $drawer.hidden = false;
  $drawer.setAttribute("aria-hidden", "false");
  $drawerBody.focus();
}
function closeDrawer() {
  $drawer.hidden = true;
  $drawer.setAttribute("aria-hidden", "true");
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}
$drawer.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) closeDrawer();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$drawer.hidden) closeDrawer();
  // Keep Tab inside the drawer while it is open.
  if (e.key === "Tab" && !$drawer.hidden) {
    const focusables = Array.from($drawer.querySelectorAll("button, [href], [tabindex]:not([tabindex='-1'])"));
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

function preBlock(text, label) {
  return `<h3>${esc(label)}</h3><pre class="clip">${esc(text && text.trim() ? text : "(empty)")}</pre>`;
}

/* ---------- views ---------- */

async function viewList() {
  const items = await j("/api/experiments");
  if (items.length === 0) {
    $app.innerHTML = `
      <div class="card">
        <h1>Experiments</h1>
        <p>No experiments found in the data directory.</p>
        <p class="muted">Run one first, e.g. with the fixture runner (no model needed):</p>
        <pre class="clip">node src/cli.ts run examples/tasks/release-notes.fixture.json</pre>
        <p class="muted">Then restart or reload this viewer.</p>
      </div>`;
    return;
  }
  const rows = items.map((it) => `
    <tr>
      <td><a class="explink" href="#/exp/${encodeURIComponent(it.id)}">${esc(it.id)}</a></td>
      <td>${esc(it.taskId)}</td>
      <td>${esc(it.skill ?? "(none)")}</td>
      <td>${esc(it.runner)}</td>
      <td>${it.statuses.map((s) => `<span class="badge ${esc(s.split(":")[1])}">${esc(s)}</span>`).join(" ")}</td>
      <td>${it.comparisonValid ? '<span class="chip yes">comparable</span>' : '<span class="chip no">not comparable</span>'}</td>
    </tr>`).join("");
  $app.innerHTML = `
    <div class="card">
      <h1>Experiments</h1>
      <table class="plain">
        <thead><tr><th>Experiment</th><th>Task</th><th>Skill</th><th>Runner</th><th>Results</th><th>Comparison</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function metricRow(label, value, unit) {
  const cell = value == null
    ? `<span class="notmeasured">not measured</span>`
    : `${esc(value)}${unit ? " " + esc(unit) : ""}`;
  return `<tr><th scope="row">${esc(label)}</th><td>${cell}</td></tr>`;
}

function evidenceButtons(record) {
  const btns = record.skillEvidence.evidence.map((ev, i) =>
    `<button type="button" class="evidence-link" data-ev="${i}">▸ ${esc(ev.kind)}: ${esc(ev.detail)}</button>`).join("");
  const extra = `
    <button type="button" class="evidence-link" data-sec="verifier">▸ verifier output</button>
    <button type="button" class="evidence-link" data-sec="events">▸ run event trace (${record.events.length} events)</button>
    <button type="button" class="evidence-link" data-sec="output">▸ agent final output</button>`;
  return btns + extra;
}

async function viewDetail(id) {
  const r = await j(`/api/experiments/${encodeURIComponent(id)}`);

  const comparability = r.comparison.valid
    ? `<div class="note">Comparable setup: both variants started from identical bytes (beyond the skill install) and identical runner configuration.</div>`
    : `<div class="note invalid"><strong>Comparison not valid.</strong> ${r.comparison.reasons.map(esc).join(" · ")}</div>`;

  const cards = r.records.map((rec) => {
    const installed = rec.variantId === "skill"
      ? (rec.skillEvidence.installed ? '<span class="chip yes">installed</span>' : '<span class="chip no">not installed</span>')
      : '<span class="chip na">installed: n/a</span>';
    const read = rec.variantId === "skill"
      ? (rec.skillEvidence.observedRead == null
          ? '<span class="chip na">read: not instrumented</span>'
          : rec.skillEvidence.observedRead ? '<span class="chip yes">observed read/invoke</span>' : '<span class="chip no">no read/invoke observed</span>')
      : '<span class="chip na">read: n/a</span>';
    const verifierChip = rec.verifier.status === "passed"
      ? '<span class="chip yes">verifier passed</span>'
      : rec.verifier.status === "failed"
        ? '<span class="chip no">verifier failed</span>'
        : '<span class="chip na">verifier not run</span>';

    const changes = rec.changes.length === 0
      ? `<p class="muted">no file changes detected</p>`
      : `<ul class="changes">${rec.changes.map((c) => `<li>${esc(c.change)} — ${esc(c.path)}</li>`).join("")}</ul>`;

    return `
    <section class="card" aria-label="${esc(rec.variantId)} repetition ${rec.repetition}">
      <h2>${esc(rec.variantId)} <span class="muted">· repetition ${rec.repetition}</span></h2>
      <p><span class="badge ${esc(rec.status)}">${esc(rec.status)}</span> ${verifierChip}</p>
      <p class="muted">${esc(rec.endReason)}</p>
      ${rec.observed && rec.observed.model ? `<p class="muted">observed model: ${esc(rec.observed.model)}${rec.requested.model && rec.observed.model !== rec.requested.model ? ` (requested ${esc(rec.requested.model)} — the environment overrode it)` : ""}</p>` : ""}
      ${rec.comparison.valid ? "" : `<div class="note invalid">This run is excluded from comparison: ${rec.comparison.reasons.map(esc).join(" · ")}</div>`}
      <h3>Activation evidence</h3>
      <p>${installed} ${read}</p>
      <p class="muted">Installed = engine found SKILL.md in the run's config. Observed read = the run's event stream shows the skill being invoked or read. Neither implies the agent followed it — that is what the verifier measures, separately.</p>
      <div data-evidence="${esc(rec.variantId)}-r${rec.repetition}">${evidenceButtons(rec)}</div>
      <h3>Changes produced</h3>
      ${changes}
      <h3>Measurements</h3>
      <table class="plain">
        <tbody>
          ${metricRow("wall-clock duration", rec.metrics.durationMs, "ms")}
          ${metricRow("input tokens", rec.metrics.tokensIn, "")}
          ${metricRow("output tokens", rec.metrics.tokensOut, "")}
          ${metricRow("cost", rec.metrics.costUsd == null ? null : Number(rec.metrics.costUsd).toFixed(4), "USD")}
          ${metricRow("turns", rec.metrics.turns, "")}
        </tbody>
      </table>
      <p class="muted">Token/cost fields come from the runner's result message when it provides them (${esc(rec.metrics.providerProvenance ?? "no provider source")}).</p>
    </section>`;
  }).join("");

  $app.innerHTML = `
    <a class="backlink btn" href="#/">← All experiments</a>
    <div class="card">
      <h1>${esc(r.taskId)} <span class="muted">· ${esc(r.experimentId)}</span></h1>
      ${r.description ? `<p>${esc(r.description)}</p>` : ""}
      <dl class="kv">
        <dt>Success criterion</dt><dd>${esc(r.successCriteria)}</dd>
        <dt>Skill under test</dt><dd>${r.skill ? `${esc(r.skill.name)} (sha256 ${esc(r.skill.hash.slice(0, 12))}…)` : "(none)"}</dd>
        <dt>Runner</dt><dd>${esc(r.agent.runner)}${r.agent.runnerVersion ? " " + esc(r.agent.runnerVersion) : ""}${r.agent.model ? " · model " + esc(r.agent.model) : ""}</dd>
        <dt>Limits</dt><dd>${esc(r.limits.timeoutMsPerRun)} ms/run · ${esc(r.limits.repetitions)} repetition(s)${r.limits.maxBudgetUsd ? " · budget flag $" + esc(r.limits.maxBudgetUsd) : ""}</dd>
        <dt>Created</dt><dd>${esc(r.createdAt)}</dd>
        <dt>Spec hash</dt><dd>${esc(r.specHash.slice(0, 16))}…</dd>
      </dl>
      ${comparability}
      <div class="note">${esc(r.comparison.note)}</div>
      <p><a class="btn" href="/api/experiments/${encodeURIComponent(r.experimentId)}/export" download="skill-issue-export.json">Download sanitized export</a></p>
    </div>
    <div class="grid">${cards}</div>`;

  // Wire evidence buttons (delegated per card).
  document.querySelectorAll("[data-evidence]").forEach((container) => {
    const key = container.getAttribute("data-evidence");
    const rec = r.records.find((x) => `${x.variantId}-r${x.repetition}` === key);
    container.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-ev], button[data-sec]");
      if (!btn || !rec) return;
      if (btn.dataset.ev !== undefined) {
        const ev = rec.skillEvidence.evidence[Number(btn.dataset.ev)];
        openDrawer(`Evidence — ${rec.variantId} (r${rec.repetition})`,
          `<p><strong>${esc(ev.kind)}</strong>: ${esc(ev.detail)}</p>
           <p class="muted">This claim is backed by the engine's ${esc(ev.kind)} check on this specific run, not by agent self-report.</p>`);
      } else if (btn.dataset.sec === "verifier") {
        openDrawer(`Verifier output — ${rec.variantId} (r${rec.repetition})`,
          `<p><span class="badge ${esc(rec.status)}">${esc(rec.status)}</span> exit=${esc(rec.verifier.exitCode ?? "n/a")}</p>
           ${preBlock(rec.verifier.stdout, "stdout")}${preBlock(rec.verifier.stderr, "stderr")}`);
      } else if (btn.dataset.sec === "events") {
        const rows = rec.events.map((ev) => `<tr><td>${esc(ev.type)}</td><td>${esc(ev.detail)}</td></tr>`).join("");
        openDrawer(`Event trace — ${rec.variantId} (r${rec.repetition})`,
          `<table class="plain"><thead><tr><th>event</th><th>detail</th></tr></thead><tbody>${rows}</tbody></table>`);
      } else if (btn.dataset.sec === "output") {
        openDrawer(`Agent output — ${rec.variantId} (r${rec.repetition})`,
          preBlock(rec.output.text, rec.output.truncated ? "final output (truncated)" : "final output"));
      }
    });
  });
}

/* ---------- router ---------- */

async function route() {
  const hash = location.hash || "#/";
  try {
    const m = hash.match(/^#\/exp\/(.+)$/);
    if (m) await viewDetail(decodeURIComponent(m[1]));
    else await viewList();
  } catch (e) {
    $app.innerHTML = `<div class="card"><h1>Could not load</h1><p>${esc(e.message)}</p><p><a class="btn" href="#/">Back to list</a></p></div>`;
  }
}

window.addEventListener("hashchange", route);
route();
