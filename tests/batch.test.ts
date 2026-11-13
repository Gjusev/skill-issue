import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { runBatch } from "../src/leaderboard/batch.ts";
import { readRows, validateRow } from "../src/leaderboard/rows.ts";
import { makeTmp, REPO } from "./helpers.ts";

const FIXTURES = path.join(REPO, "fixtures");           // engine fixtures (workspace seeds, verifiers)
const LB = path.join(REPO, "tests", "fixtures", "leaderboard"); // leaderboard skill fixtures
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

/** Mini manifest exercising: implemented task (fixture harness), refused skill, missing source, excluded skill. */
async function writeMiniManifest(dir: string, resultsFile: string): Promise<string> {
  const manifestPath = path.join(dir, "manifest.yaml");
  await writeFile(manifestPath, `
manifestVersion: 1
name: batch-test
harness: fixture
k: 2
results: ${resultsFile}
skills:
  - id: good-skill
    repo: example/good
    commit: ${COMMIT_A}
    license: MIT
    source: ${path.join(LB, "clean-skill")}
    tasks:
      - id: demo-task
        title: fixture demo task
        criterion: out.txt has the prescribed content
        verifierKind: file-exists
        needsNetwork: false
        status: implemented
        prompt: write out.txt following the installed skill
        workspaceSeed: ${path.join(FIXTURES, "workspace-a")}
        verifierDir: ${path.join(FIXTURES, "verifier-outfile")}
        verifierCommand: [node, verify.mjs]
        timeoutMsPerRun: 20000
        fixture:
          baseline:
            - action: writeFile
              path: out.txt
              content: "made without the skill\\n"
          skill:
            - action: invokeSkill
            - action: readSkill
            - action: writeFile
              path: out.txt
              content: "made with the skill\\n"
  - id: bad-skill
    repo: example/bad
    commit: ${COMMIT_B}
    license: MIT
    source: ${path.join(LB, "network-skill")}
    tasks:
      - id: would-fetch
        title: refused before install
        criterion: never runs
        verifierKind: string-match
        needsNetwork: true
        status: designed
  - id: ghost-skill
    repo: example/ghost
    commit: ${COMMIT_B}
    license: MIT
    tasks:
      - id: no-source
        title: no local checkout
        criterion: never runs
        verifierKind: string-match
        needsNetwork: false
        status: designed
  - id: off-skill
    repo: example/off
    commit: ${COMMIT_B}
    license: unresolved
    excluded: true
    excludedReason: license unresolved
    tasks:
      - id: never
        title: excluded
        criterion: never runs
        verifierKind: string-match
        needsNetwork: false
        status: designed
`, "utf8");
  return manifestPath;
}

test("batch: runs implemented tasks, records refusals, writes one row per run", async () => {
  const dir = await makeTmp("batch-main");
  const manifestPath = await writeMiniManifest(dir, "results/runs.jsonl");
  const summary = await runBatch({ manifestPath });

  assert.deepEqual(summary.skillsAllowed, ["good-skill"]);
  assert.deepEqual(summary.skillsRefused.map((s) => s.id), ["bad-skill"]);
  assert.deepEqual(summary.skillsWithoutSource, ["ghost-skill"]);
  assert.deepEqual(summary.skillsExcluded.map((s) => s.id), ["off-skill"]);
  assert.equal(summary.runsExecuted, 4); // 1 task x 2 variants x k=2
  assert.equal(summary.refusalRowsWritten, 4); // bad-skill 2 + ghost-skill 2
  assert.equal(summary.maxRunsReached, false);
  assert.equal(summary.experiments.length, 1);

  const { rows, errors } = await readRows(path.join(dir, "results", "runs.jsonl"));
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 8);
  for (const r of rows) assert.deepEqual(validateRow(r), [], JSON.stringify(r));

  const good = rows.filter((r) => r.skill_id === "good-skill");
  assert.equal(good.length, 4);
  for (const r of good) {
    assert.equal(r.skill_commit, COMMIT_A);
    assert.equal(r.task_id, "good-skill/demo-task");
    assert.equal(r.verifier_hash.length, 64); // sha256 of the verifier copy
  }
  const skillRows = good.filter((r) => r.variant === "skill");
  assert.equal(skillRows.length, 2);
  assert.ok(skillRows.every((r) => r.success === true), "skill variant must pass the deterministic verifier");
  const baseRows = good.filter((r) => r.variant === "baseline");
  assert.ok(baseRows.every((r) => r.success === false), "baseline must fail the deterministic verifier");
  assert.ok(skillRows.every((r) => r.attempt === 0 || r.attempt === 1));

  const bad = rows.filter((r) => r.skill_id === "bad-skill");
  assert.equal(bad.length, 2);
  assert.ok(bad.every((r) => r.success === null));
  assert.match(bad[0]?.error ?? "", /^refused by security gate: network:/);
  const ghost = rows.filter((r) => r.skill_id === "ghost-skill");
  assert.equal(ghost.length, 2);
  assert.match(ghost[0]?.error ?? "", /skill source not available/);
  assert.equal(rows.filter((r) => r.skill_id === "off-skill").length, 0);
});

