/**
 * Verifier for the release-notes demo task.
 * Independent of the agent: runs outside the workspace, reads only.
 * Success = RELEASE_NOTES.md exists and contains the three required sections
 * in the prescribed order.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const ws = process.env.SKILL_ISSUE_WORKSPACE;
if (!ws) {
  console.error("verifier: SKILL_ISSUE_WORKSPACE is not set (run me through skill-issue)");
  process.exit(1);
}

let text;
try {
  text = await readFile(path.join(ws, "RELEASE_NOTES.md"), "utf8");
} catch {
  console.error("verifier: RELEASE_NOTES.md was not created in the workspace");
  process.exit(1);
}

const want = ["## Changelog", "## Known Issues", "## Roadmap"];
let prev = -1;
for (const header of want) {
  const idx = text.indexOf(header);
  if (idx === -1) {
    console.error(`verifier: missing required section "${header}"`);
    process.exit(1);
  }
  if (idx < prev) {
    console.error(`verifier: section "${header}" appears out of order`);
    process.exit(1);
  }
  prev = idx;
}
console.log("verifier: RELEASE_NOTES.md contains Changelog, Known Issues and Roadmap in order");
process.exit(0);
