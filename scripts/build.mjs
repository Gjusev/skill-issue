#!/usr/bin/env node
// Build step for the npm artifact: compile TS to dist/ and copy the
// non-TS runtime assets (viewer UI, fixture agent) that tsc ignores.
// Dev flow (running src/*.ts from a clone) does not need this.
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tsc = spawnSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(root, "tsconfig.build.json")], {
  stdio: "inherit",
  cwd: root,
});
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

await rm(path.join(root, "dist", "report", "viewer"), { recursive: true, force: true });
await cp(path.join(root, "src", "report", "viewer"), path.join(root, "dist", "report", "viewer"), { recursive: true });
await cp(path.join(root, "src", "runners", "fixture-agent.mjs"), path.join(root, "dist", "runners", "fixture-agent.mjs"));

console.log("build: dist/ ready (compiled JS + viewer assets + fixture agent)");
