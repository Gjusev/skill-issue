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

test("stdout and stderr lines stream to callbacks in per-stream order", async () => {
  // Cross-stream interleaving is NOT guaranteed (separate pipes, OS
  // scheduling); only the order within each stream is.
  const out: string[] = [];
  const err: string[] = [];
  const res = await spawnCapturing({
    cmd: process.execPath,
    args: ["-e", "console.log('one'); console.error('err1'); console.log('two'); console.error('err2')"],
    cwd: process.cwd(),
    env: process.env,
    onStdoutLine: (l) => out.push(l),
    onStderrLine: (l) => err.push(l),
  });
  assert.equal(res.exitCode, 0);
  assert.deepEqual(out, ["one", "two"]);
  assert.deepEqual(err, ["err1", "err2"]);
});

test("killing the tree takes grandchildren with it (orphan detection via file lock)", async () => {
  const dir = await makeTmp("spawn-tree");
  const lock = path.join(dir, "grandchild-holds-me.txt");
  // The grandchild opens the file and HOLDS the handle; on Windows a file
  // held by a live process cannot be deleted. If the tree kill leaves the
  // grandchild alive, the unlink below fails — that is the orphan detector.
  const res = await spawnCapturing({
    cmd: process.execPath,
    args: ["-e", `const {spawn}=require("node:child_process"); const fs=require("node:fs");
      const g=spawn(process.execPath,["-e",${JSON.stringify(`const fs=require("node:fs"); fs.writeFileSync(${JSON.stringify(lock)}, "held"); const fd=fs.openSync(${JSON.stringify(lock)}, "r+"); setInterval(()=>{},1000); process.on("SIGTERM",()=>process.exit(0));`)}],{stdio:"ignore",detached:false});
      setInterval(()=>{},1000); process.on("SIGTERM",()=>{process.exit(9)});`],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 900,
  });
  assert.equal(res.timedOut, true);
  // Give the OS a moment to finish tearing down, then prove the grandchild is
  // gone by deleting the file it holds open.
  await new Promise((r) => setTimeout(r, 1500));
  const fs = await import("node:fs/promises");
  try {
    await fs.rm(lock, { force: true });
  } catch {
    assert.fail("grandchild appears to still hold the lock file — tree kill left an orphan");
  }
});
