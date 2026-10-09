#!/usr/bin/env node
/**
 * skill-issue — local harness that runs the same task with and without a skill.
 *
 * Commands:
 *   validate <spec.json>            check a TaskSpec without running anything
 *   prepare <spec.json>             show the execution plan; prepares nothing, runs nothing
 *   run <spec.json>                 RUN the experiment (explicit model-consuming action)
 *   report <experimentDir>          print a text summary of an experiment
 *   export <experimentDir>          write the sanitized shareable export
 *   viewer [--data-dir] [--port]    serve the local web viewer
 */
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadSpec } from "./core/spec.ts";
import { prepareDryRun, runExperiment, readExperiment } from "./core/engine.ts";
import { buildExport } from "./core/export.ts";
import { createFixtureRunner } from "./runners/fixture.ts";
import { createClaudeCodeRunner } from "./runners/claude-code.ts";
import { startViewer } from "./report/server.ts";

function usage(exit = 0): never {
  console.log(`skill-issue — compare a task with and without a skill

  node src/cli.ts init [dir]                 scaffold a working comparison (fixture runner, no model)
  node src/cli.ts validate <spec.json> [--data-dir runs]
  node src/cli.ts prepare <spec.json> [--data-dir runs]
  node src/cli.ts run <spec.json> [--data-dir runs] [--repetitions N]
  node src/cli.ts report <experimentDir>
  node src/cli.ts export <experimentDir> [-o out.json]
  node src/cli.ts viewer [--data-dir runs] [--port 4173]

validate/prepare/viewer/init never invoke a model. run does, when the spec's
runner is a real agent; fixture specs run a simulated agent.
Node.js >= 22.18 required (runs the TypeScript source natively).`);
  process.exit(exit);
}

const SCAFFOLD_VERIFIER = `/** Verifier: exit 0 only when the success criterion holds.
 *  It runs OUTSIDE the agent's workspace; SKILL_ISSUE_WORKSPACE points at it.
 *  Replace this check with your own observable criterion. */
import { readFile } from "node:fs/promises";
import path from "node:path";

const ws = process.env.SKILL_ISSUE_WORKSPACE;
try {
  const text = await readFile(path.join(ws, "out.txt"), "utf8");
  if (text.trim().length > 0) {
    console.log("out.txt exists and is non-empty");
    process.exit(0);
  }
  console.error("out.txt is empty");
  process.exit(1);
} catch {
  console.error("out.txt was not created");
  process.exit(1);
}
`;

const SCAFFOLD_SKILL = `---
name: scaffold-skill
description: Describe when this skill should apply. Replace this placeholder skill with the one you want to compare.
---

# Scaffold skill

Replace this content with the real skill under test. The comparison installs
this directory into the skill variant's workspace, so keep it self-contained.
`;

