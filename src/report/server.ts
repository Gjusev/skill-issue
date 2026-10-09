import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readExperiment } from "../core/engine.ts";
import { buildExport } from "../core/export.ts";
import { loadSpec } from "../core/spec.ts";

const VIEWER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "viewer");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export async function startViewer(opts: { dataDir: string; port: number }): Promise<{ url: string; close: () => Promise<void> }> {
  const experimentsDir = path.resolve(opts.dataDir, "experiments");

  async function listExperiments(): Promise<string[]> {
    try {
      const entries = await readdir(experimentsDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
    } catch {
      return [];
    }
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const send = (code: number, body: string, type: string) => {
        res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
        res.end(body);
      };

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return send(200, await readFile(path.join(VIEWER_DIR, "index.html"), "utf8"), MIME[".html"]!);
      }
      if (url.pathname === "/app.js") {
        return send(200, await readFile(path.join(VIEWER_DIR, "app.js"), "utf8"), MIME[".js"]!);
      }
      if (url.pathname === "/style.css") {
        return send(200, await readFile(path.join(VIEWER_DIR, "style.css"), "utf8"), MIME[".css"]!);
      }
      if (url.pathname === "/favicon.svg") {
        return send(200, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#0b5cad"/><path d="M4 5h8M4 8h8M4 11h5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>', MIME[".svg"]!);
      }
      if (url.pathname === "/api/experiments") {
        const ids = await listExperiments();
        const items = [];
        for (const id of ids) {
          try {
            const r = await readExperiment(path.join(experimentsDir, id));
            items.push({
              id,
              taskId: r.taskId,
              createdAt: r.createdAt,
              skill: r.skill?.name ?? null,
              runner: r.agent.runner,
              comparisonValid: r.comparison.valid,
              statuses: r.records.map((x) => `${x.variantId}:${x.status}`),
            });
          } catch { /* skip unreadable experiments */ }
        }
        return send(200, JSON.stringify(items), "application/json");
      }
      const detail = url.pathname.match(/^\/api\/experiments\/([^/]+)$/);
      if (detail) {
        const id = decodeURIComponent(detail[1]!);
        if (!/^[A-Za-z0-9._-]+$/.test(id)) return send(400, "bad experiment id", "text/plain");
        const report = await readExperiment(path.join(experimentsDir, id)).catch(() => null);
        if (!report) return send(404, "experiment not found", "text/plain");
        return send(200, JSON.stringify(report), "application/json");
      }
      const exp = url.pathname.match(/^\/api\/experiments\/([^/]+)\/export$/);
      if (exp) {
        const id = decodeURIComponent(exp[1]!);
        if (!/^[A-Za-z0-9._-]+$/.test(id)) return send(400, "bad experiment id", "text/plain");
        const report = await readExperiment(path.join(experimentsDir, id)).catch(() => null);
        if (!report) return send(404, "experiment not found", "text/plain");
        const specRes = await loadSpec(report.specPath).catch(() => null);
        const exported = await buildExport(report, specRes?.spec?.task.prompt ?? null);
        return send(200, JSON.stringify(exported, null, 2), "application/json");
      }
      send(404, "not found", "text/plain");
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`viewer error: ${(e as Error).message}`);
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address() && typeof server.address() === "object" ? (server.address() as { port: number }).port : opts.port}`;
  console.log(`skill-issue viewer: ${url}`);
  console.log(`data dir: ${experimentsDir}`);
  console.log("press Ctrl+C to stop");
  return {
    url,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
