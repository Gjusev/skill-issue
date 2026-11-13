import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { renderSite, escapeHtml, type SiteData } from "../src/leaderboard/site.ts";
import { makeTmp } from "./helpers.ts";

const COMMIT = "c".repeat(40);

function emptyData(): SiteData {
  return { generatedAt: "2026-11-12T00:00:00Z", name: "test-board", harness: "fixture", k: 5, skills: [], totalRuns: 0 };
}

test("site: empty data renders 'no data yet' states and no skill pages", async () => {
  const dir = await makeTmp("site-empty");
  const { files } = await renderSite(emptyData(), dir);
  const index = await readFile(path.join(dir, "index.html"), "utf8");
  assert.match(index, /no data yet/);
  assert.ok(files.length === 1);
  assert.ok(!index.includes("<table>"));
});

test("site: fixture rows render the table, verdicts, CIs and per-skill raw-run pages", async () => {
  const dir = await makeTmp("site-data");
  const runsDetail = [
    { skill_id: "tdd", skill_commit: COMMIT, task_id: "tdd/task-a", variant: "baseline" as const, attempt: 0, success: false, tokens_in: 34000, tokens_out: 300, cost_estimate: 0.07, wall_ms: 21000, verifier_hash: "h" },
    { skill_id: "tdd", skill_commit: COMMIT, task_id: "tdd/task-a", variant: "skill" as const, attempt: 0, success: true, tokens_in: 35000, tokens_out: 320, cost_estimate: 0.08, wall_ms: 22000, verifier_hash: "h" },
    { skill_id: "tdd", skill_commit: COMMIT, task_id: "tdd/task-b", variant: "skill" as const, attempt: 0, success: null, tokens_in: null, tokens_out: null, cost_estimate: null, wall_ms: 5, verifier_hash: "not-run", error: "refused by security gate: network: scripts/fetch.sh:1" },
  ];
  const data: SiteData = {
    ...emptyData(),
    totalRuns: 3,
    skills: [{
      id: "tdd", repo: "mattpocock/skills", license: "MIT", commit: COMMIT, installs: 1229599,
      excluded: null, tasks: 3, tasksWithData: 2, runs: 3,
      baseline: { successes: 0, total: 1, ci: [0.0, 0.79] },
      skill: { successes: 1, total: 2, ci: [0.09, 0.99] },
      verdict: "no evidence", costDeltaUsd: 0.01, pValue: 0.4,
      refusalReason: null, runsDetail,
    }],
  };
  const { files } = await renderSite(data, dir);
  assert.equal(files.length, 2);

  const index = await readFile(path.join(dir, "index.html"), "utf8");
  assert.match(index, /tdd/);
  assert.match(index, /mattpocock\/skills/);
  assert.match(index, /paired McNemar/);
  assert.match(index, /no evidence/);
  assert.match(index, /skills\/tdd\.html/);

  const skillPage = await readFile(path.join(dir, "skills", "tdd.html"), "utf8");
  assert.match(skillPage, /raw runs/);
  assert.match(skillPage, /tdd\/task-a/);
  assert.match(skillPage, /pass/);
  assert.match(skillPage, /abstained/); // success=null row
  assert.match(skillPage, /refused by security gate/);
  assert.match(skillPage, /installs \(registry context only, not a ranking\)/);
});

test("site: refusal reason surfaces on the index table for refused skills", async () => {
  const dir = await makeTmp("site-refused");
  const data = emptyData();
  data.totalRuns = 2;
  data.skills = [{
    id: "bad", repo: "example/bad", license: "MIT", commit: COMMIT, installs: null,
    excluded: null, tasks: 1, tasksWithData: 0, runs: 2,
    baseline: { successes: 0, total: 0, ci: null }, skill: { successes: 0, total: 2, ci: null },
    verdict: "no data", costDeltaUsd: null, pValue: null,
    refusalReason: "refused by security gate: network: scripts/fetch.sh:1 — network tool invocation (curl …)",
    runsDetail: [],
  }];
  await renderSite(data, dir);
  const index = await readFile(path.join(dir, "index.html"), "utf8");
  assert.match(index, /refused/);
  const page = await readFile(path.join(dir, "skills", "bad.html"), "utf8");
  assert.match(page, /no runs recorded yet for bad/);
  assert.match(page, /refused by security gate/);
});

test("site: excluded skills keep their exclusion reason; values are escaped", async () => {
  const dir = await makeTmp("site-escape");
  const data = emptyData();
  data.skills = [{
    id: "x", repo: "a/b", license: "unresolved", commit: COMMIT, installs: null,
    excluded: "license unresolved", tasks: 1, tasksWithData: 0, runs: 0,
    baseline: { successes: 0, total: 0, ci: null }, skill: { successes: 0, total: 0, ci: null },
    verdict: "no data", costDeltaUsd: null, pValue: null, refusalReason: null, runsDetail: [],
  }];
  await renderSite(data, dir);
  const index = await readFile(path.join(dir, "index.html"), "utf8");
  assert.match(index, /excluded: license unresolved/);
  assert.equal(escapeHtml('<script alt="\'&">'), "&lt;script alt=&quot;&#39;&amp;&quot;&gt;");
});
