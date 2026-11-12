/**
 * Security gate for leaderboard skills.
 *
 * Before any skill is installed into a run workspace, its files are scanned
 * for behavior that escapes the sandbox contract:
 *   - network access (curl, raw sockets, package installs, non-localhost URLs)
 *   - shell/command execution outside the isolated workspace
 *     (child_process, eval, os.system, subprocess, `bash -c`, ...)
 *   - secrets accidentally shipped in the skill (keys, tokens, private keys)
 *
 * Skills matching these patterns are REFUSED: batch mode records refusal rows
 * with reasons into the results JSONL and never installs or runs the skill.
 * Markdown files are scanned fence-aware: prose URLs are fine; URLs inside
 * code fences are treated as instructions the agent may follow.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export type FindingKind = "network" | "shell-exec" | "secret";

export interface ScanFinding {
  file: string;
  line: number;
  kind: FindingKind;
  pattern: string;
  snippet: string;
}

export interface ScanResult {
  verdict: "allow" | "refuse";
  reasons: string[];
  findings: ScanFinding[];
  filesScanned: number;
}

export interface ScanOptions {
  /** Allow http(s)://localhost / 127.0.0.1 URLs (fixture-server tasks). Default true. */
  allowLocalhost?: boolean;
}

interface Pattern {
  kind: FindingKind;
  re: RegExp;
  label: string;
}

const NETWORK_PATTERNS: Pattern[] = [
  { kind: "network", re: /\b(curl|wget|nc|netcat|telnet|ssh|scp|sftp|rsync|ftp)\b/, label: "network tool invocation" },
  { kind: "network", re: /\b(fetch|XMLHttpRequest|axios|got|undici)\s*\(/, label: "HTTP client call" },
  { kind: "network", re: /\brequire\s*\(\s*['"](http|https|net|tls|dgram)['"]\)/, label: "raw socket module" },
  { kind: "network", re: /\b(http\.request|https\.request|http\.get|https\.get)\b/, label: "raw HTTP request" },
  { kind: "network", re: /\b(urllib|requests\.(get|post|put)|socket\.socket|httpx|aiohttp)\b/, label: "python network call" },
  { kind: "network", re: /\b(npm|pip|pnpm|yarn|uv|gem|cargo)\s+(install|add|i)\b/, label: "package install (fetches from the network)" },
  { kind: "network", re: /\bgit\s+(clone|push|pull|fetch)\b/, label: "git network operation" },
];

const SHELL_EXEC_PATTERNS: Pattern[] = [
  { kind: "shell-exec", re: /\bchild_process\b/, label: "node child_process" },
  { kind: "shell-exec", re: /\b(execSync|spawnSync|spawn|execFile|exec)\s*\(/, label: "process spawn" },
  { kind: "shell-exec", re: /\b(eval|new\s+Function)\s*\(/, label: "dynamic code evaluation" },
  { kind: "shell-exec", re: /\b(os\.system|os\.popen|subprocess\.(run|Popen|call|check_output))\b/, label: "python shell execution" },
  { kind: "shell-exec", re: /\b(bash|sh|zsh|powershell)\s+-c\b/, label: "shell one-liner" },
  { kind: "shell-exec", re: /\brm\s+-rf\s+[~/]/, label: "destructive delete outside workspace" },
  { kind: "shell-exec", re: /\bsudo\b/, label: "privilege escalation" },
  { kind: "shell-exec", re: /\bchmod\s+777\b/, label: "world-writable permissions" },
];

const SECRET_PATTERNS: Pattern[] = [
  { kind: "secret", re: /BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY/, label: "embedded private key" },
  { kind: "secret", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, label: "AWS access key id" },
  { kind: "secret", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, label: "GitHub token" },
  { kind: "secret", re: /\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/, label: "API key (sk-…)" },
  { kind: "secret", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, label: "Slack token" },
];

const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/?]|$)/;
const URL_RE = /https?:\/\/[^\s"'`]+/g;

/** True when a line's network hit is loopback-only (fixture servers). */
function isLocalhostOnly(line: string): boolean {
  const urls = line.match(URL_RE);
  return urls !== null && urls.length > 0 && urls.every((u) => LOCALHOST_RE.test(u));
}

function matchPatterns(text: string, patterns: Pattern[]): Array<{ line: number; p: Pattern; snippet: string }> {
  const hits: Array<{ line: number; p: Pattern; snippet: string }> = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? "";
    for (const p of patterns) {
      const m = p.re.exec(text);
      if (m) {
        hits.push({ line: i + 1, p, snippet: text.trim().slice(0, 120) });
      }
    }
  }
  return hits;
}

/** Split markdown into (codeFence, text) segments; only fences are scanned hard. */
function codeFenceSegments(text: string): Array<{ code: boolean; text: string; startLine: number }> {
  const lines = text.split(/\r?\n/);
  const segments: Array<{ code: boolean; text: string; startLine: number }> = [];
  let current: string[] = [];
  let inCode = false;
  let startLine = 1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i] ?? "")) {
      if (current.length > 0) segments.push({ code: inCode, text: current.join("\n"), startLine });
      inCode = !inCode;
      current = [];
      startLine = i + 2;
      continue;
    }
    current.push(lines[i] ?? "");
  }
  if (current.length > 0) segments.push({ code: inCode, text: current.join("\n"), startLine });
  return segments;
}

