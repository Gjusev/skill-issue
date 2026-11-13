/**
 * Leaderboard manifest: parser (YAML subset), types and validation.
 *
 * The manifest lists candidate skills (repo, pinned commit, license) and
 * their deterministic task designs from docs/planning/3A-skills-leaderboard-plan.md.
 * Every task names a deterministic verifier criterion -- never an LLM judge.
 *
 * Why a hand-rolled YAML subset: the repo is dependency-free by policy and the
 * manifest uses a deliberately small syntax (nested maps, lists of maps, block
 * scalars, comments). Anything outside the subset is a hard parse error, not a
 * silent misread.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export type VerifierKind =
  | "file-exists"
  | "tests-pass"
  | "lint-holds"
  | "ffprobe"
  | "fixture-server"
  | "schema"
  | "string-match"
  | "structure";

export const VERIFIER_KINDS: readonly VerifierKind[] = [
  "file-exists", "tests-pass", "lint-holds", "ffprobe",
  "fixture-server", "schema", "string-match", "structure",
];

export interface ManifestTask {
  id: string;
  title: string;
  /** Deterministic success criterion (from the research doc §3). */
  criterion: string;
  verifierKind: VerifierKind;
  /** True only when the task needs external network (e.g. package installs). */
  needsNetwork: boolean;
  /** "designed" = blueprint only; "implemented" = workspace seed + verifier exist. */
  status: "designed" | "implemented";
  prompt?: string;
  /** Directory whose bytes seed every run's workspace (implemented tasks). */
  workspaceSeed?: string;
  /** Verifier directory + argv, same semantics as TaskSpec.verifier. */
  verifierDir?: string;
  verifierCommand?: string[];
  timeoutMsPerRun?: number;
  /** Scripted behaviour for the fixture harness (offline development only). */
  fixture?: { baseline: unknown[]; skill: unknown[] };
}

export interface ManifestSkill {
  id: string;
  repo: string;
  /** Pinned full commit hash of the evaluated revision. */
  commit: string;
  license: string;
  licenseNote?: string;
  /** skills.sh installs at manifest-creation time. Context only, never a ranking. */
  installs?: number;
  /** Local checkout of the pinned commit; batch mode refuses skills without it. */
  source?: string;
  /** Excluded skills stay listed for honesty but are never run. */
  excluded?: boolean;
  excludedReason?: string;
  tasks: ManifestTask[];
}

export interface LeaderboardManifest {
  manifestVersion: 1;
  name: string;
  harness: "claude-code" | "fixture";
  k: number;
  /** JSONL results file, relative to the manifest file. */
  results: string;
  skills: ManifestSkill[];
}

export interface ManifestLoadResult {
  ok: boolean;
  errors: string[];
  manifest: LeaderboardManifest | null;
  baseDir: string;
}

// ---------------------------------------------------------------------------
// YAML subset parser
// ---------------------------------------------------------------------------

interface SrcLine {
  indent: number;
  text: string;
  lineno: number;
}

class YamlSubsetError extends Error {}

/** Guarded index access: the parser treats out-of-range as a bug, not input. */
function lineAt(lines: SrcLine[], i: number): SrcLine {
  const l = lines[i];
  if (!l) throw new YamlSubsetError("internal parser error: line index out of range");
  return l;
}

/** Remove a comment: `#` outside quotes starts a comment. */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i);
    }
  }
  return line;
}

function toLines(raw: string): SrcLine[] {
  const out: SrcLine[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const stripped = stripComment(lines[i] ?? "").replace(/\s+$/, "");
    if (stripped.trim() === "") continue;
    if (stripped.includes("\t")) {
      throw new YamlSubsetError(`line ${i + 1}: tabs are not allowed in indentation`);
    }
    const indent = stripped.length - stripped.trimStart().length;
    out.push({ indent, text: stripped.trim(), lineno: i + 1 });
  }
  return out;
}

function parseScalar(text: string): unknown {
  const t = text.trim();
  if (t === "") return null;
  if (t === "~" || t === "null") return null;
  if (t === "true" || t === "True") return true;
  if (t === "false" || t === "False") return false;
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    const body = t.slice(1, -1);
    if (t.startsWith("'")) return body.replace(/''/g, "'");
    return body.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  if (/^\[.*\]$/.test(t)) {
    // inline list of scalars only
    const inner = t.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((s) => parseScalar(s));
  }
  return t;
}

function splitKey(text: string, lineno: number): { key: string; rest: string } {
  // find the colon that ends the key (outside quotes)
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ":" && !inSingle && !inDouble) {
      const after = text[i + 1];
      if (after === undefined || after === " ") {
        const key = text.slice(0, i).trim();
        if (key === "") throw new YamlSubsetError(`line ${lineno}: empty key`);
        return {
          key: key.replace(/^"/, "").replace(/"$/, "").replace(/^'/, "").replace(/'$/, ""),
          rest: text.slice(i + 1).trim(),
        };
      }
    }
  }
  throw new YamlSubsetError(`line ${lineno}: expected 'key: value', got '${text}'`);
}

