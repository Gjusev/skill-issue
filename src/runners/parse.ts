import { sanitizeText, truncate } from "../core/sanitize.ts";

export interface StreamEventSummary {
  type: string;
  detail: string;
}

export interface ParsedStream {
  events: StreamEventSummary[];
  resultText: string | null;
  is_error: boolean;
  providerMetrics: {
    durationMs: number | null;
    tokensIn: number | null;
    tokensOut: number | null;
    costUsd: number | null;
    turns: number | null;
  };
  /** stdout contained lines that were not valid JSON objects. */
  corruptLines: number;
  /** Skill tool_use events naming the evaluated skill. */
  skillToolUses: number;
  /** Read/Edit/Write tool_use events targeting the installed skill directory. */
  skillFileReads: number;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Parse a Claude Code `--output-format stream-json --verbose` stdout stream.
 * Tolerant by design: corrupt lines are counted, never thrown — an incomplete
 * or corrupt stream must surface as infrastructure error, not as a crash.
 */
export function parseStream(stdout: string, skillName: string | null, sanitizeRoots: string[]): ParsedStream {
  const events: StreamEventSummary[] = [];
  let resultText: string | null = null;
  let is_error = false;
  let corruptLines = 0;
  let skillToolUses = 0;
  let skillFileReads = 0;
  const providerMetrics = { durationMs: null, tokensIn: null, tokensOut: null, costUsd: null, turns: null } as ParsedStream["providerMetrics"];

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
      if (obj === null || typeof obj !== "object" || Array.isArray(obj)) throw new Error("not an object");
    } catch {
      corruptLines++;
      continue;
    }
    switch (obj.type) {
      case "system": {
        const sub = typeof obj.subtype === "string" ? obj.subtype : "";
        events.push({ type: `system/${sub || "message"}`, detail: describeSystem(obj) });
        break;
      }
      case "assistant": {
        const content = obj.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "tool_use") {
              const name = String(block.name ?? "?");
              const input = block.input ?? {};
              const target = typeof input.file_path === "string" ? input.file_path : typeof input.command === "string" ? input.command : typeof input.skill === "string" ? input.skill : "";
              events.push({ type: `tool_use:${name}`, detail: truncate(sanitizeText(target, sanitizeRoots).slice(0, 160), 160).text });
              if (name === "Skill" && skillName && String(input.skill ?? "") === skillName) skillToolUses++;
              const fp = typeof input.file_path === "string" ? input.file_path.replace(/\\/g, "/") : "";
              if ((name === "Read" || name === "Edit" || name === "Write") && skillName && fp.includes(`.claude/skills/${skillName}/`)) skillFileReads++;
            } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
              events.push({ type: "assistant:text", detail: truncate(sanitizeText(block.text, sanitizeRoots).replace(/\s+/g, " "), 160).text });
            }
          }
        }
        break;
      }
      case "user": {
        // tool results; keep a compact trace without dumping content
        const content = obj.message?.content;
        if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")) {
          events.push({ type: "tool_result", detail: "" });
        }
        break;
      }
      case "result": {
        is_error = obj.is_error === true;
        resultText = typeof obj.result === "string" ? obj.result : null;
        providerMetrics.durationMs = num(obj.duration_ms);
        providerMetrics.turns = num(obj.num_turns);
        providerMetrics.costUsd = num(obj.total_cost_usd);
        providerMetrics.tokensIn = num(obj.usage?.input_tokens);
        providerMetrics.tokensOut = num(obj.usage?.output_tokens);
        events.push({ type: `result/${typeof obj.subtype === "string" ? obj.subtype : "?"}`, detail: is_error ? "provider reported an error" : "provider reported completion" });
        break;
      }
      default:
        events.push({ type: String(obj.type ?? "unknown"), detail: "" });
    }
  }
  return { events, resultText, is_error, providerMetrics, corruptLines, skillToolUses, skillFileReads };
}

function describeSystem(obj: any): string {
  if (obj.subtype === "init") {
    const model = typeof obj.model === "string" ? obj.model : "";
    const skills = Array.isArray(obj.skills) ? ` skills=${obj.skills.length}` : "";
    return `session init${model ? ` model=${model}` : ""}${skills}`;
  }
  return "";
}
