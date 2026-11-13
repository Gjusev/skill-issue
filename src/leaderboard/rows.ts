/**
 * Leaderboard JSONL rows.
 *
 * One row per run (or per recorded refusal). This is the interchange format
 * between skill-issue and reliagate: reliagate's JSONL adapter reads
 * {task_id, attempt, success, version, metadata}; rows here carry the full
 * leaderboard context and are projected onto that schema per comparison.
 *
 * success semantics follow reliagate's convention:
 *   true  = verifier observed the success criterion
 *   false = agent finished, verifier did not pass it
 *   null  = abstained / infrastructure error / refused — counted in n,
 *           never silently counted as a failure.
 */
import { appendFile, readFile } from "node:fs/promises";
import type { RunRecord } from "../core/types.ts";

export interface LeaderboardRunRow {
  skill_id: string;
  skill_commit: string;
  task_id: string;
  variant: "baseline" | "skill";
  /** 0-based attempt index (reliagate convention). */
  attempt: number;
  success: boolean | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_estimate: number | null;
  wall_ms: number;
  verifier_hash: string;
  error?: string;
}

/** Reliagate JSONL trial projection (adapters/jsonl.py schema). */
export interface ReliagateTrial {
  task_id: string;
  attempt: number;
  success: boolean | null;
  version: string;
  metadata: Record<string, unknown>;
}

export function rowFromRecord(
  record: RunRecord,
  meta: { skillId: string; skillCommit: string; taskId: string },
): LeaderboardRunRow {
  const passed = record.status === "passed";
  const failed = record.status === "failed";
  const abstained = !passed && !failed;
  const error =
    abstained || !record.comparison.valid
      ? [record.endReason, ...record.comparison.reasons].filter(Boolean).join("; ") || record.status
      : undefined;
  return {
    skill_id: meta.skillId,
    skill_commit: meta.skillCommit,
    task_id: meta.taskId,
    variant: record.variantId,
    attempt: record.repetition - 1,
    success: record.comparison.valid && passed ? true : record.comparison.valid && failed ? false : null,
    tokens_in: record.metrics.tokensIn,
    tokens_out: record.metrics.tokensOut,
    cost_estimate: record.metrics.costUsd,
    wall_ms: record.metrics.durationMs,
    verifier_hash: record.hashes.verifierBefore,
    ...(error ? { error } : {}),
  };
}

export function refusalRow(
  meta: { skillId: string; skillCommit: string; taskId: string },
  attempt: number,
  reasons: string[],
): LeaderboardRunRow {
  return {
    skill_id: meta.skillId,
    skill_commit: meta.skillCommit,
    task_id: meta.taskId,
    variant: "skill",
    attempt,
    success: null,
    tokens_in: null,
    tokens_out: null,
    cost_estimate: null,
    wall_ms: 0,
    verifier_hash: "not-run",
    error: `refused by security gate: ${reasons.join("; ")}`,
  };
}

/** Stable resume key: one recorded outcome per skill x task x variant x attempt. */
export function rowKey(row: Pick<LeaderboardRunRow, "skill_id" | "task_id" | "variant" | "attempt">): string {
  return `${row.skill_id}|${row.task_id}|${row.variant}|${row.attempt}`;
}

const ROW_STRING_FIELDS = ["skill_id", "task_id"] as const;

/** Shape check for a parsed JSONL object; returns error messages. */
export function validateRow(obj: unknown): string[] {
  const errors: string[] = [];
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return ["row must be a JSON object"];
  const r = obj as Record<string, unknown>;
  for (const f of ROW_STRING_FIELDS) {
    if (typeof r[f] !== "string" || (r[f] as string).length === 0) errors.push(`${f} must be a non-empty string`);
  }
  if (r.variant !== "baseline" && r.variant !== "skill") errors.push("variant must be 'baseline' or 'skill'");
  if (!Number.isInteger(r.attempt) || (r.attempt as number) < 0) errors.push("attempt must be a non-negative integer");
  if (r.success !== true && r.success !== false && r.success !== null) {
    errors.push("success must be true, false or null (null = abstained/refused)");
  }
  for (const f of ["tokens_in", "tokens_out", "cost_estimate", "wall_ms"] as const) {
    const v = r[f];
    if (v !== null && v !== undefined && typeof v !== "number") errors.push(`${f} must be a number or null`);
  }
  if (typeof r.verifier_hash !== "string") errors.push("verifier_hash must be a string");
  if (r.error !== undefined && typeof r.error !== "string") errors.push("error must be a string when present");
  return errors;
}

/** Read rows from a JSONL file; a missing file is an empty history (not an error). */
export async function readRows(file: string): Promise<{ rows: LeaderboardRunRow[]; errors: string[] }> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return { rows: [], errors: [] };
  }
  const rows: LeaderboardRunRow[] = [];
  const errors: string[] = [];
  for (const [i, line] of raw.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    try {
      const obj: unknown = JSON.parse(line);
      const errs = validateRow(obj);
      if (errs.length > 0) errors.push(`${file}:${i + 1}: ${errs.join("; ")}`);
      else rows.push(obj as LeaderboardRunRow);
    } catch (e) {
      errors.push(`${file}:${i + 1}: not valid JSON: ${(e as Error).message}`);
    }
  }
  return { rows, errors };
}

/** Append rows as JSONL lines, creating the file (and dirs are caller's job). */
export async function appendRows(file: string, rows: LeaderboardRunRow[]): Promise<void> {
  if (rows.length === 0) return;
  const text = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await appendFile(file, text, "utf8");
}

/** Project a leaderboard row onto reliagate's JSONL trial schema. */
export function toReliagateTrial(row: LeaderboardRunRow): ReliagateTrial {
  return {
    task_id: row.task_id,
    attempt: row.attempt,
    success: row.success,
    version: row.variant === "skill" ? row.skill_commit : "baseline",
    metadata: {
      variant: row.variant,
      wall_ms: row.wall_ms,
      cost_estimate: row.cost_estimate,
      skill_id: row.skill_id,
    },
  };
}
