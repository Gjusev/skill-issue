import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { hashTree, snapshotTree, diffTrees } from "../src/core/hash.ts";
import { makeTmp, REPO } from "./helpers.ts";

test("hashTree is deterministic for identical bytes", async () => {
  const dir = await makeTmp("hash-det");
  const a = path.join(dir, "a");
  const b = path.join(dir, "b");
  await cp(path.join(REPO, "fixtures", "workspace-a"), a, { recursive: true });
  await cp(path.join(REPO, "fixtures", "workspace-a"), b, { recursive: true });
  assert.equal(await hashTree(a), await hashTree(b));
});

test("hashTree changes when content changes", async () => {
  const dir = await makeTmp("hash-change");
  const a = path.join(dir, "a");
  await cp(path.join(REPO, "fixtures", "workspace-a"), a, { recursive: true });
  const h1 = await hashTree(a);
  await writeFile(path.join(a, "hello.txt"), "changed\n");
  const h2 = await hashTree(a);
  assert.notEqual(h1, h2);
});

test("hashTree excludeTopLevel ignores the skill config dir", async () => {
  const dir = await makeTmp("hash-excl");
  const a = path.join(dir, "a");
  await cp(path.join(REPO, "fixtures", "workspace-a"), a, { recursive: true });
  const h1 = await hashTree(a, [".claude"]);
  await mkdir(path.join(a, ".claude", "skills", "x"), { recursive: true });
  await writeFile(path.join(a, ".claude", "skills", "x", "SKILL.md"), "skill");
  const h2 = await hashTree(a, [".claude"]);
  assert.equal(h1, h2);
});

test("diffTrees reports created, modified and deleted", async () => {
  const dir = await makeTmp("hash-diff");
  const a = path.join(dir, "a");
  await mkdir(a, { recursive: true });
  await writeFile(path.join(a, "keep.txt"), "same");
  await writeFile(path.join(a, "mod.txt"), "v1");
  await writeFile(path.join(a, "del.txt"), "gone");
  const before = await snapshotTree(a);
  await writeFile(path.join(a, "mod.txt"), "v2");
  await rm(path.join(a, "del.txt"));
  await writeFile(path.join(a, "new.txt"), "new");
  const after = await snapshotTree(a);
  const changes = diffTrees(before, after);
  assert.deepEqual(
    changes.map((c) => `${c.change}:${c.path}`).sort(),
    ["created:new.txt", "deleted:del.txt", "modified:mod.txt"],
  );
});