/** Parse lines[i0..] whose indent is exactly `indent`; returns value and next index. */
function parseBlock(lines: SrcLine[], i0: number, indent: number): { value: unknown; next: number } {
  const first = lineAt(lines, i0);
  if (first.indent !== indent) {
    throw new YamlSubsetError(`line ${first.lineno}: bad indentation (expected ${indent}, got ${first.indent})`);
  }
  if (first.text.startsWith("- ") || first.text === "-") return parseList(lines, i0, indent);
  return parseMapping(lines, i0, indent);
}

function parseMapping(lines: SrcLine[], i0: number, indent: number): { value: Record<string, unknown>; next: number } {
  const map: Record<string, unknown> = {};
  let i = i0;
  while (i < lines.length) {
    const cur = lineAt(lines, i);
    if (cur.indent !== indent) break;
    const { key, rest } = splitKey(cur.text, cur.lineno);
    if (key in map) throw new YamlSubsetError(`line ${cur.lineno}: duplicate key '${key}'`);
    if (rest === "|" || rest === "|-" || rest === "|+") {
      // block scalar: content is every line indented at least as deep as the
      // first content line; that line fixes the strip indentation.
      const keepNewline = rest === "|";
      if (i + 1 >= lines.length || lineAt(lines, i + 1).indent <= indent) {
        map[key] = "";
        i++;
        continue;
      }
      const blockIndent = lineAt(lines, i + 1).indent;
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lineAt(lines, j);
        if (l.indent < blockIndent) break;
        body.push(" ".repeat(l.indent - blockIndent) + l.text);
        j++;
      }
      map[key] = body.join("\n") + (keepNewline ? "\n" : "");
      i = j;
      continue;
    }
    if (rest === "") {
      // nested block (map or list); an empty value with no children is null
      if (i + 1 < lines.length && lineAt(lines, i + 1).indent > indent) {
        const child = parseBlock(lines, i + 1, lineAt(lines, i + 1).indent);
        map[key] = child.value;
        i = child.next;
      } else {
        map[key] = null;
        i++;
      }
      continue;
    }
    map[key] = parseScalar(rest);
    i++;
  }
  return { value: map, next: i };
}

