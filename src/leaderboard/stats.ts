/**
 * Statistics wiring: per-skill baseline-vs-skill paired comparison via the
 * reliagate CLI (subprocess), plus Wilson 95% CIs computed by reliagate's
 * Python library through a small subprocess call.
 *
 * Rule: NO statistics are reimplemented in TypeScript. If reliagate cannot be
 * invoked, the affected numbers degrade to null and the verdict becomes
 * "no data" -- never a locally invented p-value or interval.
 *
 * Invocation knobs (environment):
 *   SKILL_ISSUE_RELIGATE_CMD   full command used for `gate` (default
 *                              "python3 -m reliagate.cli")
 *   SKILL_ISSUE_RELIGATE_HOME  directory containing the reliagate package,
 *                              added to PYTHONPATH (default /root/reliagate)
 *   SKILL_ISSUE_PYTHON         python binary (default python3)
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { toReliagateTrial, type LeaderboardRunRow } from "./rows.ts";

export interface ReliagateOptions {
  gateCmd?: string;
  reliagateHome?: string;
  pythonBin?: string;
}

export function resolveReliagateOptions(opts: ReliagateOptions = {}): Required<ReliagateOptions> {
  return {
    gateCmd: opts.gateCmd ?? process.env.SKILL_ISSUE_RELIGATE_CMD ?? "python3 -m reliagate.cli",
    reliagateHome: opts.reliagateHome ?? process.env.SKILL_ISSUE_RELIGATE_HOME ?? "/root/reliagate",
    pythonBin: opts.pythonBin ?? process.env.SKILL_ISSUE_PYTHON ?? "python3",
  };
}

function runCapture(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 60_000): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (e: Error) => resolve({ exitCode: null, stdout, stderr, error: e.message }));
    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr, error: null }));
  });
}

function reliagateEnv(reliagateHome: string): NodeJS.ProcessEnv {
  const existing = process.env.PYTHONPATH ?? "";
  return { PYTHONPATH: existing ? `${reliagateHome}${path.delimiter}${existing}` : reliagateHome };
}

/** Tokenize a command string, honoring single/double quotes (paths may contain spaces). */
export function splitCommand(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i] as string;
    if (ch === "'" && !inDouble) { inSingle = !inSingle; hasToken = true; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; hasToken = true; continue; }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (hasToken || current.length > 0) tokens.push(current);
      current = "";
      hasToken = false;
      continue;
    }
    current += ch;
  }
  if (hasToken || current.length > 0) tokens.push(current);
  return tokens;
}

/** JSON produced by `reliagate gate --json` (reliagate/gate.py GateReport). */
export interface GateReportJson {
  decision: "pass" | "regression" | "error";
  exit_code: number;
  reason: string;
  base_pass_pow_n: number | null;
  new_pass_pow_n: number | null;
  max_regression: number | null;
  alpha: number | null;
  comparison: {
    b_gained: number;
    c_lost: number;
    b_minus_c: number;
    p_value: number;
    test_used: string;
    n_tasks: number;
    base_consistent: number;
    new_consistent: number;
  } | null;
  abstention: Record<string, { trials_abstained: number; trials_total: number }>;
}

export interface GateResult {
  report: GateReportJson | null;
  exitCode: number | null;
  error: string | null;
}

/** Invoke `reliagate gate --base X --new Y --json` as a subprocess. */
export async function runReliagateGate(
  baseFile: string,
  newFile: string,
  opts: ReliagateOptions = {},
): Promise<GateResult> {
  const cfg = resolveReliagateOptions(opts);
  const parts = splitCommand(cfg.gateCmd);
  const cmd = parts[0] ?? cfg.gateCmd;
  const args = [...parts.slice(1), "gate", "--base", baseFile, "--new", newFile, "--json"];
  const res = await runCapture(cmd, args, reliagateEnv(cfg.reliagateHome));
  // Exit codes: 0 pass, 2 regression, 3 infra/usage error (reliagate contract).
  if (res.exitCode === 3 || res.error !== null) {
    return { report: null, exitCode: res.exitCode, error: res.error ?? (res.stderr.trim() || "reliagate gate exited 3") };
  }
  const start = res.stdout.indexOf("{");
  if (start === -1) {
    return { report: null, exitCode: res.exitCode, error: `reliagate gate printed no JSON report: ${res.stderr.trim().slice(0, 300)}` };
  }
  try {
    const report = JSON.parse(res.stdout.slice(start)) as GateReportJson;
    return { report, exitCode: res.exitCode, error: null };
  } catch (e) {
    return { report: null, exitCode: res.exitCode, error: `unparseable gate report: ${(e as Error).message}` };
  }
}

