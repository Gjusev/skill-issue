import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rowFromRecord, refusalRow, rowKey, validateRow, readRows, appendRows, toReliagateTrial } from "../src/leaderboard/rows.ts";
import { makeTmp } from "./helpers.ts";
import type { RunRecord } from "../src/core/types.ts";

const meta = { skillId: "tdd", skillCommit: "a".repeat(40), taskId: "tdd/test-first-fix" };

function fakeRecord(over: Partial<RunRecord>): RunRecord {
  return {
    recordVersion: 1, experimentId: "e", taskId: "t", variantId: "baseline", repetition: 1,
    workspaceId: "baseline-r1",
    requested: { runner: "fixture", runnerVersion: null, model: null, effort: null, permissions: "acceptEdits", limits: { timeoutMsPerRun: 1000, repetitions: 1 } },
    observed: { model: null, skillsVisible: null },
    hashes: { taskSpec: "h", workspaceInitial: "h", skill: null, verifierBefore: "vhash", verifierAfter: "vhash" },
    startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:01Z",
    status: "passed", endReason: "ok",
    run: { status: "completed", exitCode: 0, timedOut: false, cancelled: false, stderrTail: "" },
    skillEvidence: { installed: false, observedRead: false, evidence: [] },
    events: [], output: { text: null, truncated: false },
    verifier: { status: "passed", exitCode: 0, durationMs: null, stdout: "", stderr: "" },
    metrics: { durationMs: 1234, tokensIn: 100, tokensOut: 5, costUsd: 0.01, turns: 2, providerProvenance: null },
    changes: [], comparison: { valid: true, reasons: [] },
    ...over,
  } as RunRecord;
}

test("row shape: passed record maps to success=true with metrics", () => {
  const row = rowFromRecord(fakeRecord({ status: "passed" }), meta);
  assert.deepEqual(validateRow(row), []);
  assert.equal(row.success, true);
  assert.equal(row.attempt, 0);
  assert.equal(row.tokens_in, 100);
  assert.equal(row.tokens_out, 5);
  assert.equal(row.cost_estimate, 0.01);
  assert.equal(row.wall_ms, 1234);
  assert.equal(row.verifier_hash, "vhash");
  assert.equal(row.error, undefined);
});

test("row shape: verifier failure maps to success=false", () => {
  const row = rowFromRecord(fakeRecord({ status: "failed" }), meta);
  assert.equal(row.success, false);
  assert.equal(row.error, undefined);
});

test("row shape: infrastructure error is an abstention (success=null) with reason", () => {
  const row = rowFromRecord(fakeRecord({ status: "infrastructure_error", endReason: "provider error" }), meta);
  assert.equal(row.success, null);
  assert.match(row.error ?? "", /provider error/);
});

test("row shape: invalid comparison is an abstention carrying the reason", () => {
  const rec = fakeRecord({ status: "passed" });
  rec.comparison = { valid: false, reasons: ["initial workspace bytes differ between variants (beyond the skill install)"] };
  const row = rowFromRecord(rec, meta);
  assert.equal(row.success, null);
  assert.match(row.error ?? "", /workspace bytes differ/);
});

test("row shape: refusal rows record reasons and never count as failures", () => {
  const row = refusalRow(meta, 3, ["network: scripts/fetch.sh:1 — network tool invocation"]);
  assert.deepEqual(validateRow(row), []);
  assert.equal(row.success, null);
  assert.equal(row.attempt, 3);
  assert.match(row.error ?? "", /^refused by security gate:/);
});

test("row key is complete for resume", () => {
  const a = rowKey({ skill_id: "s", task_id: "t", variant: "skill", attempt: 2 });
  assert.equal(a, "s|t|skill|2");
  assert.notEqual(a, rowKey({ skill_id: "s", task_id: "t", variant: "baseline", attempt: 2 }));
});

test("validateRow rejects wrong shapes", () => {
  assert.ok(validateRow({}).length > 0);
  assert.ok(validateRow({ skill_id: "s", task_id: "t", variant: "other", attempt: 0, success: true, verifier_hash: "v" }).some((e) => e.includes("variant")));
  assert.ok(validateRow({ skill_id: "s", task_id: "t", variant: "skill", attempt: -1, success: true, verifier_hash: "v" }).some((e) => e.includes("attempt")));
  assert.ok(validateRow({ skill_id: "s", task_id: "t", variant: "skill", attempt: 0, success: 1, verifier_hash: "v" }).some((e) => e.includes("success")));
  assert.deepEqual(validateRow({ skill_id: "s", task_id: "t", variant: "skill", attempt: 0, success: null, tokens_in: null, tokens_out: null, cost_estimate: null, wall_ms: 0, verifier_hash: "not-run", error: "x" }), []);
});

test("JSONL append/read roundtrip; missing file is empty history", async () => {
  const dir = await makeTmp("rows");
  const file = path.join(dir, "runs.jsonl");
  assert.deepEqual((await readRows(file)).rows, []);
  const row = refusalRow(meta, 0, ["because"]);
  await appendRows(file, [row]);
  await appendRows(file, [rowFromRecord(fakeRecord({ status: "passed" }), meta)]);
  const { rows, errors } = await readRows(file);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.error, row.error);
});

test("readRows flags corrupt lines instead of silently dropping them", async () => {
  const dir = await makeTmp("rows-bad");
  const file = path.join(dir, "runs.jsonl");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, '{"skill_id":"s"}\nnot json\n', "utf8");
  const { rows, errors } = await readRows(file);
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 2);
});

test("reliagate projection: schema expected by reliagate/adapters/jsonl.py", () => {
  const trial = toReliagateTrial(rowFromRecord(fakeRecord({ status: "passed", variantId: "skill", repetition: 3 }), meta));
  assert.deepEqual(
    Object.keys(trial).sort(),
    ["attempt", "metadata", "success", "task_id", "version"],
  );
  assert.equal(trial.attempt, 2); // 0-based
  assert.equal(trial.version, meta.skillCommit);
  assert.equal(trial.success, true);
  const base = toReliagateTrial(rowFromRecord(fakeRecord({}), meta));
  assert.equal(base.version, "baseline");
});
