import { test } from "node:test";
import assert from "node:assert/strict";
import { finalizeComparison } from "../src/core/engine.ts";
import type { RunRecord } from "../src/core/types.ts";

function record(variantId: "baseline" | "skill", over: Partial<RunRecord> = {}): RunRecord {
  return {
    recordVersion: 1,
    experimentId: "e",
    taskId: "t",
    variantId,
    repetition: 1,
    workspaceId: `${variantId}-r1`,
    requested: {
      runner: "fixture", runnerVersion: "1", model: null, effort: null,
      permissions: "acceptEdits", limits: { timeoutMsPerRun: 1000, repetitions: 1 },
    },
    hashes: { taskSpec: "s", workspaceInitial: "same", skill: null, verifierBefore: "v", verifierAfter: "v" },
    startedAt: "", endedAt: "",
    status: "passed",
    endReason: "",
    run: { status: "completed", exitCode: 0, timedOut: false, cancelled: false },
    skillEvidence: { installed: false, observedRead: null, evidence: [] },
    events: [],
    output: { text: null, truncated: false },
    verifier: { status: "passed", exitCode: 0, durationMs: 1, stdout: "", stderr: "" },
    metrics: { durationMs: 1, tokensIn: null, tokensOut: null, costUsd: null, turns: null, providerProvenance: null },
    changes: [],
    comparison: { valid: true, reasons: [] },
    ...over,
  } as RunRecord;
}

test("identical setup stays comparable and statuses are preserved", () => {
  const a = record("baseline");
  const b = record("skill");
  finalizeComparison([a, b], { isolateGlobalConfig: true });
  assert.equal(a.comparison.valid, true);
  assert.equal(b.comparison.valid, true);
  assert.equal(a.status, "passed");
});

test("different initial workspace bytes invalidate BOTH records", () => {
  const a = record("baseline");
  const b = record("skill", { hashes: { ...record("skill").hashes, workspaceInitial: "different" } });
  finalizeComparison([a, b], { isolateGlobalConfig: true });
  assert.equal(a.comparison.valid, false);
  assert.equal(b.comparison.valid, false);
  assert.equal(a.status, "invalid_comparison");
  assert.equal(b.status, "invalid_comparison");
  assert.ok(b.comparison.reasons.some((r) => r.includes("workspace bytes differ")));
});

test("configuration drift beyond the skill invalidates", () => {
  const a = record("baseline");
  const b = record("skill", { requested: { ...record("skill").requested, model: "bigger-model" } });
  finalizeComparison([a, b], { isolateGlobalConfig: true });
  assert.equal(b.comparison.valid, false);
  assert.ok(b.comparison.reasons.some((r) => r.includes("configuration differs")));
});

test("a runner that cannot isolate global config is rejected as contaminated", () => {
  const a = record("baseline");
  const b = record("skill");
  finalizeComparison([a, b], { isolateGlobalConfig: false });
  assert.equal(a.comparison.valid, false);
  assert.ok(a.comparison.reasons.some((r) => r.includes("cannot isolate global configuration")));
});

test("seeded verifier-tamper reason survives and overrides passed", () => {
  const a = record("baseline");
  const b = record("skill", {
    status: "infrastructure_error",
    comparison: { valid: false, reasons: ["verifier files were modified during the run; its result cannot be trusted"] },
  });
  finalizeComparison([a, b], { isolateGlobalConfig: true });
  assert.equal(b.comparison.valid, false);
  assert.equal(b.status, "invalid_comparison");
  assert.equal(a.comparison.valid, true); // baseline not punished for the skill run's tamper
});

test("missing sibling variant leaves the lone record comparable", () => {
  const a = record("baseline");
  finalizeComparison([a], { isolateGlobalConfig: true });
  assert.equal(a.comparison.valid, true);
});
