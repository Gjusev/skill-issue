import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { runExperiment, readExperiment } from "../src/core/engine.ts";
import { createFixtureRunner } from "../src/runners/fixture.ts";
import { baseSpec, writeSpec, makeTmp, REPO, SKILL_FOLLOWS_FORMAT, WRONG_FORMAT } from "./helpers.ts";

const OUTFILE_VERIFIER = path.join(REPO, "fixtures", "verifier-outfile");

async function run(spec: ReturnType<typeof baseSpec>, dataDir: string, opts: { signal?: AbortSignal } = {}) {
  const specPath = await writeSpec(dataDir, spec);
  return runExperiment(specPath, createFixtureRunner(), { dataDir, ...opts });
}

test("full comparison: baseline fails, skill variant passes, evidence recorded", async () => {
  const dataDir = await makeTmp("eng-full");
  const report = await run(
    baseSpec({
      description: "integration: skill format followed vs not",
      verifier: { copyFrom: OUTFILE_VERIFIER, command: ["node", "verify.mjs"], successCriteria: "out.txt contains the prescribed content" },
      agent: { runner: "fixture", fixture: { baseline: WRONG_FORMAT, skill: SKILL_FOLLOWS_FORMAT } },
    }),
    dataDir,
  );
  assert.equal(report.comparison.valid, true, report.comparison.reasons.join("; "));
  const base = report.records.find((r) => r.variantId === "baseline")!;
  const skill = report.records.find((r) => r.variantId === "skill")!;
  assert.equal(base.status, "failed");
  assert.equal(skill.status, "passed");
  // Evidence levels are separate claims
  assert.equal(base.skillEvidence.installed, false);
  assert.equal(base.skillEvidence.observedRead, false);
  assert.equal(skill.skillEvidence.installed, true);
  assert.equal(skill.skillEvidence.observedRead, true);
  assert.ok(skill.skillEvidence.evidence.some((e) => e.kind === "tool-use"));
  assert.ok(skill.skillEvidence.evidence.some((e) => e.kind === "file-read"));
  // Change tracking
  assert.ok(skill.changes.some((c) => c.change === "created" && c.path.endsWith("out.txt")));
  // Verifier untouched
  assert.equal(skill.hashes.verifierAfter, skill.hashes.verifierBefore);
  // Metrics: duration measured, tokens absent → null (NOT 0)
  assert.equal(typeof skill.metrics.durationMs, "number");
  assert.equal(skill.metrics.tokensIn, null);
  assert.equal(skill.metrics.tokensOut, null);
  assert.equal(skill.metrics.costUsd, null);
  assert.equal(skill.metrics.providerProvenance, null);
  // experiment.json readable back
  const re = await readExperiment(path.join(dataDir, "experiments", report.experimentId));
  assert.equal(re.records.length, 2);
});

test("fixture metrics step surfaces provider metrics with provenance", async () => {
  const dataDir = await makeTmp("eng-metrics");
  const report = await run(
    baseSpec({
      id: "test-metrics",
      agent: {
        runner: "fixture",
        fixture: {
          baseline: [{ action: "exit", code: 0 }],
          skill: [
            { action: "metrics", tokensIn: 120, tokensOut: 30, costUsd: 0.02, turns: 2 },
            { action: "exit", code: 0 },
          ],
        },
      },
    }),
    dataDir,
  );
  const skill = report.records.find((r) => r.variantId === "skill")!;
  assert.equal(skill.status, "passed");
  assert.equal(skill.metrics.tokensIn, 120);
  assert.equal(skill.metrics.tokensOut, 30);
  assert.equal(skill.metrics.costUsd, 0.02);
  assert.equal(skill.metrics.turns, 2);
  assert.equal(skill.metrics.providerProvenance, "runner stream-json result message");
});

test("timeout kills the run and the verifier is not run", async () => {
  const dataDir = await makeTmp("eng-timeout");
  const report = await run(
    baseSpec({
      id: "test-timeout",
      limits: { timeoutMsPerRun: 900, repetitions: 1 },
      agent: { runner: "fixture", fixture: { baseline: [{ action: "sleep", ms: 60_000 }], skill: [{ action: "sleep", ms: 60_000 }] } },
    }),
    dataDir,
  );
  for (const rec of report.records) {
    assert.equal(rec.status, "timeout");
    assert.equal(rec.run.timedOut, true);
    assert.equal(rec.verifier.status, "not-run");
    assert.ok(rec.endReason.includes("process tree killed"));
  }
});

