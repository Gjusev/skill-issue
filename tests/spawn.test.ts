import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnCapturing } from "../src/runners/spawn.ts";
import { makeTmp } from "./helpers.ts";
import path from "node:path";

test("timeout kills a sleeping process tree and reports timedOut", async () => {
  const t0 = Date.now();
  const res = await spawnCapturing({
    cmd: process.execPath,
    args: ["-e", "setTimeout(()=>{}, 60000)"],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 700,
  });
  const elapsed = Date.now() - t0;
  assert.equal(res.timedOut, true);
  assert.ok(elapsed < 5000, `process must die promptly after timeout (took ${elapsed}ms)`);
});

test("external abort cancels the child", async () => {
  const controller = new AbortController();
  const promise = spawnCapturing({
    cmd: process.execPath,
    args: ["-e", "setTimeout(()=>{}, 60000)"],
    cwd: process.cwd(),
    env: process.env,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 300);
  const res = await promise;
  assert.equal(res.cancelled, true);
  assert.equal(res.timedOut, false);
});

test("commands run fine in a cwd containing spaces", async () => {
  const dir = await makeTmp("spawn-space");
  const res = await spawnCapturing({
    cmd: process.execPath,
    args: ["-e", "console.log(process.cwd())"],
    cwd: dir,
    env: process.env,
  });
  assert.equal(res.exitCode, 0);
  assert.ok(res.stdout.trim().includes(path.basename(dir)));
});

test("stdout lines are streamed to the callback", async () => {
  const lines: string[] = [];
  const res = await spawnCapturing({
    cmd: process.execPath,
    args: ["-e", "console.log('one'); console.error('err1'); console.log('two')"],
    cwd: process.cwd(),
    env: process.env,
    onStdoutLine: (l) => lines.push(l),
    onStderrLine: (l) => lines.push("E:" + l),
  });
  assert.equal(res.exitCode, 0);
  assert.deepEqual(lines, ["one", "E:err1", "two"]);
});

test("killing the tree takes grandchildren with it", async () => {
  // child spawns a grandchild; timeout must clear both.
  const res = await spawnCapturing({
    cmd: process.execPath,
    args: ["-e", `const {spawn}=require("node:child_process"); const g=spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:"ignore"}); setInterval(()=>{},1000); process.on("SIGTERM",()=>{g.kill(); process.exit(9)});`],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 800,
  });
  assert.equal(res.timedOut, true);
});
