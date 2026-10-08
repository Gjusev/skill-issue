import type { ExperimentReport } from "./types.ts";
import { sanitizeText } from "./sanitize.ts";

/**
 * Build the shareable export of an experiment.
 * Default exclusions (plan §7): task prompt text, raw event traces, absolute
 * paths, environment details. Hashes and provenance are kept so the export
 * stays attributable. Nothing here contains credentials (records are already
 * sanitized at write time; this is a second line of defense).
 */
export interface ExportedReport {
  exportVersion: 1;
  experimentId: string;
  taskId: string;
  createdAt: string;
  description: string | null;
  successCriteria: string;
  skill: { name: string; hash: string } | null;
  agent: ExperimentReport["agent"];
  limits: ExperimentReport["limits"];
  repetitions: number;
  comparison: ExperimentReport["comparison"];
  promptHash: string | null;
  variants: Array<{
    variantId: string;
    repetition: number;
    status: string;
    endReason: string;
    skillEvidence: { installed: boolean; observedRead: boolean | null; evidenceCount: number };
    verifier: { status: string; exitCode: number | null };
    metrics: { durationMs: number; tokensIn: number | null; tokensOut: number | null; costUsd: number | null; turns: number | null };
    changeCount: number;
    changes: string[];
    comparison: { valid: boolean; reasons: string[] };
  }>;
}

export async function buildExport(report: ExperimentReport, promptText: string | null): Promise<ExportedReport> {
  const { createHash } = await import("node:crypto");
  return {
    exportVersion: 1,
    experimentId: report.experimentId,
    taskId: report.taskId,
    createdAt: report.createdAt,
    description: report.description ? sanitizeText(report.description) : null,
    successCriteria: sanitizeText(report.successCriteria),
    skill: report.skill,
    agent: report.agent,
    limits: report.limits,
    repetitions: report.repetitions,
    comparison: report.comparison,
    promptHash: promptText ? createHash("sha256").update(promptText).digest("hex") : null,
    variants: report.records.map((r) => ({
      variantId: r.variantId,
      repetition: r.repetition,
      status: r.status,
      endReason: sanitizeText(r.endReason),
      skillEvidence: {
        installed: r.skillEvidence.installed,
        observedRead: r.skillEvidence.observedRead,
        evidenceCount: r.skillEvidence.evidence.length,
      },
      verifier: { status: r.verifier.status, exitCode: r.verifier.exitCode },
      metrics: {
        durationMs: r.metrics.durationMs,
        tokensIn: r.metrics.tokensIn,
        tokensOut: r.metrics.tokensOut,
        costUsd: r.metrics.costUsd,
        turns: r.metrics.turns,
      },
      changeCount: r.changes.length,
      changes: r.changes.map((c) => `${c.change}: ${sanitizeText(c.path)}`),
      comparison: r.comparison,
    })),
  };
}
