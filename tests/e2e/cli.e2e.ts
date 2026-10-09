/**
 * CLI e2e: every command exercised as a real subprocess, including the
 * full scaffold journey (init -> validate -> run -> report -> export).
 * No model is ever invoked (fixture runner only).
 */
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const CLI = path.join(REPO, "src", "cli.ts");

function cli(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? REPO,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 60_000,
    env: process.env,
  });
  return { code: res.status, out: (res.stdout ?? "") + (res.stderr ?? ""), stdout: res.stdout ?? "" };
}

test("no arguments prints usage and exits 1", () => {
  const r = cli([]);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes("skill-issue"));
  assert.ok(r.out.includes("validate"));
});

test("unknown command exits 1", () => {
  const r = cli(["definitely-not-a-command"]);
  assert.equal(r.code, 1);
});

test("--version prints the package version and exits 0", () => {
  const r = cli(["--version"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("validate accepts the example spec and rejects a broken one", () => {
  const good = cli(["validate", "examples/tasks/release-notes.fixture.json"]);
  assert.equal(good.code, 0);
  assert.ok(good.out.includes("OK"));

  const bad = cli(["validate", "examples/tasks/does-not-exist.json"]);
  assert.equal(bad.code, 1);
  assert.ok(bad.out.includes("cannot read/parse"));
});

test("prepare announces the plan and explicitly invokes no model", () => {
  const r = cli(["prepare", "examples/tasks/release-notes.fixture.json"]);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes("nothing executed, no model invoked"));
  assert.ok(r.out.includes("repetition 1: baseline -> skill"));
});

test("report and export fail cleanly on a missing experiment dir", () => {
  const r = cli(["report", path.join(tmpdir(), "skill-issue", "nope-does-not-exist")]);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes("no readable experiment"));
  const e = cli(["export", path.join(tmpdir(), "skill-issue", "nope-does-not-exist")]);
  assert.equal(e.code, 1);
  assert.ok(e.out.includes("no readable experiment"));
});

test("full scaffold journey: init, validate, run, report, export", async () => {
  const work = await mkdtemp(path.join(tmpdir(), "skill-issue-cli-e2e-"));
  const project = path.join(work, "my task"); // space in the name, on purpose
  const dataDir = path.join(work, "runs");

  // init
  const init = cli(["init", project]);
  assert.equal(init.code, 0, init.out);
  assert.ok(init.out.includes("scaffolded"));
  for (const f of ["task.json", "workspace/notes.md", "verifier/verify.mjs", "skill/SKILL.md"]) {
    assert.ok((await stat(path.join(project, f))).isFile(), `${f} missing from scaffold`);
  }

  // init refuses to overwrite an existing dir
  const again = cli(["init", project]);
  assert.equal(again.code, 1);
  assert.ok(again.out.includes("cannot create"));

  // validate the scaffold
  const validate = cli(["validate", path.join(project, "task.json")]);
  assert.equal(validate.code, 0, validate.out);

  // run it (fixture runner, no model)
  const run = cli(["run", path.join(project, "task.json"), "--data-dir", dataDir], { timeoutMs: 120_000 });
  assert.equal(run.code, 0, run.out);
  assert.ok(run.out.includes("runner: simulated agent"), "fixture runner announced");
  assert.ok(run.out.includes("[skill r1] PASSED"), `skill variant should pass: ${run.out}`);
  assert.ok(run.out.includes("[baseline r1] FAILED"), "baseline without out.txt should fail");

  // locate the experiment dir
  const experiments = await readdir(path.join(dataDir, "experiments"));
  assert.equal(experiments.length, 1);
  const expDir = path.join(dataDir, "experiments", experiments[0]!);
  const report = JSON.parse(await readFile(path.join(expDir, "experiment.json"), "utf8"));
  assert.equal(report.comparison.valid, true);
  const skillRec = report.records.find((r: { variantId: string }) => r.variantId === "skill");
  assert.equal(skillRec.status, "passed");
  assert.equal(skillRec.skillEvidence.observedRead, true);

  // report
  const reportOut = cli(["report", expDir]);
  assert.equal(reportOut.code, 0);
  assert.ok(reportOut.out.includes("PASSED"));

  // export
  const exportOut = cli(["export", expDir]);
  assert.equal(exportOut.code, 0, exportOut.out);
  const exported = JSON.parse(await readFile(path.join(expDir, "export.json"), "utf8"));
  assert.equal(exported.exportVersion, 1);
  assert.equal(typeof exported.promptHash, "string");
});

test("run rejects out-of-range repetitions before spawning anything", () => {
  const r = cli(["run", "examples/tasks/release-notes.fixture.json", "--repetitions", "0"]);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes("between 1 and 5"));
  const r2 = cli(["run", "examples/tasks/release-notes.fixture.json", "--repetitions", "abc"]);
  assert.equal(r2.code, 1);
});

test("the bin shim runs the CLI end to end", () => {
  const res = spawnSync(process.execPath, [path.join(REPO, "bin", "skill-issue.mjs"), "--version"], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(res.status, 0);
  assert.match((res.stdout ?? "").trim(), /^\d+\.\d+\.\d+$/);
});

test("viewer command serves the UI over HTTP and stops on SIGTERM", async () => {
  const port = 4300 + Math.floor(Math.random() * 400);
  const dataDir = await mkdtemp(path.join(tmpdir(), "skill-issue-viewer-cli-"));
  const child = spawn(process.execPath, [CLI, "viewer", "--data-dir", dataDir, "--port", String(port)], {
    cwd: REPO,
    stdio: "ignore",
    env: process.env,
  });
  try {
    // poll until the server answers
    let html = "";
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        if (res.ok) { html = await res.text(); break; }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(html.includes("Skill Issue"), "viewer HTML served");
    const api = await (await fetch(`http://127.0.0.1:${port}/api/experiments`)).json();
    assert.ok(Array.isArray(api), "experiments API returns a list");
    const missing = await fetch(`http://127.0.0.1:${port}/api/experiments/does-not-exist`);
    assert.equal(missing.status, 404);
  } finally {
    child.kill("SIGTERM");
    const gone = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 5000);
      child.on("exit", () => { clearTimeout(t); resolve(true); });
    });
    assert.ok(gone, "viewer exits on SIGTERM");
  }
});
