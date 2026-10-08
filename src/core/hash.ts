import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Deterministic hash of a file tree (relative POSIX paths + bytes), skipping
 *  the given top-level entry names. Used to prove both variants started from
 *  the same bytes (the skill directory is excluded because it IS the difference). */
export async function hashTree(root: string, excludeTopLevel: string[] = []): Promise<string> {
  const h = createHash("sha256");
  await walk(root, root);
  return h.digest("hex");

  async function walk(dir: string, base: string): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const e of entries) {
      if (dir === root && excludeTopLevel.includes(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(base, full).split(path.sep).join("/");
      if (e.isDirectory()) {
        h.update(`dir:${rel}\n`);
        await walk(full, base);
      } else if (e.isFile()) {
        h.update(`file:${rel}\n`);
        h.update(await readFile(full));
      } else if (e.isSymbolicLink()) {
        h.update(`link:${rel}\n`);
      }
    }
  }
}

export async function hashFile(p: string): Promise<string> {
  return createHash("sha256").update(await readFile(p)).digest("hex");
}

/** Snapshot of {relativePosixPath: sha256} for change detection. */
export async function snapshotTree(root: string, excludeTopLevel: string[] = []): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  await walk(root, root);
  return map;

  async function walk(dir: string, base: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (dir === root && excludeTopLevel.includes(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(base, full).split(path.sep).join("/");
      if (e.isDirectory()) {
        await walk(full, base);
      } else {
        try {
          const s = await stat(full);
          map.set(rel, s.isFile() ? (await hashFile(full)).slice(0, 32) : null);
        } catch {
          map.set(rel, null);
        }
      }
    }
  }
}

export function diffTrees(before: Map<string, string | null>, after: Map<string, string | null>) {
  const changes: Array<{ path: string; change: "created" | "modified" | "deleted" }> = [];
  for (const [p, hashAfter] of after) {
    const hashBefore = before.get(p);
    if (hashBefore === undefined) changes.push({ path: p, change: "created" });
    else if (hashBefore !== hashAfter) changes.push({ path: p, change: "modified" });
  }
  for (const p of before.keys()) if (!after.has(p)) changes.push({ path: p, change: "deleted" });
  changes.sort((a, b) => (a.path < b.path ? -1 : 1));
  return changes;
}
