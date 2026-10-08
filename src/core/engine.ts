import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashFile, hashTree, diffTrees, snapshotTree } from "./hash.ts";
import { loadSpec } from "./spec.ts";
import { prepareWorkspace, SKILL_INSTALL_DIR } from "./workspace.ts";
import { sanitizeText, truncate } from "./sanitize.ts";
import type { ExperimentReport, FileChange, RecordStatus, RunRecord, SkillEvidence, TaskSpec, VariantId } from "./types.ts";
import type { RunnerAdapter, RawRun } from "../runners/types.ts";
import { parseStream } from "../runners/parse.ts";
import { spawnCapturing } from "../runners/spawn.ts";

export interface RunOptions {
  dataDir: string;
  repetitions?: number;
  signal?: AbortSignal;
  /** Test hook: called before each run for progress/lifecycle. */
  onRunStart?: (variant: VariantId, repetition: number) => void;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const rand = Math.random().toString(36).slice(2, 6);
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rand}`;
}

export function statusFromRun(
  runStatus: "completed" | "timeout" | "cancelled" | "error",
  verifierStatus: "passed" | "failed" | "error" | "not-run",
): RecordStatus {
  if (runStatus === "timeout") return "timeout";
  if (runStatus === "cancelled") return "cancelled";
  if (runStatus === "error") return "infrastructure_error";
  if (verifierStatus === "passed") return "passed";
  if (verifierStatus === "failed") return "failed";
  return "infrastructure_error"; // verifier crashed: infrastructure, not task failure
}

/** Run the verifier copy (outside the agent workspace) against a workspace. */
export async function runVerifier(
  verifierDir: string,
  command: string[],
  workspaceDir: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RunRecord["verifier"]> {
  const args = command.slice(1).map((a) => a.replaceAll("{workspace}", workspaceDir));
  const res = await spawnCapturing({
    cmd: command[0] ?? "",
    args,
    cwd: verifierDir,
    env: { ...process.env, SKILL_ISSUE_WORKSPACE: workspaceDir },
    timeoutMs,
    signal,
    maxBufferChars: 100_000,
  });
  let status: RunRecord["verifier"]["status"] = res.exitCode === 0 ? "passed" : "failed";
  if (res.error || res.exitCode === null) status = "error";
  if (res.timedOut) status = "error";
  return {
    status,
    exitCode: res.exitCode,
    durationMs: null,
    stdout: truncate(sanitizeText(res.stdout, [workspaceDir]), 4000).text,
    stderr: truncate(sanitizeText(res.stderr, [workspaceDir]), 4000).text,
  };
}

async function fileExists(p: string): Promise<boolean> {
  try { return (await stat(p)).isFile(); } catch { return false; }
}

/** Prepare workspaces and report what WOULD run. Never spawns an agent. */
export async function prepareDryRun(specPath: string, opts: RunOptions): Promise<{ spec: TaskSpec; experimentDir: string; plan: string[] }> {
  const loaded = await loadSpec(specPath);
  if (!loaded.ok || !loaded.spec) throw new Error(`invalid spec:\n- ${loaded.errors.join("\n- ")}`);
  const spec = loaded.spec;
  const experimentDir = path.join(path.resolve(opts.dataDir), "experiments", `${spec.id}-${stamp()}`);
  const plan: string[] = [];
  const reps = opts.repetitions ?? spec.limits.repetitions;
  for (let r = 1; r <= reps; r++) {
    const order: VariantId[] = r % 2 === 1 ? ["baseline", "skill"] : ["skill", "baseline"];
    plan.push(`repetition ${r}: ${order.join(" -> ")}`);
  }
  return { spec, experimentDir, plan };
}

export async function runExperiment(
  specPath: string,
  runner: RunnerAdapter,
  opts: RunOptions,
): Promise<ExperimentReport> {
  const dataDir = path.resolve(opts.dataDir);
  const loaded = await loadSpec(specPath);
  if (!loaded.ok || !loaded.spec) throw new Error(`invalid spec:\n- ${loaded.errors.join("\n- ")}`);
  const spec = loaded.spec;
  const preflight = await runner.preflight();
  const experimentId = `${spec.id}-${stamp()}`;
  const experimentDir = path.join(dataDir, "experiments", experimentId);
  await mkdir(experimentDir, { recursive: true });

  const specHash = await hashFile(specPath).catch(() => "unavailable");

  // Verifier copy lives OUTSIDE any workspace and is hashed before/after.
  const verifierDir = path.join(experimentDir, "verifier");
  await cp(spec.verifier.copyFrom, verifierDir, { recursive: true });
  const verifierBefore = await hashTree(verifierDir);

  const skillHash = spec.skill ? await hashTree(spec.skill.path) : null;
  const runnerVersion = preflight.version;

  const reps = opts.repetitions ?? spec.limits.repetitions;
  const records: RunRecord[] = [];

  for (let r = 1; r <= reps; r++) {
    const order: VariantId[] = r % 2 === 1 ? ["baseline", "skill"] : ["skill", "baseline"];
    for (const variantId of order) {
      if (opts.signal?.aborted) break;
      opts.onRunStart?.(variantId, r);
      records.push(
        await runVariant({ spec, specPath, specHash, runner, runnerVersion, experimentId, experimentDir, verifierDir, verifierBefore, skillHash, variantId, repetition: r, opts }),
      );
    }
  }

  // Cross-variant comparability (same repetition).
  finalizeComparison(records, runner.capabilities);

  const report: ExperimentReport = {
    reportVersion: 1,
    experimentId,
    taskId: spec.id,
    createdAt: new Date().toISOString(),
    specPath: sanitizeText(path.resolve(specPath)),
    specHash,
    description: spec.description ?? null,
    successCriteria: spec.verifier.successCriteria,
    skill: spec.skill ? { name: spec.skill.name, hash: skillHash ?? "unavailable" } : null,
    agent: { runner: runner.id, runnerVersion, model: spec.agent.model ?? null, effort: spec.agent.effort ?? null },
    limits: spec.limits,
    repetitions: reps,
    records,
    comparison: {
      valid: records.every((x) => x.comparison.valid),
      reasons: dedupe(records.flatMap((x) => x.comparison.reasons)),
      note:
        reps < 3
          ? `Descriptive comparison with ${reps} repetition(s): insufficient evidence for superiority claims.`
          : "Descriptive comparison across repetitions; no statistical claim is made.",
    },
  };
  await writeFile(path.join(experimentDir, "experiment.json"), JSON.stringify(report, null, 2), "utf8");
  return report;
}

async function runVariant(ctx: {
  spec: TaskSpec; specPath: string; specHash: string;
  runner: RunnerAdapter; runnerVersion: string | null;
  experimentId: string; experimentDir: string;
  verifierDir: string; verifierBefore: string; skillHash: string | null;
  variantId: VariantId; repetition: number; opts: RunOptions;
}): Promise<RunRecord> {
  const { spec, runner, variantId, repetition, opts } = ctx;
  const variantSlug = `${variantId}-r${repetition}`;
  const workspaceDir = path.join(ctx.experimentDir, "variants", variantSlug, "workspace");

  const prepared = await prepareWorkspace(spec.task.workspaceCopyFrom, workspaceDir, {
    skill: variantId === "skill" && spec.skill ? spec.skill : undefined,
  });
  const beforeSnap = await snapshotTree(workspaceDir, [SKILL_INSTALL_DIR]);

  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  let raw: RawRun;
  try {
    raw = await runner.run({
      workspaceDir,
      experimentDir: ctx.experimentDir,
      variantId,
      repetition,
      spec,
      limits: spec.limits,
      signal: opts.signal,
    });
  } catch (e) {
    raw = {
      cmdDisplay: "(runner failed to start)",
      exitCode: null, timedOut: false, cancelled: false,
      error: (e as Error).message, stdout: "", stderr: String((e as Error).stack ?? ""),
      isolation: { configDirIsolated: false, authSource: null, note: "runner threw before spawning" },
    };
  }
  const durationMs = Math.round(performance.now() - t0);
  const endedAt = new Date().toISOString();

  const parsed = parseStream(raw.stdout, spec.skill?.name ?? null, [workspaceDir, ctx.experimentDir]);

  let runStatus: "completed" | "timeout" | "cancelled" | "error";
  if (raw.timedOut) runStatus = "timeout";
  else if (raw.cancelled) runStatus = "cancelled";
  else if (raw.error) runStatus = "error";
  else if (parsed.is_error) runStatus = "error";
  else if (parsed.corruptLines > 0) runStatus = "error"; // corrupt stream is never blessed as success
  else if (raw.exitCode !== 0 && parsed.resultText === null) runStatus = "error";
  else runStatus = "completed";

  // Verifier: only meaningful when the agent run itself completed.
  let verifier: RunRecord["verifier"] = { status: "not-run", exitCode: null, durationMs: null, stdout: "", stderr: "" };
  if (runStatus === "completed") {
    verifier = await runVerifier(ctx.verifierDir, spec.verifier.command, workspaceDir, spec.verifier.timeoutMs ?? 60_000, opts.signal);
  }

  const verifierAfter = await hashTree(ctx.verifierDir);
  const seededReasons: string[] = [];
  if (verifierAfter !== ctx.verifierBefore) {
    seededReasons.push("verifier files were modified during the run; its result cannot be trusted");
    verifier = { ...verifier, status: "error", stderr: (verifier.stderr + "\n[engine] verifier files changed during the run").trim() };
  }

  const status = statusFromRun(runStatus, verifier.status);

  const afterSnap = await snapshotTree(workspaceDir, [SKILL_INSTALL_DIR]);
  const changes: FileChange[] = diffTrees(beforeSnap, afterSnap);

  const installed = variantId === "skill" && !!spec.skill
    ? await fileExists(path.join(workspaceDir, SKILL_INSTALL_DIR, "skills", spec.skill.name, "SKILL.md"))
    : false;
  const evidence: SkillEvidence = {
    installed,
    observedRead: parsed.skillToolUses + parsed.skillFileReads > 0,
    evidence: [
      ...(installed ? [{ kind: "config-check" as const, detail: "SKILL.md present in the workspace config given to the runner" }] : []),
      ...(parsed.skillToolUses > 0 ? [{ kind: "tool-use" as const, detail: `Skill tool_use event observed (${parsed.skillToolUses}x)` }] : []),
      ...(parsed.skillFileReads > 0 ? [{ kind: "file-read" as const, detail: `Read/Edit tool_use on skill files observed (${parsed.skillFileReads}x)` }] : []),
    ],
  };

  const endReason =
    runStatus === "timeout" ? `wall-clock limit of ${spec.limits.timeoutMsPerRun}ms exceeded; process tree killed`
    : runStatus === "cancelled" ? "cancelled by user; process tree killed"
    : runStatus === "error" ? (raw.error ?? (parsed.is_error ? "provider reported is_error" : parsed.corruptLines > 0 ? `corrupt output stream (${parsed.corruptLines} unparseable lines)` : `agent exited with code ${raw.exitCode}`))
    : verifier.status === "passed" ? "agent completed; verifier observed the success criterion"
    : verifier.status === "failed" ? "agent completed; verifier did not observe the success criterion"
    : "agent completed; verifier could not run";

  const providerAny = parsed.providerMetrics.tokensIn ?? parsed.providerMetrics.tokensOut ?? parsed.providerMetrics.costUsd ?? parsed.providerMetrics.turns;

  return {
    recordVersion: 1,
    experimentId: ctx.experimentId,
    taskId: spec.id,
    variantId,
    repetition,
    workspaceId: variantSlug,
    requested: {
      runner: runner.id,
      runnerVersion: ctx.runnerVersion,
      model: spec.agent.model ?? null,
      effort: spec.agent.effort ?? null,
      permissions: spec.agent.permissions ?? "acceptEdits",
      limits: spec.limits,
    },
    hashes: {
      taskSpec: ctx.specHash,
      workspaceInitial: prepared.initialHashExclSkill,
      skill: ctx.skillHash,
      verifierBefore: ctx.verifierBefore,
      verifierAfter,
    },
    startedAt,
    endedAt,
    status,
    endReason,
    run: { status: runStatus, exitCode: raw.exitCode, timedOut: raw.timedOut, cancelled: raw.cancelled, stderrTail: truncate(sanitizeText(raw.stderr ?? "", [workspaceDir, ctx.experimentDir]), 1000).text },
    skillEvidence: evidence,
    events: parsed.events.slice(0, 200),
    output: raw.error
      ? { text: null, truncated: false }
      : { ...truncate(sanitizeText(parsed.resultText ?? "", [workspaceDir, ctx.experimentDir]), 4000) },
    verifier,
    metrics: {
      durationMs,
      tokensIn: parsed.providerMetrics.tokensIn,
      tokensOut: parsed.providerMetrics.tokensOut,
      costUsd: parsed.providerMetrics.costUsd,
      turns: parsed.providerMetrics.turns,
      providerProvenance: providerAny != null ? "runner stream-json result message" : null,
    },
    changes,
    comparison: { valid: seededReasons.length === 0, reasons: seededReasons }, // finalized by finalizeComparison
  };
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

/**
 * Decide, per record, whether the baseline/skill comparison is admissible.
 * Pure: takes the recorded evidence and mutates status accordingly.
 * A record whose comparison is invalid is NEVER reported as passed/failed.
 */
export function finalizeComparison(
  records: RunRecord[],
  capabilities: { isolateGlobalConfig: boolean },
): void {
  const reps = new Set(records.map((x) => x.repetition));
  for (const r of reps) {
    const base = records.find((x) => x.variantId === "baseline" && x.repetition === r);
    const skill = records.find((x) => x.variantId === "skill" && x.repetition === r);
    for (const rec of [base, skill]) {
      if (!rec) continue;
      const reasons = [...rec.comparison.reasons];
      if (base && skill && base.hashes.workspaceInitial !== skill.hashes.workspaceInitial) {
        reasons.push("initial workspace bytes differ between variants (beyond the skill install)");
      }
      if (base && skill) {
        const cfgA = { ...base.requested, limits: undefined };
        const cfgB = { ...skill.requested, limits: undefined };
        if (JSON.stringify(cfgA) !== JSON.stringify(cfgB)) {
          reasons.push("requested agent configuration differs between variants beyond the skill");
        }
      }
      if (!capabilities.isolateGlobalConfig) {
        reasons.push("runner cannot isolate global configuration; comparison is contaminated by design");
      }
      rec.comparison = { valid: reasons.length === 0, reasons: dedupe(reasons) };
      if (!rec.comparison.valid) rec.status = "invalid_comparison";
    }
  }
}

export async function readExperiment(experimentDir: string): Promise<ExperimentReport> {
  const raw = await readFile(path.join(experimentDir, "experiment.json"), "utf8");
  return JSON.parse(raw) as ExperimentReport;
}
