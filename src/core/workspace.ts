import { cp, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { hashTree } from "./hash.ts";

/** Name of the workspace directory that receives the evaluated skill. */
export const SKILL_INSTALL_DIR = ".claude";
/**
 * Fixture-only source name. It becomes SKILL.md only inside the isolated
 * workspace, so repository discovery tools do not advertise test fixtures as
 * installable agent skills.
 */
const SKILL_TEMPLATE_FILE = "SKILL.template.md";

export interface PreparedWorkspace {
  workspaceDir: string;
  /** Hash of the initial bytes, EXCLUDING the skill install dir (so baseline
   *  and skill variants must match on this hash for the comparison to count). */
  initialHashExclSkill: string;
}

/** Copy fixture bytes into a fresh workspace dir. Deterministic, byte-for-byte. */
export async function prepareWorkspace(
  fixtureDir: string,
  workspaceDir: string,
  opts: { skill?: { name: string; path: string } },
): Promise<PreparedWorkspace> {
  await mkdir(path.dirname(workspaceDir), { recursive: true });
  await cp(fixtureDir, workspaceDir, { recursive: true });
  if (opts.skill) {
    const dest = path.join(workspaceDir, SKILL_INSTALL_DIR, "skills", opts.skill.name);
    await cp(opts.skill.path, dest, { recursive: true });
    const installedSkill = path.join(dest, "SKILL.md");
    try {
      await stat(installedSkill);
    } catch {
      await rename(path.join(dest, SKILL_TEMPLATE_FILE), installedSkill);
    }
  }
  const initialHashExclSkill = await hashTree(workspaceDir, [SKILL_INSTALL_DIR]);
  return { workspaceDir, initialHashExclSkill };
}

export async function dirExists(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}
