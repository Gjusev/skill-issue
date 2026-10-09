import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStream } from "../src/runners/parse.ts";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

test("result metrics are extracted when the provider reports them", () => {
  const stream = [
    line({ type: "system", subtype: "init", model: "test-model", skills: [{ name: "demo-skill" }] }),
    line({ type: "result", subtype: "success", is_error: false, result: "done", duration_ms: 1234, num_turns: 3, total_cost_usd: 0.05, usage: { input_tokens: 100, output_tokens: 40 } }),
  ].join("\n");
  const parsed = parseStream(stream, "demo-skill", []);
  assert.equal(parsed.providerMetrics.durationMs, 1234);
  assert.equal(parsed.providerMetrics.tokensIn, 100);
  assert.equal(parsed.providerMetrics.tokensOut, 40);
  assert.equal(parsed.providerMetrics.costUsd, 0.05);
  assert.equal(parsed.providerMetrics.turns, 3);
  assert.equal(parsed.resultText, "done");
  assert.equal(parsed.is_error, false);
});

test("absent usage stays null — never zero", () => {
  const stream = line({ type: "result", subtype: "success", is_error: false, result: "ok", duration_ms: 10 });
  const parsed = parseStream(stream, null, []);
  assert.equal(parsed.providerMetrics.tokensIn, null);
  assert.equal(parsed.providerMetrics.tokensOut, null);
  assert.equal(parsed.providerMetrics.costUsd, null);
  assert.equal(parsed.providerMetrics.turns, null);
});

test("corrupt lines are counted, not crashed on", () => {
  const stream = ["this is not json", line({ type: "result", subtype: "success", is_error: false, result: "ok" }), '{"type":"result","truncated'].join("\n");
  const parsed = parseStream(stream, null, []);
  assert.equal(parsed.corruptLines, 2);
  assert.equal(parsed.resultText, "ok");
});

test("Skill tool_use naming the evaluated skill is detected", () => {
  const stream = line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "1", name: "Skill", input: { skill: "demo-skill" } }] } });
  const parsed = parseStream(stream, "demo-skill", []);
  assert.equal(parsed.skillToolUses, 1);
  const other = parseStream(stream, "another-skill", []);
  assert.equal(other.skillToolUses, 0);
});

test("Read of the installed skill path is detected on both separators", () => {
  const fwd = line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "1", name: "Read", input: { file_path: "/tmp/ws/.claude/skills/demo-skill/SKILL.md" } }] } });
  const bwd = line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "2", name: "Read", input: { file_path: "C:\\tmp\\ws\\.claude\\skills\\demo-skill\\SKILL.md" } }] } });
  assert.equal(parseStream(fwd, "demo-skill", []).skillFileReads, 1);
  assert.equal(parseStream(bwd, "demo-skill", []).skillFileReads, 1);
});

test("observed model and visible skills are captured from the init event", () => {
  const stream = [
    line({ type: "system", subtype: "init", model: "glm-5.3-flash[1m]", skills: ["deep-research", "release-notes-format"] }),
    line({ type: "result", subtype: "success", is_error: false, result: "ok" }),
  ].join("\n");
  const parsed = parseStream(stream, "release-notes-format", []);
  assert.equal(parsed.observedModel, "glm-5.3-flash[1m]");
  assert.deepEqual(parsed.observedSkills, ["deep-research", "release-notes-format"]);
});

test("no init event means observed fields are null, not guesses", () => {
  const parsed = parseStream(line({ type: "result", subtype: "success", is_error: false, result: "ok" }), null, []);
  assert.equal(parsed.observedModel, null);
  assert.equal(parsed.observedSkills, null);
});

test("event details are sanitized against roots", () => {
  const stream = line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "1", name: "Write", input: { file_path: "/tmp/ws-123/out.txt" } }] } });
  const parsed = parseStream(stream, null, ["/tmp/ws-123"]);
  const ev = parsed.events.find((e) => e.type === "tool_use:Write");
  assert.ok(ev);
  assert.ok(!ev!.detail.includes("/tmp/ws-123"));
  assert.ok(ev!.detail.includes("[workspace-root]"));
});
