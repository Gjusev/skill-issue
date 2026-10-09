import type { TaskSpec, VariantId } from "../core/types.ts";

export interface RunnerContext {
  workspaceDir: string;
  experimentDir: string;
  variantId: VariantId;
  repetition: number;
  spec: TaskSpec;
  limits: TaskSpec["limits"];
  /** External cancellation. */
  signal?: AbortSignal;
}

/** What a runner actually executed and captured. Raw material for the record. */
export interface RawRun {
  /** Sanitized command line recorded for transparency (never executed via shell). */
  cmdDisplay: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  error: string | null;
  stdout: string;
  stderr: string;
  /** A capture cap cut the stream; tail integrity unknown. */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** How global configuration was (or was not) kept out of the experiment. */
  isolation: {
    configDirIsolated: boolean;
    authSource: string | null;
    note: string;
  };
}

export interface RunnerCapabilities {
  /** Can the runner keep user-level skills/settings out of the run? */
  isolateGlobalConfig: boolean;
  /** Does the runner report token/cost metrics? */
  reportMetrics: boolean;
  label: string;
}

export interface RunnerAdapter {
  id: TaskSpec["agent"]["runner"];
  capabilities: RunnerCapabilities;
  preflight(): Promise<{ ok: boolean; version: string | null; error?: string }>;
  run(ctx: RunnerContext): Promise<RawRun>;
}
