import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSpec } from "../src/core/spec.ts";
import { baseSpec, writeSpec, makeTmp } from "./helpers.ts";

test("valid spec loads and resolves paths", async () => {
  const dir = await makeTmp("spec-ok");
  const p = await writeSpec(dir, baseSpec());
  const res = await loadSpec(p);
  assert.equal(res.ok, true, res.errors.join("; "));
  assert.equal(res.spec?.agent.runner, "fixture");
  assert.ok(path.isAbsolute(res.spec?.task.workspaceCopyFrom ?? ""));
});

test("missing prompt is rejected", async () => {
  const dir = await makeTmp("spec-bad1");
  const spec = baseSpec();
  (spec.task as { prompt?: string }).prompt = "";
  const p = await writeSpec(dir, spec);
  const res = await loadSpec(p);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("prompt")));
});

test("unknown runner is rejected", async () => {
  const dir = await makeTmp("spec-bad2");
  const spec = baseSpec();
  (spec.agent as { runner: string }).runner = "gpt-9000";
  const p = await writeSpec(dir, spec);
  const res = await loadSpec(p);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("runner")));
});

test("nonexistent workspace directory is rejected", async () => {
  const dir = await makeTmp("spec-bad3");
  const spec = baseSpec({ task: { prompt: "x", workspaceCopyFrom: path.join(dir, "nope") } });
  const p = await writeSpec(dir, spec);
  const res = await loadSpec(p);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("workspaceCopyFrom")));
});

test("skill directory without SKILL.md is rejected", async () => {
  const dir = await makeTmp("spec-bad4");
  const emptySkill = path.join(dir, "empty-skill");
  await mkdir(emptySkill);
  const spec = baseSpec({ skill: { name: "empty-skill", path: emptySkill } });
  const p = await writeSpec(dir, spec);
  const res = await loadSpec(p);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("SKILL.md")));
});

test("fixture runner without steps is rejected", async () => {
  const dir = await makeTmp("spec-bad5");
  const spec = baseSpec();
  spec.agent.fixture = undefined as never;
  const p = await writeSpec(dir, spec);
  const res = await loadSpec(p);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("fixture")));
});

test("unparseable json is rejected with a clear error", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "skill-issue-spec-bad6-"));
  const p = path.join(dir, "broken.json");
  await writeFile(p, "{not json", "utf8");
  const res = await loadSpec(p);
  assert.equal(res.ok, false);
  assert.ok(res.errors[0]!.includes("read/parse"));
});

test("repetitions out of range are rejected", async () => {
  const dir = await makeTmp("spec-bad7");
  const spec = baseSpec({ limits: { timeoutMsPerRun: 1000, repetitions: 99 } });
  const p = await writeSpec(dir, spec);
  const res = await loadSpec(p);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("repetitions")));
});
