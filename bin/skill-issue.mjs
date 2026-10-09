#!/usr/bin/env node
// Shim that runs the TypeScript CLI directly. Requires Node >= 22.18
// (native type stripping); the engine sets no other requirement.
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import path from "node:path";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const child = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
process.exit(child.status ?? 1);