/** Ask reliagate (python library, subprocess) for Wilson 95% CIs. */
export async function runWilsonCIs(
  pairs: Array<{ successes: number; total: number }>,
  opts: ReliagateOptions = {},
): Promise<Array<[number, number] | null>> {
  const cfg = resolveReliagateOptions(opts);
  const snippet =
    "import json,sys\n" +
    "from reliagate.metrics import wilson_ci\n" +
    "pairs = json.loads(sys.argv[1])\n" +
    "print(json.dumps([list(wilson_ci(int(p[0]), int(p[1]))) for p in pairs]))\n";
  const res = await runCapture(cfg.pythonBin, ["-c", snippet, JSON.stringify(pairs.map((p) => [p.successes, p.total]))], reliagateEnv(cfg.reliagateHome), 30_000);
  if (res.exitCode !== 0 || res.error !== null) return pairs.map(() => null);
  try {
    const parsed: unknown = JSON.parse(res.stdout.trim());
    if (!Array.isArray(parsed) || parsed.length !== pairs.length) return pairs.map(() => null);
    return parsed.map((p) => (Array.isArray(p) && p.length === 2 && typeof p[0] === "number" && typeof p[1] === "number" ? [p[0], p[1]] : null));
  } catch {
    return pairs.map(() => null);
  }
}

export type Verdict = "helps" | "no evidence" | "hurts" | "no data";

export interface SkillStat {
  skillId: string;
  commit: string;
  runs: number;
  tasksWithData: number;
  baseline: { successes: number; total: number; ci: [number, number] | null };
  skill: { successes: number; total: number; ci: [number, number] | null };
  b: number | null; // tasks gained consistent solvability
  c: number | null; // tasks lost it
  pValue: number | null;
  testUsed: string | null;
  gateDecision: string | null;
  verdict: Verdict;
  costDeltaUsd: number | null;
  error: string | null;
}

function tally(rows: LeaderboardRunRow[]): { successes: number; total: number; costSum: number | null; tasks: Set<string> } {
  let successes = 0;
  let costSum = 0;
  let sawCost = false;
  const tasks = new Set<string>();
  for (const r of rows) {
    if (r.success === true) successes++;
    tasks.add(r.task_id);
    if (typeof r.cost_estimate === "number") { costSum += r.cost_estimate; sawCost = true; }
  }
  return { successes, total: rows.length, costSum: sawCost ? costSum : null, tasks };
}

/**
 * Per-skill paired comparison: baseline variant vs skill variant, both rows
 * filtered to this skill, handed to the reliagate CLI as two JSONL files.
 *
 * Verdict contract: "helps" ONLY when the paired McNemar test (via reliagate)
 * is significant at alpha and the skill variant solves more. "hurts" is the
 * significant opposite. Anything else -- including a gate infra error -- is
 * "no evidence" or "no data", never an unsupported claim.
 */
export async function computeSkillStat(
  rows: LeaderboardRunRow[],
  skill: { id: string; commit: string },
  opts: ReliagateOptions = {},
): Promise<SkillStat> {
  const baseRows = rows.filter((r) => r.variant === "baseline");
  const skillRows = rows.filter((r) => r.variant === "skill");
  const baseTally = tally(baseRows);
  const skillTally = tally(skillRows);
  const stat: SkillStat = {
    skillId: skill.id,
    commit: skill.commit,
    runs: rows.length,
    tasksWithData: new Set([...baseTally.tasks, ...skillTally.tasks]).size,
    baseline: { successes: baseTally.successes, total: baseTally.total, ci: null },
    skill: { successes: skillTally.successes, total: skillTally.total, ci: null },
    b: null,
    c: null,
    pValue: null,
    testUsed: null,
    gateDecision: null,
    verdict: "no data",
    costDeltaUsd:
      baseTally.costSum !== null && skillTally.costSum !== null
        ? skillTally.costSum - baseTally.costSum
        : null,
    error: null,
  };
  if (baseRows.length === 0 || skillRows.length === 0) return stat;

  // Write the two reliagate JSONL projections to a temp dir.
  const tmp = await mkdtemp(path.join(tmpdir(), "reliagate-skill-issue-"));
  try {
    const baseFile = path.join(tmp, "base.jsonl");
    const newFile = path.join(tmp, "new.jsonl");
    await writeFile(baseFile, baseRows.map((r) => JSON.stringify(toReliagateTrial(r))).join("\n") + "\n", "utf8");
    await writeFile(newFile, skillRows.map((r) => JSON.stringify(toReliagateTrial(r))).join("\n") + "\n", "utf8");
    const gate = await runReliagateGate(baseFile, newFile, opts);
    if (gate.error !== null || gate.report === null) {
      stat.error = gate.error ?? "reliagate gate returned no report";
      stat.verdict = "no data";
    } else {
      stat.gateDecision = gate.report.decision;
      stat.b = gate.report.comparison?.b_gained ?? null;
      stat.c = gate.report.comparison?.c_lost ?? null;
      stat.pValue = gate.report.comparison?.p_value ?? null;
      stat.testUsed = gate.report.comparison?.test_used ?? null;
      const alpha = gate.report.alpha ?? 0.05;
      const significant = stat.pValue !== null && stat.pValue < alpha;
      const dir = (gate.report.new_pass_pow_n ?? 0) - (gate.report.base_pass_pow_n ?? 0);
      if (significant && dir > 0) stat.verdict = "helps";
      else if (significant && dir < 0) stat.verdict = "hurts";
      else stat.verdict = "no evidence";
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  // Wilson CIs come from reliagate's library; degrade to null if unavailable.
  const cis = await runWilsonCIs(
    [
      { successes: stat.baseline.successes, total: stat.baseline.total },
      { successes: stat.skill.successes, total: stat.skill.total },
    ],
    opts,
  );
  stat.baseline.ci = cis[0] ?? null;
  stat.skill.ci = cis[1] ?? null;
  return stat;
}
