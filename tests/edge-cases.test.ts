import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { runExperiment, deriveRunStatus } from "../src/core/engine.ts";
import { parseStream } from "../src/runners/parse.ts";
import { createFixtureRunner } from "../src/runners/fixture.ts";
import { baseSpec, writeSpec, makeTmp, REPO } from "./helpers.ts";
import type { RawRun } from "../src/runners/types.ts";

function fakeRaw(over: Partial<RawRun> = {}): RawRun {
  return {
    cmdDisplay: "x",
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    error: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    isolation: { configDirIsolated: true, authSource: null, note: "" },
    ...over,
  };
}

// ---------- deriveRunStatus: the integrity chain, exhaustively ----------

test("status: timeout and cancellation win over everything", () => {
  const parsed = parseStream('{"type":"result","is_error":false,"result":"ok"}', null, []);
  assert.equal(deriveRunStatus(fakeRaw({ timedOut: true }), parsed), "timeout");
  assert.equal(deriveRunStatus(fakeRaw({ cancelled: true, timedOut: false }), parsed), "cancelled");
});

test("status: a clean result with exit 0 completes even with garbage-free stream", () => {
  const parsed = parseStream('{"type":"result","is_error":false,"result":"done"}', null, []);
  assert.equal(deriveRunStatus(fakeRaw({ stdout: "line\n" }), parsed), "completed");
});

test("status: non-zero exit WITH a result message still completes", () => {
  const parsed = parseStream('{"type":"result","is_error":false,"result":"done"}', null, []);
  assert.equal(deriveRunStatus(fakeRaw({ exitCode: 1, stdout: "x\n" }), parsed), "completed");
});

test("status: non-zero exit without a result is an error", () => {
  const parsed = parseStream("", null, []);
  assert.equal(deriveRunStatus(fakeRaw({ exitCode: 1, stdout: "some log line\n" }), parsed), "error");
});

test("status: empty stdout and no result is an error (no completion evidence)", () => {
  const parsed = parseStream("", null, []);
  assert.equal(deriveRunStatus(fakeRaw(), parsed), "error");
});

test("status: provider is_error and spawn errors are errors", () => {
  const bad = parseStream('{"type":"result","is_error":true,"result":"auth failed"}', null, []);
  assert.equal(deriveRunStatus(fakeRaw({ stdout: "x\n" }), bad), "error");
  const ok = parseStream('{"type":"result","is_error":false,"result":"ok"}', null, []);
  assert.equal(deriveRunStatus(fakeRaw({ error: "ENOENT", stdout: "x\n" }), ok), "error");
});

// ---------- parse edge cases ----------

test("parse: duplicate result messages, the last one wins", () => {
  const stream = [
    '{"type":"result","is_error":false,"result":"first","duration_ms":1}',
    '{"type":"result","is_error":false,"result":"second","duration_ms":2}',
  ].join("\n");
  const parsed = parseStream(stream, null, []);
  assert.equal(parsed.resultText, "second");
  assert.equal(parsed.providerMetrics.durationMs, 2);
});

test("parse: zero is a measured value, not null", () => {
  const parsed = parseStream('{"type":"result","is_error":false,"result":"ok","num_turns":0,"total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0}}', null, []);
  assert.equal(parsed.providerMetrics.turns, 0);
  assert.equal(parsed.providerMetrics.costUsd, 0);
  assert.equal(parsed.providerMetrics.tokensIn, 0);
  assert.equal(parsed.providerMetrics.tokensOut, 0);
});

test("parse: empty stream yields all-null metrics and zero corrupt lines", () => {
  const parsed = parseStream("", null, []);
  assert.equal(parsed.resultText, null);
  assert.equal(parsed.corruptLines, 0);
  assert.equal(parsed.providerMetrics.durationMs, null);
  assert.equal(parsed.observedModel, null);
  assert.equal(parsed.observedSkills, null);
});

// ---------- engine edge cases through the fixture runner ----------

async function run(spec: ReturnType<typeof baseSpec>, dataDir: string) {
  const specPath = await writeSpec(dataDir, spec);
  return runExperiment(specPath, createFixtureRunner(), { dataDir });
}

