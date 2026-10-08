import { stat } from "node:fs/promises";
import path from "node:path";
import type { TaskSpec } from "./types.ts";

export interface SpecLoadResult {
  ok: boolean;
  errors: string[];
  spec: TaskSpec | null;
  /** Directory the spec file lives in; relative paths in the spec resolve from it. */
  baseDir: string;
}

export async function loadSpec(specPath: string): Promise<SpecLoadResult> {
  const baseDir = path.dirname(path.resolve(specPath));
  const errors: string[] = [];
  let raw: unknown = null;
  try {
    const { readFile } = await import("node:fs/promises");
    raw = JSON.parse(await readFile(specPath, "utf8"));
  } catch (e) {
    return { ok: false, errors: [`cannot read/parse spec: ${(e as Error).message}`], spec: null, baseDir };
  }
  const spec = raw as Partial<TaskSpec>;
  const need = (cond: boolean, msg: string) => { if (!cond) errors.push(msg); };

  need(spec.specVersion === 1, "specVersion must be 1");
  need(typeof spec.id === "string" && /^[a-z0-9][a-z0-9-]*$/.test(spec.id ?? ""), "id must be kebab-case");
  need(typeof spec.task?.prompt === "string" && spec.task.prompt.length > 0, "task.prompt is required");
  need(typeof spec.task?.workspaceCopyFrom === "string", "task.workspaceCopyFrom is required");
  need(Array.isArray(spec.verifier?.command) && spec.verifier.command.length > 0, "verifier.command must be a non-empty array");
  need(typeof spec.verifier?.successCriteria === "string" && spec.verifier.successCriteria.length > 0, "verifier.successCriteria is required");
  need(typeof spec.verifier?.copyFrom === "string", "verifier.copyFrom is required");
  if (spec.agent?.runner === "fixture") {
    need(Array.isArray(spec.agent?.fixture?.baseline), "agent.fixture.baseline steps required for fixture runner");
    need(Array.isArray(spec.agent?.fixture?.skill), "agent.fixture.skill steps required for fixture runner");
  }
  need(spec.agent?.runner === "claude-code" || spec.agent?.runner === "fixture", "agent.runner must be 'claude-code' or 'fixture'");
  need(typeof spec.limits?.timeoutMsPerRun === "number" && spec.limits.timeoutMsPerRun > 0, "limits.timeoutMsPerRun must be a positive number");
  need(typeof spec.limits?.repetitions === "number" && spec.limits.repetitions >= 1 && spec.limits.repetitions <= 5, "limits.repetitions must be 1..5");

  if (errors.length > 0) return { ok: false, errors, spec: null, baseDir };

  // Resolve directories relative to the spec file and check they exist.
  const full = spec as TaskSpec;
  const resolved: TaskSpec = {
    ...full,
    task: { ...full.task, workspaceCopyFrom: path.resolve(baseDir, full.task.workspaceCopyFrom) },
    verifier: { ...full.verifier, copyFrom: path.resolve(baseDir, full.verifier.copyFrom) },
    skill: full.skill ? { ...full.skill, path: path.resolve(baseDir, full.skill.path) } : undefined,
  };
  for (const [label, p] of [["task.workspaceCopyFrom", resolved.task.workspaceCopyFrom], ["verifier.copyFrom", resolved.verifier.copyFrom]] as const) {
    try { if (!(await stat(p)).isDirectory()) errors.push(`${label} is not a directory: ${p}`); }
    catch { errors.push(`${label} does not exist: ${p}`); }
  }
  if (resolved.skill) {
    try { if (!(await stat(path.join(resolved.skill.path, "SKILL.md"))).isFile()) errors.push("skill.path must contain SKILL.md"); }
    catch { errors.push(`skill.path does not exist or lacks SKILL.md: ${resolved.skill.path}`); }
  }
  return { ok: errors.length === 0, errors, spec: errors.length === 0 ? resolved : null, baseDir };
}
