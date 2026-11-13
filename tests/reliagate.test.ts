import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile, chmod, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runReliagateGate, runWilsonCIs, computeSkillStat } from "../src/leaderboard/stats.ts";
import { refusalRow, rowFromRecord, type LeaderboardRunRow } from "../src/leaderboard/rows.ts";
import { makeTmp, REPO } from "./helpers.ts";

/** Write a stub `reliagate` shell script that logs its argv and emits a canned gate report. */
async function writeGateStub(dir: string, report: unknown, exitCode: number): Promise<string> {
  const stub = path.join(dir, "fake-reliagate.sh");
  const reportFile = path.join(dir, "report.json");
  const logFile = path.join(dir, "invocations.log");
  await writeFile(reportFile, JSON.stringify(report), "utf8");
  await writeFile(
    stub,
    `#!/bin/sh
echo "$@" >> ${JSON.stringify(logFile)}
cat ${JSON.stringify(reportFile)}
exit ${exitCode}
`,
    "utf8",
  );
  await chmod(stub, 0o755);
  return stub;
}

async function writePythonStub(dir: string): Promise<string> {
  const stub = path.join(dir, "fake-python.sh");
  await writeFile(
    stub,
    `#!/bin/sh
# argv: -c <snippet> <pairs-json>; pair count = inner ']' occurrences minus the outer bracket
n=$(echo "$3" | grep -o '\\]' | wc -l)
n=$((n - 1))
pairs=""
i=1
while [ "$i" -le "$n" ]; do
  if [ -n "$pairs" ]; then pairs="$pairs,"; fi
  pairs="$pairs[0.1,0.9]"
  i=$((i + 1))
done
echo "[$pairs]"
`,
    "utf8",
  );
  await chmod(stub, 0o755);
  return stub;
}

const COMMIT = "b".repeat(40);

function rowsForSkill(passes: { variant: "baseline" | "skill"; success: boolean | null; attempt: number }[]): LeaderboardRunRow[] {
  return passes.map((p) => ({
    skill_id: "tdd",
    skill_commit: COMMIT,
    task_id: `tdd/task-${p.attempt}`,
    variant: p.variant,
    attempt: p.attempt,
    success: p.success,
    tokens_in: 100,
    tokens_out: 10,
    cost_estimate: 0.02,
    wall_ms: 1000,
    verifier_hash: "v",
  }));
}

const HELPERS_DIR = mkdtemp(path.join(tmpdir(), "reliagate-stubs "));

test("reliagate subprocess: gate stub is invoked with --base/--new/--json and its verdict drives helps", async (t) => {
  const dir = await HELPERS_DIR;
  const stub = await writeGateStub(dir, {
    decision: "pass", exit_code: 0, reason: "ok",
    base_pass_pow_n: 0.0, new_pass_pow_n: 1.0, max_regression: 0.05, alpha: 0.05,
    comparison: { b_gained: 1, c_lost: 0, b_minus_c: 1, p_value: 0.01, test_used: "mcnemar_exact", n_tasks: 1, base_consistent: 0, new_consistent: 1 },
    abstention: { base: { trials_abstained: 0, trials_total: 2 }, new: { trials_abstained: 0, trials_total: 2 } },
  }, 0);
  const stat = await computeSkillStat(
    rowsForSkill([
      { variant: "baseline", success: false, attempt: 0 }, { variant: "baseline", success: false, attempt: 1 },
      { variant: "skill", success: true, attempt: 0 }, { variant: "skill", success: true, attempt: 1 },
    ]),
    { id: "tdd", commit: COMMIT },
    // the quoted command exercises the quote-aware tokenizer (paths contain spaces)
    { gateCmd: JSON.stringify(stub), pythonBin: "false" }, // python stub: CIs degrade to null here
  );
  const log = await readFile(path.join(dir, "invocations.log"), "utf8");
  assert.match(log, /gate --base .+ --new .+ --json/);
  assert.equal(stat.verdict, "helps");
  assert.equal(stat.pValue, 0.01);
  assert.equal(stat.b, 1);
  assert.equal(stat.c, 0);
});

