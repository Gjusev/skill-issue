/**
 * Data contracts for Skill Issue.
 *
 * Two documents flow through the system:
 * - TaskSpec: what the user wants compared (input, written by hand or scaffolded).
 * - RunRecord: what actually happened in one variant execution (output, written
 *   only by the engine).
 *
 * Rules encoded here (see plan §5):
 * - Absent metrics are `null`, never 0 and never an estimate.
 * - Installation, observed-read and task outcome are separate claims.
 * - Infrastructure failures are distinct from task failures.
 */

export type VariantId = "baseline" | "skill";

/** Steps executed by the fixture runner (simulated agent). Never a real model. */
export type FixtureStep =
  | { action: "sleep"; ms: number }
  | { action: "writeFile"; path: string; content: string }
  /** Reads the installed skill's SKILL.md (only meaningful in the skill variant). */
  | { action: "readSkill" }
  /** Emits a Skill tool_use event naming the installed skill. */
  | { action: "invokeSkill" }
  /** Writes a raw line to stdout (used to simulate corrupt provider output). */
  | { action: "emit"; line: string }
  /** Makes the final result message carry provider metrics. */
  | { action: "metrics"; tokensIn: number; tokensOut: number; costUsd: number; turns: number }
  | { action: "exit"; code: number };

export interface TaskSpec {
  specVersion: 1;
  id: string;
  description?: string;
  task: {
    /** Exact prompt handed to the agent. Not shown back in sanitized exports. */
    prompt: string;
    /** Directory whose bytes form the initial workspace for every variant. */
    workspaceCopyFrom: string;
  };
  verifier: {
    /** Directory containing the verifier entry script. Copied by the engine
     *  outside the workspace before the agent runs; the copy is what executes. */
    copyFrom: string;
    /** Command argv run with cwd = verifier copy. `{workspace}` is replaced
     *  with the absolute workspace path in each argument. */
    command: string[];
    timeoutMs?: number;
    /** Human-readable observable success criterion (shown in the report). */
    successCriteria: string;
  };
  /** Skill under evaluation. Omitted => baseline-only run. */
  skill?: {
    name: string;
    /** Directory that contains SKILL.md. */
    path: string;
  };
  agent: {
    runner: "claude-code" | "fixture";
    model?: string;
    effort?: string;
    /** acceptEdits: default. bypass: task needs shell commands (trusted fixtures only). */
    permissions?: "acceptEdits" | "bypass";
    /** Required when runner === "fixture": scripted behaviour per variant. */
    fixture?: {
      baseline: FixtureStep[];
      skill: FixtureStep[];
    };
  };
  limits: {
    timeoutMsPerRun: number;
    /** Passed to the runner if it supports a budget flag. Not a hard guarantee. */
    maxBudgetUsd?: number;
    repetitions: number;
  };
}

export type RecordStatus =
  | "passed" // verifier observed the success criterion
  | "failed" // agent finished, verifier did not pass
  | "timeout" // killed by wall-clock limit
  | "cancelled" // killed by the user
  | "infrastructure_error" // runner/output broke; says nothing about the task
  | "invalid_comparison"; // comparability precondition violated

export type RunStatus = "completed" | "timeout" | "cancelled" | "error";

export interface SkillEvidenceItem {
  kind: "config-check" | "tool-use" | "file-read";
  detail: string;
}

export interface SkillEvidence {
  /** SKILL.md present in the workspace config the runner was given (engine-checked). */
  installed: boolean;
  /** Runner observed the skill being invoked/read. null = not instrumented. */
  observedRead: boolean | null;
  evidence: SkillEvidenceItem[];
}

export interface Metrics {
  /** Wall-clock measured by the engine. Always a number. */
  durationMs: number;
  /** Provider-reported fields. null = not measured, never 0-by-default. */
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  turns: number | null;
  /** Where the provider-reported fields came from, when present. */
  providerProvenance: string | null;
}

export interface FileChange {
  path: string;
  change: "created" | "modified" | "deleted";
}

export interface RunRecord {
  recordVersion: 1;
  experimentId: string;
  taskId: string;
  variantId: VariantId;
  repetition: number;
  workspaceId: string;
  requested: {
    runner: string;
    runnerVersion: string | null;
    model: string | null;
    effort: string | null;
    permissions: string;
    limits: TaskSpec["limits"];
  };
  /** What the run actually reported about itself, when it did. */
  observed: {
    model: string | null;
    /** Skill names visible to the session at init (audit of isolation), if reported. */
    skillsVisible: string[] | null;
  };
  hashes: {
    taskSpec: string;
    workspaceInitial: string;
    skill: string | null;
    verifierBefore: string;
    verifierAfter: string | null;
  };
  startedAt: string;
  endedAt: string;
  status: RecordStatus;
  endReason: string;
  run: {
    status: RunStatus;
    exitCode: number | null;
    timedOut: boolean;
    cancelled: boolean;
    /** Sanitized tail of runner stderr, for diagnosis. Often empty. */
    stderrTail: string;
  };
  skillEvidence: SkillEvidence;
  /** Sanitized event summary from the runner output stream. */
  events: Array<{ type: string; detail: string }>;
  output: {
    text: string | null;
    truncated: boolean;
  };
  verifier: {
    status: "passed" | "failed" | "error" | "not-run";
    exitCode: number | null;
    durationMs: number | null;
    stdout: string;
    stderr: string;
  };
  metrics: Metrics;
  changes: FileChange[];
  comparison: {
    valid: boolean;
    reasons: string[];
  };
}

export interface ExperimentReport {
  reportVersion: 1;
  experimentId: string;
  taskId: string;
  createdAt: string;
  specPath: string;
  specHash: string;
  description: string | null;
  successCriteria: string;
  skill: { name: string; hash: string } | null;
  agent: { runner: string; runnerVersion: string | null; model: string | null; effort: string | null };
  limits: TaskSpec["limits"];
  repetitions: number;
  records: RunRecord[];
  comparison: {
    valid: boolean;
    reasons: string[];
    note: string;
  };
}