async function cmdInit(target: string): Promise<void> {
  const dir = path.resolve(target);
  try {
    await mkdir(dir, { recursive: false });
  } catch (e) {
    console.error(`cannot create ${dir}: ${(e as Error).message} (does it already exist?)`);
    process.exit(1);
  }
  const spec = {
    specVersion: 1,
    id: path.basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "my-comparison",
    description: "Scaffolded comparison. Edit the prompt, the verifier criterion and the skill, then run.",
    task: {
      prompt: "Read notes.md and create out.txt with a one-line summary.",
      workspaceCopyFrom: "./workspace",
    },
    verifier: {
      copyFrom: "./verifier",
      command: ["node", "verify.mjs"],
      timeoutMs: 20000,
      successCriteria: "out.txt exists and is non-empty",
    },
    skill: { name: "scaffold-skill", path: "./skill" },
    agent: {
      // Fixture runner: try the whole flow without a model. Switch to
      // "claude-code" (and delete agent.fixture) when the task is ready.
      runner: "fixture",
      fixture: {
        baseline: [],
        skill: [
          { action: "invokeSkill" },
          { action: "readSkill" },
          { action: "writeFile", path: "out.txt", content: "summary written after reading the skill\n" },
        ],
      },
    },
    limits: { timeoutMsPerRun: 30000, repetitions: 1 },
  };
  await mkdir(path.join(dir, "workspace"), { recursive: true });
  await mkdir(path.join(dir, "verifier"), { recursive: true });
  await mkdir(path.join(dir, "skill"), { recursive: true });
  await writeFile(path.join(dir, "workspace", "notes.md"), "# Starter notes\n\n- Replace these notes with your task's real input.\n- The agent will be asked to summarize them into out.txt.\n", "utf8");
  await writeFile(path.join(dir, "verifier", "verify.mjs"), SCAFFOLD_VERIFIER, "utf8");
  await writeFile(path.join(dir, "skill", "SKILL.md"), SCAFFOLD_SKILL, "utf8");
  await writeFile(path.join(dir, "task.json"), JSON.stringify(spec, null, 2) + "\n", "utf8");
  console.log(`scaffolded: ${dir}`);
  console.log(`
next steps:
  1. edit ${path.join(dir, "task.json")} — the prompt and the success criterion
  2. put the skill under test into ${path.join(dir, "skill")}
  3. make the verifier check your real criterion (${path.join(dir, "verifier", "verify.mjs")})
  4. preview without cost:  node src/cli.ts validate ${path.join(dir, "task.json")}
                            node src/cli.ts prepare ${path.join(dir, "task.json")}
  5. run it:                node src/cli.ts run ${path.join(dir, "task.json")}
  6. switch agent.runner to "claude-code" (remove agent.fixture) for a real comparison`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version);
    process.exit(0);
  }
  if (!cmd) usage(1);

  const positionals = () =>
    parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        "data-dir": { type: "string", default: "runs" },
        repetitions: { type: "string" },
        port: { type: "string", default: "4173" },
        o: { type: "string" },
      },
    });

  switch (cmd) {
    case "init": {
      const args = positionals();
      await cmdInit(args.positionals[0] ?? "my-comparison");
      break;
    }
    case "validate": {
      const args = positionals();
      const specPath = args.positionals[0];
      if (!specPath) usage(1);
      const res = await loadSpec(specPath);
      if (res.ok) {
        console.log(`OK  ${specPath}`);
        console.log(`    task: ${res.spec?.id} | runner: ${res.spec?.agent.runner} | skill: ${res.spec?.skill?.name ?? "(none)"}`);
      } else {
        console.error(`INVALID  ${specPath}`);
        for (const e of res.errors) console.error(`  - ${e}`);
        process.exit(1);
      }
      break;
    }
    case "prepare": {
      const args = positionals();
      const specPath = args.positionals[0];
      if (!specPath) usage(1);
      const plan = await prepareDryRun(specPath, { dataDir: args.values["data-dir"] ?? "runs" });
      console.log(`plan for task '${plan.spec.id}' (nothing executed, no model invoked)`);
      console.log(`  runner:  ${plan.spec.agent.runner}`);
      console.log(`  skill:   ${plan.spec.skill?.name ?? "(none — baseline only)"}`);
      console.log(`  limits:  timeout ${plan.spec.limits.timeoutMsPerRun}ms/run, repetitions ${plan.spec.limits.repetitions}${plan.spec.limits.maxBudgetUsd ? `, budget flag $${plan.spec.limits.maxBudgetUsd}` : ""}`);
      for (const line of plan.plan) console.log(`  ${line}`);
      break;
    }
    case "run": {
      const args = positionals();
      const specPath = args.positionals[0];
      if (!specPath) usage(1);
      const dataDir = args.values["data-dir"] ?? "runs";
      const loaded = await loadSpec(specPath);
      if (!loaded.ok || !loaded.spec) {
        console.error(`invalid spec:\n- ${loaded.errors.join("\n- ")}`);
        process.exit(1);
      }
      const runner = loaded.spec.agent.runner === "fixture" ? createFixtureRunner() : createClaudeCodeRunner();
      const pre = await runner.preflight();
      if (!pre.ok) {
        console.error(`runner preflight failed: ${pre.error}`);
        process.exit(1);
      }
      console.log(`runner: ${runner.capabilities.label} (${pre.version})`);
      const reps = args.values.repetitions ? Number(args.values.repetitions) : undefined;
      if (reps !== undefined && (!Number.isInteger(reps) || reps < 1 || reps > 5)) {
        console.error("--repetitions must be an integer between 1 and 5");
        process.exit(1);
      }
      const controller = new AbortController();
      const onSig = () => { console.error("\ncancelling…"); controller.abort(); };
      process.on("SIGINT", onSig);
      process.on("SIGTERM", onSig);
      const report = await runExperiment(specPath, runner, {
        dataDir,
        repetitions: reps,
        signal: controller.signal,
        onRunStart: (variant, repetition) => console.log(`→ ${variant} (repetition ${repetition})`),
      });
      process.off("SIGINT", onSig);
      process.off("SIGTERM", onSig);
      printSummary(report);
      console.log(`\nexperiment dir: ${report.experimentId}`);
      console.log(`open with:      node src/cli.ts viewer --data-dir ${dataDir}`);
      break;
    }
    case "report": {
      const args = positionals();
      const dir = args.positionals[0];
      if (!dir) usage(1);
      const report = await readExperiment(dir).catch(() => {
        console.error(`no readable experiment at ${dir} (expected <dir>/experiment.json)`);
        process.exit(1);
      });
      printSummary(report);
      break;
    }
    case "export": {
      const args = positionals();
      const dir = args.positionals[0];
      if (!dir) usage(1);
      const report = await readExperiment(dir).catch(() => {
        console.error(`no readable experiment at ${dir} (expected <dir>/experiment.json)`);
        process.exit(1);
      });
      // The prompt lives in the spec, not in the report; hash it when resolvable.
      const specRes = await loadSpec(report.specPath).catch(() => null);
      const promptText = specRes?.spec?.task.prompt ?? null;
      const exported = await buildExport(report, promptText);
      const out = args.values.o ?? path.join(dir, "export.json");
      await writeFile(out, JSON.stringify(exported, null, 2), "utf8");
      console.log(`export written: ${out}`);
      console.log("excluded by default: prompt text, raw events, absolute paths");
      break;
    }
    case "viewer": {
      const args = positionals();
      const dataDir = args.values["data-dir"] ?? "runs";
      const port = Number(args.values.port ?? "4173");
      await mkdir(path.join(dataDir, "experiments"), { recursive: true });
      await startViewer({ dataDir, port });
      break;
    }
    default:
      usage(1);
  }
}

function printSummary(report: import("./core/types.ts").ExperimentReport) {
  console.log(`\nexperiment ${report.experimentId} — task '${report.taskId}'`);
  console.log(`success criterion: ${report.successCriteria}`);
  console.log(`skill: ${report.skill ? `${report.skill.name} (${report.skill.hash.slice(0, 8)})` : "(none)"}`);
  if (!report.comparison.valid) {
    console.log(`COMPARISON INVALID: ${report.comparison.reasons.join("; ")}`);
  }
  for (const r of report.records) {
    const m = r.metrics;
    const tok = m.tokensIn == null && m.tokensOut == null ? "tokens: not measured" : `tokens: ${m.tokensIn ?? "?"}in/${m.tokensOut ?? "?"}out`;
    console.log(
      `  [${r.variantId} r${r.repetition}] ${r.status.toUpperCase()}  ${m.durationMs}ms  ${tok}${m.costUsd != null ? `  $${m.costUsd}` : "  cost: not measured"}`,
    );
    console.log(`    activation: installed=${r.skillEvidence.installed} observedRead=${r.skillEvidence.observedRead}`);
    console.log(`    end: ${r.endReason}`);
  }
  console.log(`  ${report.comparison.note}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
