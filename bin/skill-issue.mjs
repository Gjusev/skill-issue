#!/usr/bin/env node
// Entry point for the npm package. Inside node_modules Node refuses to
// type-strip .ts files, so the published artifact ships compiled dist/;
// a git clone without a build falls back to running the TypeScript source
// (requires Node >= 22.18).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const distCli = path.join(here, "..", "dist", "cli.js");
const srcCli = path.join(here, "..", "src", "cli.ts");
const cli = existsSync(distCli) ? distCli : srcCli;
const child = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
process.exit(child.status ?? 1);
