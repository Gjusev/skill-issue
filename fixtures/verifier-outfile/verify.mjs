// Test verifier: passes only when out.txt exists with the skill-prescribed content.
import { readFile } from "node:fs/promises";
import path from "node:path";

const ws = process.env.SKILL_ISSUE_WORKSPACE;
if (!ws) { console.error("SKILL_ISSUE_WORKSPACE not set"); process.exit(1); }
try {
  const text = await readFile(path.join(ws, "out.txt"), "utf8");
  if (text === "made with the skill\n") {
    console.log("out.txt has the prescribed content");
    process.exit(0);
  }
  console.error("out.txt has different content");
  process.exit(1);
} catch {
  console.error("out.txt missing");
  process.exit(1);
}
