import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeArgs, buildClaudeEnv } from "../src/runners/claude-code.ts";
import { baseSpec } from "./helpers.ts";

test("isolation flags are always present", () => {
  const args = buildClaudeArgs(baseSpec({ agent: { runner: "claude-code" } }));
  const flat = args.join(" ");
  assert.ok(flat.includes("--setting-sources project"), "must restrict setting sources");
  assert.ok(flat.includes("--strict-mcp-config"), "must ignore machine MCP config");
  assert.ok(flat.includes("--no-session-persistence"), "must not write session state");
  assert.ok(flat.includes("--permission-mode acceptEdits"));
  assert.ok(flat.includes("--permission-prompts none"));
  assert.ok(flat.includes("stream-json"));
});

test("model, effort and budget are passed through when set", () => {
  const spec = baseSpec({
    agent: { runner: "claude-code", model: "sonnet", effort: "low" },
    limits: { timeoutMsPerRun: 1000, maxBudgetUsd: 0.25, repetitions: 1 },
  });
  const args = buildClaudeArgs(spec);
  assert.ok(args.includes("--model"));
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
  assert.equal(args[args.indexOf("--effort") + 1], "low");
  assert.equal(args[args.indexOf("--max-budget-usd") + 1], "0.25");
});

test("bypass permissions maps to bypassPermissions", () => {
  const args = buildClaudeArgs(baseSpec({ agent: { runner: "claude-code", permissions: "bypass" } }));
  assert.ok(args.includes("bypassPermissions"));
});

test("env strips user CLAUDE_* vars and points CLAUDE_CONFIG_DIR at the isolated dir", () => {
  const env = buildClaudeEnv(
    { ...process.env, CLAUDE_CODE_SOMETHING: "x", CLAUDE_CONFIG_DIR: "C:\\user\\global", ANTHROPIC_KEEP: "1" },
    "C:\\exp\\isolated-config",
  );
  assert.equal(env.CLAUDE_CODE_SOMETHING, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, "C:\\exp\\isolated-config");
  assert.equal(env.ANTHROPIC_KEEP, "1");
});

test("preflight degrades gracefully when the CLI is absent (or reports its version when present)", async () => {
  const { createClaudeCodeRunner } = await import("../src/runners/claude-code.ts");
  const { spawnSync } = await import("node:child_process");
  const probe = spawnSync("claude", ["--version"], { timeout: 10_000, shell: false });
  const res = await createClaudeCodeRunner().preflight();
  if (probe.error) {
    assert.equal(res.ok, false);
    assert.ok(res.error);
  } else {
    assert.equal(res.ok, true);
    assert.match(res.version ?? "", /\d+\.\d+/);
  }
});
