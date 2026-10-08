import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerAdapter, RawRun, RunnerContext } from "./types.ts";
import { spawnCapturing } from "./spawn.ts";

/**
 * Fixture runner: a simulated agent. It exists to test the ENGINE (workspaces,
 * evidence, verifier, statuses, cancellation) with deterministic scripts.
 * A fixture run proves the harness works — it says nothing about any real
 * agent, provider or skill.
 */
export function createFixtureRunner(): RunnerAdapter {
  return {
    id: "fixture",
    capabilities: { isolateGlobalConfig: true, reportMetrics: false, label: "simulated agent (no model)" },
    async preflight() {
      return { ok: true, version: "built-in" };
    },
    async run(ctx: RunnerContext): Promise<RawRun> {
      const steps = ctx.variantId === "skill" ? ctx.spec.agent.fixture?.skill : ctx.spec.agent.fixture?.baseline;
      if (!steps) throw new Error("fixture runner requires agent.fixture steps for this variant");
      const stepsFile = await mkdtemp(path.join(tmpdir(), "skill-issue-fixture-")).then((d) => path.join(d, "steps.json"));
      await writeFile(stepsFile, JSON.stringify(steps), "utf8");
      const agentScript = path.join(path.dirname(fileURLToPath(new URL(import.meta.url))), "fixture-agent.mjs");

      const res = await spawnCapturing({
        cmd: process.execPath,
        args: [agentScript, stepsFile, path.resolve(ctx.workspaceDir)],
        cwd: ctx.workspaceDir,
        env: { ...process.env },
        timeoutMs: ctx.limits.timeoutMsPerRun,
        signal: ctx.signal,
      });
      return {
        cmdDisplay: "node fixture-agent.mjs <steps> <workspace>",
        ...res,
        isolation: {
          configDirIsolated: true,
          authSource: null,
          note: "fixture agent: no global config, no model, not a provider compatibility test",
        },
      };
    },
  };
}
