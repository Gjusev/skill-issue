import { homedir, tmpdir } from "node:os";

/** Patterns that must never survive into reports or exports. */
const CREDENTIAL_PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted-anthropic-key]"],
  [/sk-[A-Za-z0-9_-]{20,}/g, "[redacted-api-key]"],
  [/AKIA[0-9A-Z]{16}/g, "[redacted-aws-key]"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted-github-token]"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[redacted-slack-token]"],
  [/Bearer\s+[A-Za-z0-9._-]{16,}/g, "Bearer [redacted]"],
  [/"(api[_-]?key|token|password|secret)"\s*:\s*"[^"]{6,}"/gi, '"$1":"[redacted]"'],
];

/** Replace machine-specific absolute path prefixes with stable placeholders. */
export function redactPaths(text: string, roots: string[] = []): string {
  let out = text;
  const home = homedir();
  const all = [home, tmpdir(), ...roots];
  // Longest first so nested prefixes win.
  for (const root of [...all].sort((a, b) => b.length - a.length)) {
    if (!root) continue;
    const norm = root.replace(/([.*+?^${}()|[\]\\])/g, "\\$1");
    out = out.replace(new RegExp(norm, "g"), root === home ? "~" : "[workspace-root]");
  }
  return out;
}

export function redactCredentials(text: string): string {
  let out = text;
  for (const [re, replacement] of CREDENTIAL_PATTERNS) out = out.replace(re, replacement);
  return out;
}

export function sanitizeText(text: string, roots: string[] = []): string {
  return redactCredentials(redactPaths(text, roots));
}

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + "\n…[truncated]", truncated: true };
}