function parseList(lines: SrcLine[], i0: number, indent: number): { value: unknown[]; next: number } {
  const items: unknown[] = [];
  let i = i0;
  while (i < lines.length) {
    const cur = lineAt(lines, i);
    if (cur.indent !== indent || !(cur.text.startsWith("- ") || cur.text === "-")) break;
    const body = cur.text === "-" ? "" : cur.text.slice(2).trim();
    if (body === "") {
      // item value is a nested block on the following lines
      if (i + 1 < lines.length && lineAt(lines, i + 1).indent > indent) {
        const child = parseBlock(lines, i + 1, lineAt(lines, i + 1).indent);
        items.push(child.value);
        i = child.next;
      } else {
        items.push(null);
        i++;
      }
      continue;
    }
    // does the item itself look like `key: value`? -> list of maps
    if (/^[^:'"[]+:( |$)/.test(body)) {
      // Re-parse the item as a mapping: a virtual first line aligned with the
      // item's continuation lines, then every following line indented deeper
      // than the dash (nested blocks included) until the next item at `indent`.
      const contIndent = i + 1 < lines.length && lineAt(lines, i + 1).indent > indent
        ? lineAt(lines, i + 1).indent
        : indent + 2;
      const sub: SrcLine[] = [{ indent: contIndent, text: body, lineno: cur.lineno }];
      let j = i + 1;
      while (j < lines.length && lineAt(lines, j).indent > indent) {
        sub.push(lineAt(lines, j));
        j++;
      }
      const parsed = parseMapping(sub, 0, contIndent);
      items.push(parsed.value);
      i += parsed.next; // parsed.next counts lines inside `sub`; first is virtual
      continue;
    }
    items.push(parseScalar(body));
    i++;
  }
  return { value: items, next: i };
}

/** Parse the supported YAML subset. Throws YamlSubsetError with line numbers. */
export function parseYamlSubset(raw: string): unknown {
  const lines = toLines(raw);
  if (lines.length === 0) return null;
  if (lines[0] && lines[0].indent !== 0) throw new YamlSubsetError("document must start at column 0");
  const { value, next } = parseBlock(lines, 0, 0);
  if (next < lines.length) {
    throw new YamlSubsetError(`line ${lineAt(lines, next).lineno}: unexpected indentation`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

const COMMIT_RE = /^[0-9a-f]{40}$/i;
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function validateManifest(obj: unknown): { errors: string[]; manifest: LeaderboardManifest | null } {
  const errors: string[] = [];
  const m = (obj ?? {}) as Partial<LeaderboardManifest>;
  const need = (cond: boolean, msg: string) => { if (!cond) errors.push(msg); };

  const isRecord = typeof m === "object" && m !== null && !Array.isArray(m);
  need(isRecord, "manifest must be a mapping");
  if (!isRecord) return { errors, manifest: null };
  need(m.manifestVersion === 1, "manifestVersion must be 1");
  need(typeof m.name === "string" && m.name.length > 0, "name is required");
  need(m.harness === "claude-code" || m.harness === "fixture", "harness must be 'claude-code' or 'fixture'");
  need(typeof m.k === "number" && Number.isInteger(m.k) && m.k >= 1 && m.k <= 5, "k must be an integer 1..5");
  need(typeof m.results === "string" && (m.results as string).length > 0, "results (JSONL path) is required");
  need(Array.isArray(m.skills) && m.skills.length > 0, "skills must be a non-empty list");

  const seenSkill = new Set<string>();
  const seenTask = new Set<string>();
  const skills = Array.isArray(m.skills) ? m.skills : [];
  for (const s of skills) {
    const sk = (s ?? {}) as Partial<ManifestSkill>;
    const label = typeof sk.id === "string" ? sk.id : "(unnamed skill)";
    need(typeof sk.id === "string" && ID_RE.test(sk.id), `skill id must be kebab-case: '${label}'`);
    if (typeof sk.id === "string") {
      if (seenSkill.has(sk.id)) errors.push(`duplicate skill id: ${sk.id}`);
      seenSkill.add(sk.id);
    }
    need(typeof sk.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(sk.repo ?? ""), `skill '${label}': repo must be 'owner/repo'`);
    need(typeof sk.commit === "string" && COMMIT_RE.test(sk.commit ?? ""), `skill '${label}': commit must be a full 40-hex sha`);
    need(typeof sk.license === "string" && (sk.license as string).length > 0, `skill '${label}': license is required (no license = excluded)`);
    if (sk.excluded) need(typeof sk.excludedReason === "string" && (sk.excludedReason as string).length > 0, `skill '${label}': excluded skills need excludedReason`);
    need(Array.isArray(sk.tasks) && sk.tasks.length > 0, `skill '${label}': needs at least one task`);
    const tasks = Array.isArray(sk.tasks) ? sk.tasks : [];
    for (const t of tasks) {
      const tk = (t ?? {}) as Partial<ManifestTask>;
      const tlabel = `${label}/${typeof tk.id === "string" ? tk.id : "(unnamed)"}`;
      need(typeof tk.id === "string" && ID_RE.test(tk.id ?? ""), `task '${tlabel}': id must be kebab-case`);
      const tkey = `${label}:${typeof tk.id === "string" ? tk.id : "?"}`;
      if (seenTask.has(tkey)) errors.push(`duplicate task id: ${tlabel}`);
      seenTask.add(tkey);
      need(typeof tk.title === "string" && (tk.title as string).length > 0, `task '${tlabel}': title is required`);
      need(typeof tk.criterion === "string" && (tk.criterion as string).length > 0, `task '${tlabel}': criterion is required`);
      need(VERIFIER_KINDS.includes(tk.verifierKind as VerifierKind), `task '${tlabel}': verifierKind must be one of ${VERIFIER_KINDS.join("|")}`);
      need(tk.status === "designed" || tk.status === "implemented", `task '${tlabel}': status must be 'designed' or 'implemented'`);
      if (tk.status === "implemented") {
        need(typeof tk.workspaceSeed === "string" && (tk.workspaceSeed as string).length > 0, `task '${tlabel}': implemented tasks need workspaceSeed`);
        need(typeof tk.verifierDir === "string" && Array.isArray(tk.verifierCommand) && tk.verifierCommand.length > 0, `task '${tlabel}': implemented tasks need verifierDir + verifierCommand`);
        need(typeof tk.prompt === "string" && (tk.prompt as string).length > 0, `task '${tlabel}': implemented tasks need prompt`);
      }
      need(typeof tk.needsNetwork === "boolean", `task '${tlabel}': needsNetwork must be true or false`);
    }
  }

  if (errors.length > 0) return { errors, manifest: null };
  return { errors, manifest: m as LeaderboardManifest };
}

export async function loadManifest(manifestPath: string): Promise<ManifestLoadResult> {
  const abs = path.resolve(manifestPath);
  const baseDir = path.dirname(abs);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch (e) {
    return { ok: false, errors: [`cannot read manifest: ${(e as Error).message}`], manifest: null, baseDir };
  }
  let obj: unknown;
  try {
    obj = parseYamlSubset(raw);
  } catch (e) {
    return { ok: false, errors: [(e as Error).message], manifest: null, baseDir };
  }
  const { errors, manifest } = validateManifest(obj);
  return { ok: errors.length === 0, errors, manifest, baseDir };
}

/** JSONL task_id: skills and tasks share one namespace in the results file. */
export function jsonlTaskId(skillId: string, taskId: string): string {
  return `${skillId}/${taskId}`;
}