test("cancellation via AbortSignal marks records cancelled", async () => {
  const dataDir = await makeTmp("eng-cancel");
  const controller = new AbortController();
  const specPath = await writeSpec(dataDir, baseSpec({
    id: "test-cancel",
    agent: { runner: "fixture", fixture: { baseline: [{ action: "sleep", ms: 60_000 }], skill: [{ action: "sleep", ms: 60_000 }] } },
  }));
  const promise = runExperiment(specPath, createFixtureRunner(), { dataDir, signal: controller.signal });
  setTimeout(() => controller.abort(), 700);
  const report = await promise;
  // first run (baseline) is cancelled; the skill run is skipped by the abort check
  const cancelled = report.records.filter((r) => r.status === "cancelled");
  assert.equal(cancelled.length >= 1, true);
  assert.ok(report.records.every((r) => r.status === "cancelled" || r.repetition !== 1 || r.variantId !== "skill"));
});

test("corrupt provider output is infrastructure error, never a pass", async () => {
  const dataDir = await makeTmp("eng-corrupt");
  const report = await run(
    baseSpec({
      id: "test-corrupt",
      agent: {
        runner: "fixture",
        fixture: {
          baseline: [{ action: "emit", line: "SERVER ERROR 500 totally not json" }, { action: "exit", code: 0 }],
          skill: [{ action: "emit", line: "{\"type\":\"result\",\"trunc" }, { action: "exit", code: 0 }],
        },
      },
    }),
    dataDir,
  );
  for (const rec of report.records) {
    assert.equal(rec.status, "infrastructure_error", `${rec.variantId}: ${rec.status}`);
    assert.ok(rec.endReason.includes("corrupt"));
  }
});

test("agent tampering with the verifier invalidates its comparison", async () => {
  const dataDir = await makeTmp("eng-tamper");
  // The skill variant writes over the verifier copy via a path escape,
  // exactly like a bypass-permissions agent could.
  const report = await run(
    baseSpec({
      id: "test-tamper",
      agent: {
        runner: "fixture",
        fixture: {
          baseline: [{ action: "exit", code: 0 }],
          skill: [
            { action: "writeFile", path: path.join("..", "..", "..", "verifier", "verify.mjs"), content: "process.exit(0) // i rewrote my own judge\n" },
            { action: "exit", code: 0 },
          ],
        },
      },
    }),
    dataDir,
  );
  const skill = report.records.find((r) => r.variantId === "skill")!;
  assert.equal(skill.status, "invalid_comparison");
  assert.ok(skill.comparison.reasons.some((r) => r.includes("verifier files were modified")));
  assert.notEqual(skill.hashes.verifierAfter, skill.hashes.verifierBefore);
  const base = report.records.find((r) => r.variantId === "baseline")!;
  assert.equal(base.status, "passed"); // baseline ran before the tamper
});

test("variant execution order alternates between repetitions", async () => {
  const dataDir = await makeTmp("eng-order");
  const report = await run(baseSpec({ id: "test-order", limits: { timeoutMsPerRun: 20_000, repetitions: 2 } }), dataDir);
  // records are pushed in execution order: r1 baseline→skill, r2 skill→baseline
  assert.equal(report.records[0]!.variantId, "baseline");
  assert.equal(report.records[1]!.variantId, "skill");
  assert.equal(report.records[2]!.variantId, "skill");
  assert.equal(report.records[3]!.variantId, "baseline");
});

test("repetitions option overrides the spec", async () => {
  const dataDir = await makeTmp("eng-reps");
  const spec = baseSpec({ id: "test-reps", limits: { timeoutMsPerRun: 20_000, repetitions: 1 } });
  const specPath = await writeSpec(dataDir, spec);
  const report = await runExperiment(specPath, createFixtureRunner(), { dataDir, repetitions: 2 });
  assert.equal(report.records.length, 4);
});

test("an experiment with zero records is explicitly not a valid comparison", async () => {
  const dataDir = await makeTmp("eng-empty");
  const specPath = await writeSpec(dataDir, baseSpec({ id: "test-empty" }));
  const controller = new AbortController();
  controller.abort(); // abort before any run starts
  const report = await runExperiment(specPath, createFixtureRunner(), { dataDir, signal: controller.signal });
  assert.equal(report.records.length, 0);
  assert.equal(report.comparison.valid, false, "empty experiment must not claim validity");
  assert.ok(report.comparison.note.includes("No runs recorded"));
});

test("a spec without a skill runs baseline only — no phantom skill variant", async () => {
  const dataDir = await makeTmp("eng-noskill");
  const spec = baseSpec({ id: "test-noskill" });
  delete spec.skill;
  const specPath = await writeSpec(dataDir, spec);
  const report = await runExperiment(specPath, createFixtureRunner(), { dataDir });
  assert.equal(report.records.length, 1);
  assert.equal(report.records[0]!.variantId, "baseline");
  assert.equal(report.records[0]!.status, "passed");
  assert.equal(report.skill, null);
});
