import { copyFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { RunnerAdapter, RawRun, RunnerContext } from "./types.ts";
import { spawnCapturing } from "./spawn.ts";

/**
 * Claude Code runner. Isolation strategy (verified against CLI 2.1.x --help):
 * - CLAUDE_CONFIG_DIR points to a fresh empty dir per run => user skills,
 *   user settings, plugins and MCP config from the machine are NOT loaded.
 * - `--setting-sources project` => only the workspace's own settings load
 *   (and the workspace bytes are controlled by the engine).
 * - `--strict-mcp-config` with no --mcp-config => no MCP servers at all.
 * - The evaluated skill is installed at <workspace>/.claude/skills/<name>/.
 * - Auth is carried by copying the credentials file into the isolated config
 *   dir (existence check only; contents never read or logged).
 * Without the credentials file the run proceeds and will surface an auth
 * error honestly as infrastructure_error.
 */
/** Pure: the isolation/behaviour flags for a headless comparable run. */
export function buildClaudeArgs(spec: import("../core/types.ts").TaskSpec): string[] {
  const args: string[] = [
    "--output-format", "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--setting-sources", "project",
    "--permission-mode", spec.agent.permissions === "bypass" ? "bypassPermissions" : "acceptEdits",
    "--permission-prompts", "none",
  ];
  if (spec.agent.model) args.push("--model", spec.agent.model);
  if (spec.agent.effort) args.push("--effort", spec.agent.effort);
  if (typeof spec.limits.maxBudgetUsd === "number" && spec.limits.maxBudgetUsd > 0) {
    args.push("--max-budget-usd", String(spec.limits.maxBudgetUsd));
  }
  return args;
}

/** Pure: environment for an isolated run (user CLAUDE_* vars stripped). */
export function buildClaudeEnv(base: NodeJS.ProcessEnv, configDir: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const k of Object.keys(env)) if (k.startsWith("CLAUDE_")) delete env[k];
  env.CLAUDE_CONFIG_DIR = configDir;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return env;
}

export function createClaudeCodeRunner(opts: { claudePath?: string } = {}): RunnerAdapter {
  // Windows note: npm-installed Claude Code is a `claude.cmd` shim, which
  // spawn(shell:false) cannot resolve from PATH. The native installer's
  // claude.exe works directly. Allow an explicit path via option or env.
  const claudePath = opts.claudePath ?? process.env.SKILL_ISSUE_CLAUDE_PATH ?? "claude";
  return {
    id: "claude-code",
    capabilities: { isolateGlobalConfig: true, reportMetrics: true, label: "Claude Code CLI (headless -p)" },
    async preflight() {
      const res = await spawnCapturing({
        cmd: claudePath,
        args: ["--version"],
        cwd: process.cwd(),
        env: { ...process.env },
        timeoutMs: 15_000,
      });
      const version = res.stdout.trim() || null;
      if (res.error || version === null) {
        const hint = res.error?.includes("ENOENT") && process.platform === "win32"
          ? " (if Claude Code was installed via npm, its claude.cmd shim cannot be spawned without a shell — set SKILL_ISSUE_CLAUDE_PATH to the claude executable, or install the native build)"
          : "";
        return { ok: false, version, error: (res.error ?? "no version output") + hint };
      }
      return { ok: true, version };
    },
    async run(ctx: RunnerContext): Promise<RawRun> {
      const { spec, limits } = ctx;
      // Fresh, empty config dir per run: the isolation boundary.
      const configDir = path.join(ctx.experimentDir, "isolated-config", `${ctx.variantId}-r${ctx.repetition}`);
      await mkdir(configDir, { recursive: true });
      let authSource: string | null = null;
      const credSrc = path.join(homedir(), ".claude", ".credentials.json");
      try {
        await readFile(credSrc); // existence + readability check only
        await copyFile(credSrc, path.join(configDir, ".credentials.json"));
        authSource = "credentials file copied into isolated config dir";
      } catch {
        authSource = null;
      }

      const env = buildClaudeEnv(process.env, configDir);
      const args: string[] = ["-p", spec.task.prompt, ...buildClaudeArgs(spec)];

      const res = await spawnCapturing({
        cmd: claudePath,
        args,
        cwd: ctx.workspaceDir,
        env,
        timeoutMs: limits.timeoutMsPerRun,
        signal: ctx.signal,
        maxBufferChars: 2_000_000,
      });
      return {
        cmdDisplay: `claude -p <prompt> ${args.slice(2).join(" ")}`,
        ...res,
        isolation: {
          configDirIsolated: true,
          authSource,
          note: authSource
            ? "CLAUDE_CONFIG_DIR isolated; user skills/settings/plugins excluded; project skill only"
            : "CLAUDE_CONFIG_DIR isolated, but NO credentials found: expect an auth error",
        },
      };
    },
  };
}
