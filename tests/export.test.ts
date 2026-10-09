import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExport } from "../src/core/export.ts";
import type { ExperimentReport } from "../src/core/types.ts";

function report(): ExperimentReport {
  return {
    reportVersion: 1,
    experimentId: "exp-1",
    taskId: "task-1",
    createdAt: "2026-10-09T00:00:00.000Z",
    specPath: "C:\\Users\\someone\\runs\\exp-1",
    specHash: "a".repeat(64),
    description: "desc",
    successCriteria: "criterion",
    skill: { name: "demo", hash: "b".repeat(64) },
    agent: { runner: "claude-code", runnerVersion: "2.1.294 (Claude Code)", model: "sonnet", effort: null },
    limits: { timeoutMsPerRun: 1000, maxBudgetUsd: 0.5, repetitions: 1 },
    repetitions: 1,
    records: [
      {
        recordVersion: 1,
        experimentId: "exp-1",
        taskId: "task-1",
        variantId: "baseline",
        repetition: 1,
        workspaceId: "baseline-r1",
        requested: { runner: "claude-code", runnerVersion: "2.1.294", model: "sonnet", effort: null, permissions: "acceptEdits", limits: { timeoutMsPerRun: 1000, maxBudgetUsd: 0.5, repetitions: 1 } },
        observed: { model: "sonnet-5-5", skillsVisible: ["release-notes-format"] },
        hashes: { taskSpec: "a".repeat(64), workspaceInitial: "w", skill: null, verifierBefore: "v", verifierAfter: "v" },
        startedAt: "2026-10-09T00:00:00.000Z",
        endedAt: "2026-10-09T00:00:05.000Z",
        status: "failed",
        endReason: "agent completed; verifier did not observe the success criterion",
        run: { status: "completed", exitCode: 0, timedOut: false, cancelled: false, stderrTail: "" },
        skillEvidence: { installed: false, observedRead: false, evidence: [] },
        events: [{ type: "tool_use:Write", detail: "out.txt" }],
        output: { text: "I wrote some files at C:\\Users\\someone\\ws\\out.txt", truncated: false },
        verifier: { status: "failed", exitCode: 1, durationMs: 120, stdout: "", stderr: "missing section" },
        metrics: { durationMs: 5000, tokensIn: null, tokensOut: null, costUsd: null, turns: null, providerProvenance: null },
        changes: [{ path: "out.txt", change: "created" }],
        comparison: { valid: true, reasons: [] },
      },
    ],
    comparison: { valid: true, reasons: [], note: "Descriptive comparison with 1 repetition(s): insufficient evidence for superiority claims." },
  };
}

test("export excludes prompt text, raw events and output; keeps hash and provenance", async () => {
  const exp = await buildExport(report(), "SECRET PROMPT TEXT about the task");
  const json = JSON.stringify(exp);
  assert.ok(!json.includes("SECRET PROMPT TEXT"), "prompt must not appear");
  assert.equal(exp.promptHash, await (async () => {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update("SECRET PROMPT TEXT about the task").digest("hex");
  })());
  assert.ok(!json.includes("tool_use:Write"), "raw event types must not appear");
  assert.ok(!json.includes("I wrote some files"), "agent output text must not appear");
  // provenance preserved
  assert.equal(exp.agent.runnerVersion, "2.1.294 (Claude Code)");
  assert.equal(exp.variants[0]!.metrics.tokensIn, null, "unmeasured stays null in export");
  assert.equal(exp.variants[0]!.status, "failed");
  assert.equal(exp.variants[0]!.skillEvidence.observedRead, false);
  assert.deepEqual(exp.variants[0]!.changes, ["created: out.txt"]);
});

test("export is JSON round-trippable", async () => {
  const exp = await buildExport(report(), "p");
  const back = JSON.parse(JSON.stringify(exp));
  assert.equal(back.exportVersion, 1);
  assert.equal(back.variants.length, 1);
});

test("export excludes absolute paths even when records contain them", async () => {
  const home = (await import("node:os")).homedir();
  const r = report();
  r.records[0]!.endReason = `failed after touching ${home}\\some\\private\\path and C:\\Users\\who\\elsewhere`;
  const exp = await buildExport(r, "p");
  const json = JSON.stringify(exp);
  assert.ok(!json.includes(home), "home directory must not survive export");
  assert.ok(!json.includes("C:\\Users\\who"), "other absolute paths must not survive export");
  assert.ok(json.includes("~"));
});