test("engine: missing verifier command is an infrastructure error, never a pass", async () => {
  const dataDir = await makeTmp("edge-noverifier");
  const report = await run(
    baseSpec({
      id: "edge-noverifier",
      verifier: { copyFrom: path.join(REPO, "fixtures", "verifier-pass"), command: ["definitely-not-a-real-command-xyz"], successCriteria: "x" },
    }),
    dataDir,
  );
  for (const rec of report.records) {
    assert.equal(rec.verifier.status, "error");
    assert.equal(rec.status, "infrastructure_error");
  }
});

test("engine: verifier timeout is an infrastructure error", async () => {
  const dataDir = await makeTmp("edge-vtimeout");
  const slowVerifier = path.join(dataDir, "slow-verifier");
  await mkdir(slowVerifier, { recursive: true });
  await writeFile(path.join(slowVerifier, "verify.mjs"), "setTimeout(() => process.exit(0), 60000);\n", "utf8");
  const report = await run(
    baseSpec({
      id: "edge-vtimeout",
      verifier: { copyFrom: slowVerifier, command: ["node", "verify.mjs"], timeoutMs: 500, successCriteria: "x" },
    }),
    dataDir,
  );
  for (const rec of report.records) {
    assert.equal(rec.verifier.status, "error");
    assert.equal(rec.status, "infrastructure_error");
  }
});

test("engine: files the verifier writes into the workspace are not attributed to the agent", async () => {
  const dataDir = await makeTmp("edge-vtouch");
  const touchyVerifier = path.join(dataDir, "touch-verifier");
  await mkdir(touchyVerifier, { recursive: true });
  await writeFile(
    path.join(touchyVerifier, "verify.mjs"),
    `import { writeFile } from "node:fs/promises"; import path from "node:path";
     const ws = process.env.SKILL_ISSUE_WORKSPACE;
     await writeFile(path.join(ws, "verifier-touched.txt"), "side effect of the verifier");
     process.exit(0);
    `,
    "utf8",
  );
  const report = await run(
    baseSpec({
      id: "edge-vtouch",
      verifier: { copyFrom: touchyVerifier, command: ["node", "verify.mjs"], successCriteria: "x" },
      agent: { runner: "fixture", fixture: { baseline: [], skill: [] } },
    }),
    dataDir,
  );
  for (const rec of report.records) {
    assert.equal(rec.status, "passed");
    assert.equal(rec.changes.length, 0, `verifier side effects leaked into changes: ${JSON.stringify(rec.changes)}`);
  }
});

test("engine: unicode filenames and empty directories are tracked as changes", async () => {
  const dataDir = await makeTmp("edge-unicode");
  const report = await run(
    baseSpec({
      id: "edge-unicode",
      agent: {
        runner: "fixture",
        fixture: {
          baseline: [],
          skill: [
            { action: "writeFile", path: "información-äöü-文件.md", content: "unicode content\n" },
            { action: "writeFile", path: "empty-dir-marker.txt/.keep", content: "" },
            { action: "exit", code: 0 },
          ],
        },
      },
    }),
    dataDir,
  );
  const skill = report.records.find((r) => r.variantId === "skill")!;
  assert.ok(skill.changes.some((c) => c.path.includes("información-äöü-文件.md")), "unicode file change tracked");
});

test("engine: creating and deleting an empty directory is visible in changes", async () => {
  const dataDir = await makeTmp("edge-emptydir");
  // The fixture agent cannot mkdir; drive snapshotTree/diffTrees directly.
  const { snapshotTree, diffTrees } = await import("../src/core/hash.ts");
  const dir = path.join(dataDir, "ws");
  await mkdir(path.join(dir, "sub"), { recursive: true });
  const before = await snapshotTree(dir);
  await mkdir(path.join(dir, "new-empty"), { recursive: true });
  await rm(path.join(dir, "sub"), { recursive: true });
  const after = await snapshotTree(dir);
  const changes = diffTrees(before, after);
  assert.ok(changes.some((c) => c.change === "created" && c.path === "[dir] new-empty"));
  assert.ok(changes.some((c) => c.change === "deleted" && c.path === "[dir] sub"));
});