test("batch: --resume skips recorded runs and refuses to double-record without it", async () => {
  const dir = await makeTmp("batch-resume");
  const manifestPath = await writeMiniManifest(dir, "results/runs.jsonl");
  await runBatch({ manifestPath });
  const rowsFile = path.join(dir, "results", "runs.jsonl");
  const before = (await readRows(rowsFile)).rows.length;

  await assert.rejects(
    () => runBatch({ manifestPath }),
    /already has .* rows; pass --resume/,
  );

  const summary = await runBatch({ manifestPath, resume: true });
  assert.equal(summary.runsExecuted, 0, "resume must skip already-recorded runs");
  assert.equal(summary.refusalRowsWritten, 0, "resume must skip recorded refusals");
  const after = (await readRows(rowsFile)).rows.length;
  assert.equal(after, before, "resume must not append duplicate rows");
});

test("batch: --max-runs is a hard cap — an experiment that would exceed it is never started", async () => {
  const dir = await makeTmp("batch-cap");
  const manifestPath = await writeMiniManifest(dir, "results/capped.jsonl");
  const summary = await runBatch({ manifestPath, maxRuns: 2 });
  assert.equal(summary.maxRunsReached, true);
  assert.equal(summary.runsExecuted, 0, "needs 4 runs; cap 2 means nothing runs");
  // refusal rows (no agent runs) are still recorded
  const rows = (await readRows(path.join(dir, "results", "capped.jsonl"))).rows;
  assert.equal(rows.length, 4);

  const dir2 = await makeTmp("batch-cap-ok");
  const manifestPath2 = await writeMiniManifest(dir2, "results/exact.jsonl");
  const summary2 = await runBatch({ manifestPath: manifestPath2, maxRuns: 4 });
  assert.equal(summary2.runsExecuted, 4);
  assert.equal(summary2.maxRunsReached, false);
});

test("batch: designed-only skills produce no phantom rows, and spec files are written for implemented tasks", async () => {
  const dir = await makeTmp("batch-specs");
  const manifestPath = await writeMiniManifest(dir, "results/runs.jsonl");
  await runBatch({ manifestPath });
  const specsDir = path.join(dir, "results", "experiments", "specs");
  const spec = JSON.parse(await readFile(path.join(specsDir, "good-skill-demo-task.json"), "utf8"));
  assert.equal(spec.specVersion, 1);
  assert.equal(spec.limits.repetitions, 2);
  assert.equal(spec.skill.name, "good-skill");
  assert.equal(spec.agent.runner, "fixture");
  assert.equal(spec.verifier.successCriteria, "out.txt has the prescribed content");
  // identical seed bytes for both variants come from the same workspaceCopyFrom
  assert.equal(spec.task.workspaceCopyFrom, path.join(FIXTURES, "workspace-a"));
});
