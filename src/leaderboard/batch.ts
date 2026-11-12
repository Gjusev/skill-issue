/**
 * Batch mode: run every manifest task x {baseline, skill} x k repetitions
 * through the existing two-variant engine, writing one JSONL row per run.
 *
 * Guarantees inherited from the engine (src/core/engine.ts):
 *   - identical starting workspace bytes for both variants of a repetition;
 *   - per-run isolated workspace; external verifier hashed before/after;
 *   - infrastructure failures recorded as abstentions, never as task failures.
 *
 * Batch-specific guarantees:
 *   - Security gate BEFORE any install/run: skills are scanned
 *     (src/leaderboard/sandbox.ts); refusals are recorded as rows with
 *     reasons and the skill is never installed.
 *   - --resume: (skill, task, variant, attempt) keys already present in the
 *     results JSONL are skipped.
 *   - --max-runs: a hard upper bound on agent runs STARTED by this invocation;
 *     an experiment that would exceed the cap is not started (no truncation,
 *     so comparisons stay complete).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadManifest, jsonlTaskId, type LeaderboardManifest, type ManifestSkill, type ManifestTask } from "./manifest.ts";
import { scanSkillDir } from "./sandbox.ts";
import { appendRows, readRows, refusalRow, rowFromRecord, rowKey } from "./rows.ts";
import { runExperiment } from "../core/engine.ts";
import { createFixtureRunner } from "../runners/fixture.ts";
import { createClaudeCodeRunner } from "../runners/claude-code.ts";
import type { TaskSpec } from "../core/types.ts";
import type { RunnerAdapter } from "../runners/types.ts";

export interface BatchOptions {
  manifestPath: string;
  /** Override manifest k (1..5). */
  k?: number;
  /** Override manifest harness. */
  harness?: "claude-code" | "fixture";
  /** Hard cap on agent runs started by this invocation. */
  maxRuns?: number;
  /** Skip (skill, task, variant, attempt) keys already recorded. Required when results exist. */
  resume?: boolean;
  /** Root directory for experiment artifacts (engine data-dir). */
  dataDir?: string;
  onProgress?: (message: string) => void;
}

export interface BatchSummary {
  rowsFile: string;
  k: number;
  harness: string;
  skillsAllowed: string[];
  skillsRefused: Array<{ id: string; reason: string }>;
  skillsExcluded: Array<{ id: string; reason: string }>;
  skillsWithoutSource: string[];
  runsExecuted: number;
  runsPlannedTotal: number;
  runsSkippedResume: number;
  refusalRowsWritten: number;
  maxRunsReached: boolean;
  experiments: string[];
}

function specIdFor(skill: ManifestSkill, task: ManifestTask): string {
  return `${skill.id}-${task.id}`;
}

function buildTaskSpec(manifest: LeaderboardManifest, skill: ManifestSkill, task: ManifestTask, baseDir: string, k: number): TaskSpec {
  const harness = manifest.harness;
  const spec: TaskSpec = {
    specVersion: 1,
    id: specIdFor(skill, task),
    description: task.title,
    task: {
      prompt: task.prompt ?? "",
      workspaceCopyFrom: path.resolve(baseDir, task.workspaceSeed ?? "."),
    },
    verifier: {
      copyFrom: path.resolve(baseDir, task.verifierDir ?? "."),
      command: task.verifierCommand ?? ["node", "verify.mjs"],
      timeoutMs: task.timeoutMsPerRun ?? 120_000,
      successCriteria: task.criterion,
    },
    skill: { name: skill.id, path: path.resolve(baseDir, skill.source ?? ".") },
    agent: harness === "fixture"
      ? { runner: "fixture" as const, fixture: (task.fixture ?? { baseline: [], skill: [] }) as TaskSpec["agent"]["fixture"] }
      : { runner: "claude-code" as const },
    limits: { timeoutMsPerRun: task.timeoutMsPerRun ?? 600_000, repetitions: k },
  };
  return spec;
}

