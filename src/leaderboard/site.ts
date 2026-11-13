/**
 * Static leaderboard site generator.
 *
 * Pure renderer: takes already-computed data (see report.ts / stats.ts) and
 * writes a static site to leaderboard/site/ -- one summary table (index.html)
 * plus one page per skill with its raw runs. Must work on empty and partial
 * data: missing numbers render as em-dashes, no skills at all renders a
 * "no data yet" state. No JavaScript, no network, no templating deps.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Verdict } from "./stats.ts";
import type { LeaderboardRunRow } from "./rows.ts";

export interface SiteSkillRow {
  id: string;
  repo: string;
  license: string;
  commit: string;
  installs: number | null;
  excluded: string | null;
  tasks: number;
  tasksWithData: number;
  runs: number;
  baseline: { successes: number; total: number; ci: [number, number] | null };
  skill: { successes: number; total: number; ci: [number, number] | null };
  verdict: Verdict;
  costDeltaUsd: number | null;
  pValue: number | null;
  refusalReason: string | null;
  runsDetail: LeaderboardRunRow[];
}

export interface SiteData {
  generatedAt: string;
  name: string;
  harness: string;
  k: number;
  skills: SiteSkillRow[];
  totalRuns: number;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function pct(ci: { successes: number; total: number; ci: [number, number] | null }): string {
  if (ci.total === 0) return "&mdash;";
  const rate = `${((ci.successes / ci.total) * 100).toFixed(0)}%`;
  if (!ci.ci) return `${rate} <span class="dim">(CI n/a)</span>`;
  return `${rate} <span class="dim">[${(ci.ci[0] * 100).toFixed(0)}&ndash;${(ci.ci[1] * 100).toFixed(0)}%]</span>`;
}

function fmtCost(v: number | null): string {
  if (v === null || v === undefined) return "&mdash;";
  const sign = v > 0 ? "+" : v < 0 ? "&minus;" : "";
  return `${sign}$${Math.abs(v).toFixed(4)}`;
}

function verdictClass(v: Verdict): string {
  return v === "helps" ? "v-helps" : v === "hurts" ? "v-hurts" : v === "no evidence" ? "v-neutral" : "v-nodata";
}

const STYLE = `
  :root { color-scheme: light; }
  body { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; margin: 2rem auto; max-width: 1200px; padding: 0 1rem; color: #111; background: #fafafa; line-height: 1.5; }
  h1 { font-size: 1.4rem; letter-spacing: -0.02em; } h2 { font-size: 1.1rem; }
  .dim { color: #888; } .sub { color: #555; font-size: 0.85rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; margin: 1rem 0; }
  th, td { border: 1px solid #ddd; padding: 0.35rem 0.55rem; text-align: left; vertical-align: top; }
  th { background: #efefef; font-weight: 600; }
  td code, .commit { font-size: 0.78rem; }
  .v-helps { color: #0a6b2d; font-weight: 700; } .v-hurts { color: #a11212; font-weight: 700; }
  .v-neutral { color: #555; } .v-nodata { color: #999; font-style: italic; }
  .empty { border: 1px dashed #bbb; padding: 1.5rem; text-align: center; color: #777; margin: 2rem 0; }
  footer { margin-top: 2rem; font-size: 0.75rem; color: #888; }
  .refused { color: #a11212; }
`;

function page(title: string, body: string, data: SiteData): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
<footer>skill-issue leaderboard &middot; harness ${escapeHtml(data.harness)} &middot; k=${data.k} &middot; generated ${escapeHtml(data.generatedAt)} &middot; verdicts come from paired McNemar tests run by reliagate; "no evidence" means the paired test did not support a claim, not that none exists.</footer>
</body>
</html>
`;
}

export async function renderSite(data: SiteData, outDir: string): Promise<{ files: string[] }> {
  const files: string[] = [];

  const rowsHtml = data.skills.length === 0
    ? `<div class="empty">no data yet &mdash; run <code>skill-issue batch --manifest leaderboard/manifest.yaml</code> to record the first runs</div>`
    : `<table>
  <thead><tr>
    <th>skill</th><th>repo</th><th>license</th><th>commit</th>
    <th>tasks</th><th>runs</th>
    <th>baseline success</th><th>skill success</th>
    <th>p (paired McNemar)</th><th>verdict</th><th>cost delta</th>
  </tr></thead>
  <tbody>
${data.skills.map((s) => `    <tr>
      <td><a href="skills/${encodeURIComponent(s.id)}.html">${escapeHtml(s.id)}</a>${s.excluded ? ` <span class="dim">(excluded: ${escapeHtml(s.excluded)})</span>` : ""}${s.refusalReason ? ` <span class="refused" title="${escapeHtml(s.refusalReason)}">(refused)</span>` : ""}</td>
      <td class="dim">${escapeHtml(s.repo)}</td>
      <td class="dim">${escapeHtml(s.license)}</td>
      <td class="commit dim">${escapeHtml(s.commit.slice(0, 8))}</td>
      <td>${s.tasksWithData}/${s.tasks}</td>
      <td>${s.runs}</td>
      <td>${pct(s.baseline)}</td>
      <td>${pct(s.skill)}</td>
      <td>${s.pValue === null ? "&mdash;" : s.pValue.toFixed(4)}</td>
      <td class="${verdictClass(s.verdict)}">${escapeHtml(s.verdict)}</td>
      <td>${fmtCost(s.costDeltaUsd)}</td>
    </tr>`).join("\n")}
  </tbody>
</table>`;

  const body = `<h1>Skills leaderboard</h1>
<p class="sub">${escapeHtml(data.name)} &middot; ${data.totalRuns} recorded run${data.totalRuns === 1 ? "" : "s"} &middot; deterministic verifiers only, never an LLM judge.</p>
${rowsHtml}`;
  const indexFile = path.join(outDir, "index.html");
  await mkdir(outDir, { recursive: true });
  await writeFile(indexFile, page(`${data.name} — skills leaderboard`, body, data), "utf8");
  files.push(indexFile);

  for (const s of data.skills) {
    const runsHtml = s.runsDetail.length === 0
      ? `<div class="empty">no runs recorded yet for ${escapeHtml(s.id)}</div>`
      : `<table>
  <thead><tr><th>task</th><th>variant</th><th>attempt</th><th>success</th><th>tokens in/out</th><th>cost est.</th><th>wall ms</th><th>error</th></tr></thead>
  <tbody>
${s.runsDetail.map((r) => `    <tr>
      <td>${escapeHtml(r.task_id)}</td><td>${r.variant}</td><td>${r.attempt}</td>
      <td>${r.success === null ? '<span class="dim">abstained</span>' : r.success ? "pass" : "fail"}</td>
      <td>${r.tokens_in ?? "&mdash;"} / ${r.tokens_out ?? "&mdash;"}</td>
      <td>${r.cost_estimate === null ? "&mdash;" : `$${r.cost_estimate.toFixed(4)}`}</td>
      <td>${r.wall_ms}</td>
      <td class="dim">${r.error ? escapeHtml(r.error) : ""}</td>
    </tr>`).join("\n")}
  </tbody>
</table>`;
    const sBody = `<h1>${escapeHtml(s.id)}</h1>
<p class="sub"><a href="../index.html">&larr; all skills</a> &middot; ${escapeHtml(s.repo)} @ <span class="commit">${escapeHtml(s.commit)}</span> &middot; license ${escapeHtml(s.license)}${s.installs !== null ? ` &middot; ${s.installs.toLocaleString("en-US")} installs (registry context only, not a ranking)` : ""}</p>
<p>verdict: <span class="${verdictClass(s.verdict)}">${escapeHtml(s.verdict)}</span>${s.pValue !== null ? ` (paired McNemar p=${s.pValue.toFixed(4)})` : ""}${s.refusalReason ? ` &middot; <span class="refused">refused by security gate: ${escapeHtml(s.refusalReason)}</span>` : ""}${s.excluded ? ` &middot; excluded: ${escapeHtml(s.excluded)}` : ""}</p>
<h2>raw runs</h2>
${runsHtml}`;
    const skillFile = path.join(outDir, "skills", `${s.id}.html`);
    await mkdir(path.dirname(skillFile), { recursive: true });
    await writeFile(skillFile, page(`${s.id} — ${data.name}`, sBody, data), "utf8");
    files.push(skillFile);
  }
  return { files };
}
