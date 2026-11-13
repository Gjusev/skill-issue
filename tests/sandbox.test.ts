import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { scanSkillDir } from "../src/leaderboard/sandbox.ts";
import { REPO } from "./helpers.ts";

const FIX = path.join(REPO, "tests", "fixtures", "leaderboard");

test("security gate: clean skill is allowed", async () => {
  const res = await scanSkillDir(path.join(FIX, "clean-skill"));
  assert.equal(res.verdict, "allow", res.reasons.join("; "));
  assert.deepEqual(res.findings, []);
  assert.ok(res.filesScanned >= 2); // SKILL.md + scripts/copy.sh
});

test("security gate: network skill is refused (fenced markdown + scripts)", async () => {
  const res = await scanSkillDir(path.join(FIX, "network-skill"));
  assert.equal(res.verdict, "refuse");
  assert.ok(res.findings.some((f) => f.kind === "network" && f.file === "SKILL.md"));
  assert.ok(res.findings.some((f) => f.kind === "network" && f.file.endsWith("fetch.sh")));
  assert.ok(res.reasons.every((r) => r.startsWith("network:")));
});

test("security gate: shell/exec skill is refused (fenced markdown + scripts)", async () => {
  const res = await scanSkillDir(path.join(FIX, "exec-skill"));
  assert.equal(res.verdict, "refuse");
  assert.ok(res.findings.some((f) => f.kind === "shell-exec" && f.file === "SKILL.md"));
  assert.ok(res.findings.some((f) => f.kind === "shell-exec" && f.file.endsWith("run.cjs")));
});

test("security gate: shipped secrets are refused even in markdown prose", async () => {
  const res = await scanSkillDir(path.join(FIX, "secret-skill"));
  assert.equal(res.verdict, "refuse");
  assert.ok(res.findings.some((f) => f.kind === "secret"));
});

test("security gate: localhost URLs inside fences are allowed (fixture-server tasks)", async () => {
  const res = await scanSkillDir(path.join(FIX, "localhost-skill"));
  assert.equal(res.verdict, "allow", res.reasons.join("; "));
});

test("security gate: localhost exemption can be disabled", async () => {
  const res = await scanSkillDir(path.join(FIX, "localhost-skill"), { allowLocalhost: false });
  assert.equal(res.verdict, "refuse");
});

test("security gate: missing skill directory is refused", async () => {
  const res = await scanSkillDir(path.join(FIX, "does-not-exist"));
  assert.equal(res.verdict, "refuse");
  assert.match(res.reasons[0] ?? "", /not found/);
});