/** All patterns for a non-markdown file: network + shell + secrets. */
const SCRIPT_PATTERNS: Pattern[] = [...NETWORK_PATTERNS, ...SHELL_EXEC_PATTERNS, ...SECRET_PATTERNS];

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(full, base)));
    else if (e.isFile()) out.push(path.relative(base, full));
  }
  return out.sort();
}

export async function scanSkillDir(skillDir: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const allowLocalhost = opts.allowLocalhost ?? true;
  const findings: ScanFinding[] = [];
  let filesScanned = 0;

  const st = await stat(skillDir).catch(() => null);
  if (!st || !st.isDirectory()) {
    return { verdict: "refuse", reasons: [`skill directory not found: ${skillDir}`], findings, filesScanned };
  }

  const files = await listFiles(skillDir);
  for (const rel of files) {
    const full = path.join(skillDir, rel);
    const isMarkdown = /\.md$/i.test(rel);
    const text = await readFile(full, "utf8").catch(() => "");
    filesScanned++;
    const record = (line: number, p: Pattern, snippet: string) =>
      findings.push({ file: rel, line, kind: p.kind, pattern: p.label, snippet });

    if (isMarkdown) {
      for (const seg of codeFenceSegments(text)) {
        if (!seg.code) {
          // Prose: only secrets matter, even outside code fences.
          for (const h of matchPatterns(seg.text, SECRET_PATTERNS)) record(seg.startLine + h.line - 1, h.p, h.snippet);
          continue;
        }
        // Inside a fence the agent may treat content as instructions.
        for (const h of matchPatterns(seg.text, SCRIPT_PATTERNS)) {
          if (allowLocalhost && h.p.kind === "network" && isLocalhostOnly(h.snippet)) continue;
          record(seg.startLine + h.line - 1, h.p, h.snippet);
        }
      }
    } else {
      for (const h of matchPatterns(text, SCRIPT_PATTERNS)) {
        if (allowLocalhost && h.p.kind === "network" && isLocalhostOnly(h.snippet)) continue;
        record(h.line, h.p, h.snippet);
      }
    }
  }

  const reasons: string[] = [];
  for (const f of findings) {
    reasons.push(`${f.kind}: ${f.file}:${f.line} — ${f.pattern} (${f.snippet})`);
  }
  return {
    verdict: findings.length > 0 ? "refuse" : "allow",
    reasons,
    findings,
    filesScanned,
  };
}
