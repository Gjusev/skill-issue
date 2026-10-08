#!/usr/bin/env node
/**
 * Simulated agent used by the fixture runner. It speaks the same
 * stream-json dialect as `claude -p --output-format stream-json --verbose`,
 * so the engine exercises its REAL parsing/evidence path without a model.
 *
 * Usage: node fixture-agent.mjs <steps.json> <workspaceDir>
 * Steps are defined by TaskSpec.agent.fixture (see src/core/types.ts).
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";

const [stepsFile, workspaceDir] = process.argv.slice(2);
const steps = JSON.parse(await readFile(stepsFile, "utf8"));
const started = Date.now();

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const toolUse = (name, input) =>
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `tu_${Math.random().toString(36).slice(2, 8)}`, name, input }] } });
const toolResult = () => emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } });

emit({ type: "system", subtype: "init", session_id: "fixture", cwd: workspaceDir, model: "fixture-agent", skills: [] });

let metrics = null;
let exitCode = 0;
let sawAbort = false;
// Cancellation path: if the parent kills us we just die; no cleanup needed.

for (const step of steps) {
  if (sawAbort) break;
  switch (step.action) {
    case "sleep":
      await new Promise((r) => setTimeout(r, step.ms));
      break;
    case "writeFile": {
      toolUse("Write", { file_path: path.join(workspaceDir, step.path) });
      await writeFile(path.join(workspaceDir, step.path), step.content, "utf8");
      toolResult();
      break;
    }
    case "readSkill": {
      // Read the installed skill the same way a real agent would.
      const skillsDir = path.join(workspaceDir, ".claude", "skills");
      let entries = [];
      try { entries = await readdir(skillsDir); } catch { entries = []; }
      for (const name of entries) {
        const skillFile = path.join(skillsDir, name, "SKILL.md");
        try { await readFile(skillFile, "utf8"); toolUse("Read", { file_path: skillFile }); toolResult(); } catch { /* not installed */ }
      }
      break;
    }
    case "invokeSkill": {
      const skillsDir = path.join(workspaceDir, ".claude", "skills");
      let entries = [];
      try { entries = await readdir(skillsDir); } catch { entries = []; }
      for (const name of entries) { toolUse("Skill", { skill: name }); toolResult(); }
      break;
    }
    case "emit":
      process.stdout.write(step.line + "\n");
      break;
    case "metrics":
      metrics = step;
      break;
    case "exit":
      exitCode = step.code;
      sawAbort = true;
      break;
    default:
      throw new Error(`fixture-agent: unknown step ${JSON.stringify(step)}`);
  }
}

const result = {
  type: "result",
  subtype: exitCode === 0 ? "success" : "error_during_execution",
  is_error: exitCode !== 0,
  result: "fixture agent finished",
  duration_ms: Date.now() - started,
};
if (metrics) {
  result.num_turns = metrics.turns;
  result.total_cost_usd = metrics.costUsd;
  result.usage = { input_tokens: metrics.tokensIn, output_tokens: metrics.tokensOut };
}
emit(result);
process.exit(exitCode);