export async function runBatch(opts: BatchOptions): Promise<BatchSummary> {
  const log = opts.onProgress ?? (() => {});
  const loaded = await loadManifest(opts.manifestPath);
  if (!loaded.ok || !loaded.manifest) {
    throw new Error(`invalid manifest:\n- ${loaded.errors.join("\n- ")}`);
  }
  const manifest = loaded.manifest;
  const baseDir = loaded.baseDir;
  const k = opts.k ?? manifest.k;
  if (!Number.isInteger(k) || k < 1 || k > 5) throw new Error(`--k must be an integer 1..5 (got ${k})`);
  if (opts.harness) manifest.harness = opts.harness;
  const dataDir = path.resolve(opts.dataDir ?? path.join(baseDir, "results", "experiments"));
  const rowsFile = path.resolve(baseDir, manifest.results);
  await mkdir(path.dirname(rowsFile), { recursive: true });
  await mkdir(dataDir, { recursive: true });

  // Resume: refuse to double-record. Without --resume an existing results
  // file would silently produce duplicate keys.
  const { rows: existing, errors: rowErrors } = await readRows(rowsFile);
  if (rowErrors.length > 0) throw new Error(`results file has invalid rows:\n- ${rowErrors.join("\n- ")}`);
  if (existing.length > 0 && !opts.resume) {
    throw new Error(`${rowsFile} already has ${existing.length} rows; pass --resume to skip recorded runs`);
  }
  const recorded = new Set(existing.map(rowKey));

  const runner: RunnerAdapter = manifest.harness === "fixture" ? createFixtureRunner() : createClaudeCodeRunner();
  if (manifest.harness !== "fixture") {
    const pre = await runner.preflight();
    if (!pre.ok) throw new Error(`runner preflight failed: ${pre.error}`);
    log(`runner: ${runner.capabilities.label} (${pre.version})`);
  }

  const summary: BatchSummary = {
    rowsFile,
    k,
    harness: manifest.harness,
    skillsAllowed: [],
    skillsRefused: [],
    skillsExcluded: [],
    skillsWithoutSource: [],
    runsExecuted: 0,
    runsPlannedTotal: 0,
    runsSkippedResume: 0,
    refusalRowsWritten: 0,
    maxRunsReached: false,
    experiments: [],
  };

  const budgetLeft = () => (opts.maxRuns === undefined ? Number.POSITIVE_INFINITY : opts.maxRuns - summary.runsExecuted);

  // --- Phase 1: security gate every non-excluded skill BEFORE any run. ---
  // Refusals are recorded even when the budget later stops the batch, so the
  // results always explain what was refused and why.
  const admitted: Array<{ skill: ManifestSkill }> = [];
  for (const skill of manifest.skills) {
    if (skill.excluded) {
      summary.skillsExcluded.push({ id: skill.id, reason: skill.excludedReason ?? "excluded" });
      continue;
    }
    if (!skill.source) {
      const reason =
        `skill source not available: expected a local checkout of ${skill.repo} at pinned commit ${skill.commit.slice(0, 8)} (set skill.source in the manifest)`;
      const refusalRows = skill.tasks.flatMap((t) =>
        Array.from({ length: k }, (_, i) => refusalRow({ skillId: skill.id, skillCommit: skill.commit, taskId: jsonlTaskId(skill.id, t.id) }, i, [reason])),
      );
      const fresh = refusalRows.filter((r) => !recorded.has(rowKey(r)));
      await appendRows(rowsFile, fresh);
      summary.refusalRowsWritten += fresh.length;
      summary.skillsWithoutSource.push(skill.id);
      log(`skip ${skill.id}: ${reason}`);
      continue;
    }
    const scan = await scanSkillDir(path.resolve(baseDir, skill.source));
    if (scan.verdict === "refuse") {
      const shortReasons = scan.reasons.slice(0, 5).join("; ") + (scan.reasons.length > 5 ? `; +${scan.reasons.length - 5} more` : "");
      const refusalRows = skill.tasks.flatMap((t) =>
        Array.from({ length: k }, (_, i) =>
          refusalRow({ skillId: skill.id, skillCommit: skill.commit, taskId: jsonlTaskId(skill.id, t.id) }, i, scan.reasons),
        ),
      );
      const fresh = refusalRows.filter((r) => !recorded.has(rowKey(r)));
      await appendRows(rowsFile, fresh);
      summary.refusalRowsWritten += fresh.length;
      summary.skillsRefused.push({ id: skill.id, reason: shortReasons });
      log(`REFUSED ${skill.id}: ${shortReasons}`);
      continue;
    }
    summary.skillsAllowed.push(skill.id);
    log(`allowed ${skill.id} (${scan.filesScanned} files scanned)`);
    admitted.push({ skill });
  }

  // --- Phase 2: run admitted skills' implemented tasks within the budget. ---
  for (const { skill } of admitted) {
    for (const task of skill.tasks) {
      const taskId = jsonlTaskId(skill.id, task.id);
      if (task.status !== "implemented") {
        log(`skip ${taskId}: task is 'designed' only (no workspace seed/verifier yet)`);
        continue;
      }
      // Planned agent runs for one experiment: k repetitions x 2 variants.
      const planned = k * 2;
      const pending = Array.from({ length: k }, (_, i) => i)
        .flatMap((attempt) => (["baseline", "skill"] as const).map((variant) => rowKey({ skill_id: skill.id, task_id: taskId, variant, attempt })))
        .filter((key) => opts.resume && recorded.has(key)).length;
      const todoRuns = planned - pending;
      summary.runsPlannedTotal += todoRuns;
      if (todoRuns === 0) {
        summary.runsSkippedResume += 0; // everything already recorded
        log(`skip ${taskId}: all ${planned} runs already recorded (--resume)`);
        continue;
      }
      if (todoRuns > budgetLeft()) {
        summary.maxRunsReached = true;
        log(`stop: --max-runs ${opts.maxRuns} would be exceeded by ${taskId} (needs ${todoRuns} more, ${budgetLeft()} left)`);
        return summary;
      }

      const spec = buildTaskSpec(manifest, skill, task, baseDir, k);
      const specsDir = path.join(dataDir, "specs");
      await mkdir(specsDir, { recursive: true });
      const specPath = path.join(specsDir, `${spec.id}.json`);
      await writeFile(specPath, JSON.stringify(spec, null, 2), "utf8");

      log(`run ${taskId}: ${k} reps x {baseline, skill} via ${manifest.harness}`);
      const report = await runExperiment(specPath, runner, {
        dataDir,
        repetitions: k,
        onRunStart: (variant, repetition) => log(`  -> ${taskId} ${variant} r${repetition}`),
      });
      summary.experiments.push(report.experimentId);
      summary.runsExecuted += report.records.length;
      const newRows = report.records.map((r) => rowFromRecord(r, { skillId: skill.id, skillCommit: skill.commit, taskId }));
      const freshRows = newRows.filter((r) => !recorded.has(rowKey(r)));
      for (const r of freshRows) recorded.add(rowKey(r));
      await appendRows(rowsFile, freshRows);
    }
  }

  return summary;
}
