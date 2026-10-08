import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskSpec, FixtureStep } from "../src/core/types.ts";

export const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Temp dir per test file; also exercises paths with spaces on purpose. */
export async function makeTmp(label: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `skill issue ${label} `));
}

export function baseSpec(partial: Partial<TaskSpec> & { id?: string } = {}): TaskSpec {
  return {
    specVersion: 1,
    id: partial.id ?? "test-task",
    task: {
      prompt: "test prompt for the fixture agent",
      workspaceCopyFrom: path.join(REPO, "fixtures", "workspace-a"),
      ...partial.task,
    },
    verifier: {
      copyFrom: path.join(REPO, "fixtures", "verifier-pass"),
      command: ["node", "verify.mjs"],
      successCriteria: "fixture criterion (synthetic)",
      ...partial.verifier,
    },
    skill: partial.skill ?? { name: "demo-skill", path: path.join(REPO, "fixtures", "skill", "demo-skill") },
    agent: partial.agent ?? {
      runner: "fixture",
      fixture: { baseline: [], skill: [] },
    },
    limits: partial.limits ?? { timeoutMsPerRun: 20_000, repetitions: 1 },
    description: partial.description,
  } as TaskSpec;
}

export async function writeSpec(dir: string, spec: TaskSpec): Promise<string> {
  const p = path.join(dir, `${spec.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
  await writeFile(p, JSON.stringify(spec), "utf8");
  return p;
}

/** The canonical "skill gets read and the task format is followed" steps. */
export const SKILL_FOLLOWS_FORMAT: FixtureStep[] = [
  { action: "invokeSkill" },
  { action: "readSkill" },
  { action: "writeFile", path: "out.txt", content: "made with the skill\n" },
];

export const WRONG_FORMAT: FixtureStep[] = [
  { action: "writeFile", path: "out.txt", content: "made without the skill\n" },
];
