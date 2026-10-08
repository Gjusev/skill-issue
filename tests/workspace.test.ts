import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { prepareWorkspace } from "../src/core/workspace.ts";
import { hashTree } from "../src/core/hash.ts";
import { makeTmp, REPO } from "./helpers.ts";

const FIXWS = path.join(REPO, "fixtures", "workspace-a");
const SKILL = { name: "demo-skill", path: path.join(REPO, "fixtures", "skill", "demo-skill") };

test("baseline and skill variants start from identical task bytes", async () => {
  const dir = await makeTmp("ws-equal");
  const base = await prepareWorkspace(FIXWS, path.join(dir, "base", "workspace"), {});
  const withSkill = await prepareWorkspace(FIXWS, path.join(dir, "skill", "workspace"), { skill: SKILL });
  // The comparable hash ignores .claude (the skill install IS the difference).
  assert.equal(base.initialHashExclSkill, withSkill.initialHashExclSkill);
  assert.equal(await hashTree(base.workspaceDir), await hashTree(withSkill.workspaceDir, [".claude"]));
});

test("skill is installed under .claude/skills/<name>", async () => {
  const dir = await makeTmp("ws-install");
  const ws = path.join(dir, "with space", "workspace");
  await prepareWorkspace(FIXWS, ws, { skill: SKILL });
  const sk = path.join(ws, ".claude", "skills", "demo-skill", "SKILL.md");
  assert.ok((await stat(sk)).isFile(), "SKILL.md must exist in the workspace config");
});

test("workspaces are independent (writes in one do not affect the other)", async () => {
  const dir = await makeTmp("ws-indep");
  const a = await prepareWorkspace(FIXWS, path.join(dir, "a", "workspace"), {});
  const b = await prepareWorkspace(FIXWS, path.join(dir, "b", "workspace"), {});
  await writeFile(path.join(a.workspaceDir, "hello.txt"), "mutated in a");
  const hb = await hashTree(b.workspaceDir);
  assert.equal(hb, b.initialHashExclSkill, "workspace b must be untouched");
});

test("workspace paths containing spaces work end to end", async () => {
  const dir = await makeTmp("ws-space");
  const ws = await prepareWorkspace(FIXWS, path.join(dir, "a dir with spaces", "nested", "workspace"), { skill: SKILL });
  assert.ok((await stat(path.join(ws.workspaceDir, "hello.txt"))).isFile());
  assert.notEqual(ws.initialHashExclSkill, "");
});
