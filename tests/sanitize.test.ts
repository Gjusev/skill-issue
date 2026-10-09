import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { sanitizeText, redactCredentials, redactPaths, truncate } from "../src/core/sanitize.ts";

test("sanitizeText chains credential and path redaction", () => {
  const out = sanitizeText(`wrote ${homedir()}\\secret.txt with sk-ant-api03-AbCdEf123456789`);
  assert.ok(!out.includes("sk-ant-api03"));
  assert.ok(!out.includes(homedir()));
});

test("credential patterns are redacted", () => {
  const dirty = "key=sk-ant-api03-AbCdEf123456789012345 and aws AKIAIOSFODNN7EXAMPLE and gh token ghp_16CharactersXXXXXXXXXX and Bearer abcdef1234567890abcd";
  const clean = redactCredentials(dirty);
  assert.ok(!clean.includes("sk-ant-api03"));
  assert.ok(!clean.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(!clean.includes("ghp_16"));
  assert.ok(!clean.includes("abcdef1234567890abcd"));
  assert.ok(clean.includes("[redacted-anthropic-key]"));
});

test("json credential fields are redacted", () => {
  const clean = redactCredentials('{"api_key": "supersecretvalue123", "n": 1}');
  assert.ok(!clean.includes("supersecretvalue123"));
  assert.ok(clean.includes('[redacted]'));
});

test("case-variant bearer and bare key:value forms are redacted", () => {
  const dirty = "authorization: bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30 and password: hunter2secret and API_KEY=abcd1234efgh5678";
  const clean = redactCredentials(dirty);
  assert.ok(!clean.includes("eyJhbGciOiJI"), "lowercase bearer JWT must be redacted");
  assert.ok(!clean.includes("hunter2secret"), "bare password: value must be redacted");
  assert.ok(!clean.includes("abcd1234efgh5678"), "bare API_KEY= form must be redacted");
  assert.ok(clean.includes("[redacted]"));
});

test("home directory is replaced with ~", () => {
  const out = redactPaths(`reading ${homedir()}\\project\\src\\cli.ts and ${homedir()}/x`);
  assert.ok(!out.includes(homedir()));
  assert.ok(out.includes("~"));
});

test("home directory in the opposite separator style is still redacted", () => {
  const back = homedir().replace(/\\/g, "/");
  if (back === homedir()) return; // non-Windows: nothing to prove
  const out = redactPaths(`saw ${back}/project/file.ts`);
  assert.ok(!out.includes(back), `forward-slash home must be redacted, got: ${out}`);
  assert.ok(out.includes("~"));
});

test("workspace roots are replaced", () => {
  const out = redactPaths("file at C:/Code Main/skill-issue/runs/x/workspace/a.txt", ["C:/Code Main/skill-issue/runs/x/workspace"]);
  assert.ok(!out.includes("C:/Code Main/skill-issue"));
  assert.ok(out.includes("[workspace-root]"));
});

test("truncate marks long text", () => {
  const r = truncate("x".repeat(50), 10);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length < 30);
  assert.equal(truncate("short", 10).truncated, false);
});