test("verdict logic: significant drop = hurts; non-significant = no evidence", async () => {
  const dir = await HELPERS_DIR;
  const mk = async (p: number, b: number, n: number, code = 0) => writeGateStub(await mkdtemp(path.join(tmpdir(), "gate ")), {
    decision: "pass", exit_code: code, reason: "ok", base_pass_pow_n: b, new_pass_pow_n: n, alpha: 0.05,
    comparison: { b_gained: 0, c_lost: 0, b_minus_c: 0, p_value: p, test_used: "mcnemar_exact", n_tasks: 1, base_consistent: 0, new_consistent: 0 },
    abstention: {},
  }, code);

  const hurts = await computeSkillStat(rowsForSkill([
    { variant: "baseline", success: true, attempt: 0 }, { variant: "skill", success: false, attempt: 0 },
  ]), { id: "x", commit: COMMIT },    { gateCmd: JSON.stringify(await mk(0.01, 1.0, 0.0)) });
  assert.equal(hurts.verdict, "hurts");

  const neutral = await computeSkillStat(rowsForSkill([
    { variant: "baseline", success: true, attempt: 0 }, { variant: "skill", success: true, attempt: 0 },
  ]), { id: "x", commit: COMMIT }, { gateCmd: JSON.stringify(await mk(0.4, 1.0, 1.0)) });
  assert.equal(neutral.verdict, "no evidence");

  const tinyGain = await computeSkillStat(rowsForSkill([
    { variant: "baseline", success: true, attempt: 0 }, { variant: "skill", success: true, attempt: 0 },
  ]), { id: "x", commit: COMMIT }, { gateCmd: JSON.stringify(await mk(0.01, 1.0, 1.0)) });
  assert.equal(tinyGain.verdict, "no evidence"); // significant p but no direction change
});

test("reliagate gate exit 3 (infra error) degrades to 'no data', never a verdict", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gate3 "));
  const stub = await writeGateStub(dir, { detail: "malformed" }, 3);
  const stat = await computeSkillStat(rowsForSkill([
    { variant: "baseline", success: true, attempt: 0 }, { variant: "skill", success: true, attempt: 0 },
  ]),  { id: "x", commit: COMMIT }, { gateCmd: JSON.stringify(stub) });
  assert.equal(stat.verdict, "no data");
  assert.ok(stat.error);
  assert.equal(stat.pValue, null);
});

test("one-sided data (refused skill, only refusal rows) is 'no data' without invoking reliagate", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gate-one-sided "));
  const stub = await writeGateStub(dir, {}, 0);
  const stat = await computeSkillStat(
    [refusalRow({ skillId: "x", skillCommit: COMMIT, taskId: "x/t1" }, 0, ["reason"])],
    { id: "x", commit: COMMIT },
    { gateCmd: stub },
  );
  assert.equal(stat.verdict, "no data");
  const log = await readFile(path.join(dir, "invocations.log"), "utf8").catch(() => "");
  assert.equal(log, "", "gate must not be invoked without paired data");
});

test("wilson CIs come from reliagate's python (stubbed here), degrade to null on failure", async () => {
  const dir = await HELPERS_DIR;
  const pyStub = await writePythonStub(dir);
  const cis = await runWilsonCIs([{ successes: 2, total: 4 }, { successes: 3, total: 4 }], { pythonBin: pyStub });
  assert.deepEqual(cis, [[0.1, 0.9], [0.1, 0.9]]);
  const broken = await runWilsonCIs([{ successes: 1, total: 2 }], { pythonBin: "false" });
  assert.deepEqual(broken, [null]);
});

test("optional integration: real reliagate repo, if present, honors the exit-code contract", async () => {
  const home = process.env.SKILL_ISSUE_RELIGATE_HOME ?? path.join(REPO, "..", "reliagate");
  const dir = await mkdtemp(path.join(tmpdir(), "real-reliagate "));
  const base = path.join(dir, "base.jsonl");
  const neu = path.join(dir, "new.jsonl");
  await writeFile(base, '{"task_id":"t1","attempt":0,"success":true,"version":"base"}\n{"task_id":"t2","attempt":0,"success":false,"version":"base"}\n', "utf8");
  await writeFile(neu, '{"task_id":"t1","attempt":0,"success":true,"version":"new"}\n{"task_id":"t2","attempt":0,"success":true,"version":"new"}\n', "utf8");
  const res = await runReliagateGate(base, neu, { reliagateHome: home });
  if (res.error !== null) {
    // reliagate not installed/importable in this environment: the degradation
    // path is the contract; nothing to assert about exit codes.
    return;
  }
  assert.ok([0, 2].includes(res.exitCode ?? -1));
  assert.ok(res.report !== null);
  assert.ok(["pass", "regression"].includes(res.report.decision));
  // rows helper used by rowFromRecord stays consistent with the projection
  const row = rowFromRecord({ status: "passed" } as never, { skillId: "s", skillCommit: COMMIT, taskId: "t" });
  assert.equal(row.success, true);
});
