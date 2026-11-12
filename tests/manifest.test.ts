import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseYamlSubset, validateManifest, loadManifest } from "../src/leaderboard/manifest.ts";
import { REPO } from "./helpers.ts";

test("yaml subset: scalars, comments, nesting", () => {
  const doc = parseYamlSubset(`
# leading comment
name: demo
count: 3
enabled: true
nothing: null
quoted: "hello # not a comment"
inline: [a, b, 2]
outer:
  inner: value
      `);
  assert.deepEqual(doc, {
    name: "demo", count: 3, enabled: true, nothing: null,
    quoted: "hello # not a comment", inline: ["a", "b", 2],
    outer: { inner: "value" },
  });
});

test("yaml subset: block scalar keeps newlines", () => {
  const doc = parseYamlSubset(`prompt: |
    line one
    line two
next: 1`);
  assert.equal((doc as { prompt: string }).prompt, "line one\nline two\n");
  assert.equal((doc as { next: number }).next, 1);
});

test("yaml subset: list of maps with nested list of maps", () => {
  const doc = parseYamlSubset(`
skills:
  - id: a
    repo: owner/repo
    tasks:
      - id: t1
        title: one
      - id: t2
        title: two
  - id: b
    tasks:
      - id: t3
        title: three
`);
  const skills = (doc as { skills: Array<{ id: string; repo?: string; tasks: Array<{ id: string }> }> }).skills;
  assert.equal(skills.length, 2);
  assert.equal(skills[0]?.repo, "owner/repo");
  assert.deepEqual(skills[0]?.tasks.map((t) => t.id), ["t1", "t2"]);
  assert.deepEqual(skills[1]?.tasks.map((t) => t.id), ["t3"]);
});

test("yaml subset: tabs and bad indentation are hard errors", () => {
  assert.throws(() => parseYamlSubset("a:\n\tb: 1"), /tabs/);
  assert.throws(() => parseYamlSubset("key value"), /expected 'key: value'/);
});

test("manifest validation: rejects missing commit / license / tasks", () => {
  const bad = validateManifest({
    manifestVersion: 1, name: "x", harness: "fixture", k: 1, results: "r.jsonl",
    skills: [{ id: "s", repo: "owner/repo", commit: "short", license: "", tasks: [] }],
  });
  assert.ok(bad.errors.some((e) => e.includes("40-hex")));
  assert.ok(bad.errors.some((e) => e.includes("license")));
  assert.ok(bad.errors.some((e) => e.includes("at least one task")));
  assert.equal(bad.manifest, null);
});

test("real leaderboard manifest: 15 skills, 45 designed tasks, valid pins", async () => {
  const res = await loadManifest(path.join(REPO, "leaderboard", "manifest.yaml"));
  assert.equal(res.ok, true, res.errors.join("; "));
  const m = res.manifest!;
  assert.equal(m.manifestVersion, 1);
  assert.ok(m.harness === "claude-code" || m.harness === "fixture");
  assert.ok(m.k >= 1 && m.k <= 5);
  assert.equal(m.skills.length, 15);
  const tasks = m.skills.flatMap((s) => s.tasks);
  assert.equal(tasks.length, 45);
  for (const s of m.skills) {
    assert.match(s.commit, /^[0-9a-f]{40}$/);
    assert.ok(s.license.length > 0);
    assert.equal(s.tasks.length, 3);
  }
  // exactly one excluded entry (license unresolved) with a reason
  const excluded = m.skills.filter((s) => s.excluded);
  assert.equal(excluded.length, 1);
  assert.ok(excluded[0]!.excludedReason && excluded[0]!.excludedReason.length > 0);
  // every task has a deterministic verifier kind and a needsNetwork decision
  for (const t of tasks) {
    assert.ok(t.criterion.length > 10, `${t.id} needs a criterion`);
    assert.equal(t.status, "designed");
    assert.equal(typeof t.needsNetwork, "boolean");
  }
  const kinds = new Set(tasks.map((t) => t.verifierKind));
  for (const k of ["file-exists", "tests-pass", "lint-holds", "ffprobe", "fixture-server"] as const) {
    assert.ok(kinds.has(k), `expected verifier kind ${k} to appear in the manifest`);
  }
  // skill ids and task ids are globally unique
  const ids = m.skills.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  const tids = tasks.map((t) => `${ids[m.skills.findIndex((s) => s.tasks.includes(t))]}/${t.id}`);
  assert.equal(new Set(tids).size, tids.length);
});
