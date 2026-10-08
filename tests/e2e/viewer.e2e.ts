/**
 * Browser e2e for the viewer: engine -> experiment.json -> HTTP server -> real browser.
 * Uses puppeteer-core with a locally installed Edge/Chrome (no download).
 * Honest skip: exits 0 with an explicit SKIPPED line when no browser exists.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { runExperiment } from "../../src/core/engine.ts";
import { createFixtureRunner } from "../../src/runners/fixture.ts";
import { startViewer } from "../../src/report/server.ts";

const CANDIDATE_BROWSERS = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((p): p is string => !!p && existsSync(p));

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`e2e assertion failed: ${msg}`);
}

async function main() {
  if (CANDIDATE_BROWSERS.length === 0) {
    console.log("SKIPPED: no local browser found (set PUPPETEER_EXECUTABLE_PATH to run this e2e).");
    return;
  }

  // 1. Generate a real fixture experiment (no model).
  const dataDir = await mkdtemp(path.join(tmpdir(), "skill-issue-e2e-"));
  const repo = path.resolve(import.meta.dirname, "..", "..");
  const specPath = path.join(repo, "examples", "tasks", "release-notes.fixture.json");
  const report = await runExperiment(specPath, createFixtureRunner(), { dataDir });
  assert(report.records.length === 2, "experiment produced two records");
  const skillRec = report.records.find((r) => r.variantId === "skill");
  assert(skillRec?.status === "passed", "skill variant passed");
  const baseRec = report.records.find((r) => r.variantId === "baseline");
  assert(baseRec?.status === "failed", "baseline failed");

  // 2. Serve it.
  const viewer = await startViewer({ dataDir, port: 0 });

  // 3. Drive a real browser.
  const puppeteer = await import("puppeteer-core");
  const browser = await puppeteer.default.launch({
    executablePath: CANDIDATE_BROWSERS[0],
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    // List view
    await page.goto(viewer.url, { waitUntil: "networkidle0" });
    const listHtml = await page.content();
    assert(listHtml.includes(report.experimentId), "list shows the experiment id");
    assert(listHtml.includes("release-notes-demo"), "list shows the task id");

    // Detail view
    await page.goto(`${viewer.url}/#/exp/${report.experimentId}`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".card");
    const detail = await page.content();
    assert(detail.includes("baseline"), "baseline card present");
    assert(detail.includes("skill"), "skill card present");
    assert(detail.toLowerCase().includes("not measured"), "unmeasured metrics labeled, not zeroed");
    assert(detail.includes("observed read/invoke"), "activation evidence chip present");
    assert(detail.toLowerCase().includes("insufficient evidence"), "no-winner disclaimer present");
    assert(!detail.includes("winner"), "no winner declared");

    // Evidence drawer via keyboard: focus first evidence button, press Enter.
    const focusedOk = await page.evaluate(() => {
      const btn = document.querySelector("[data-evidence] button") as HTMLElement | null;
      if (!btn) return false;
      btn.focus();
      return document.activeElement === btn;
    });
    assert(focusedOk, "evidence button focusable");
    await page.keyboard.press("Enter");
    const drawerVisible = await page.evaluate(() => {
      const d = document.getElementById("drawer");
      return !!d && !d.hidden;
    });
    assert(drawerVisible, "drawer opens from keyboard activation");
    const drawerText = await page.evaluate(() => document.getElementById("drawer-body")?.textContent ?? "");
    assert(drawerText.length > 0, "drawer has content");

    // Escape closes and restores focus
    await page.keyboard.press("Escape");
    assert(await page.evaluate(() => document.getElementById("drawer")!.hidden), "Escape closes drawer");

    // Export endpoint returns sanitized JSON
    const exportResp = (await page.evaluate(async (id) => {
      const r = await fetch(`/api/experiments/${id}/export`);
      return r.json();
    }, report.experimentId)) as { exportVersion?: number; variants?: unknown[] };
    assert(exportResp.exportVersion === 1, "export version present");
    assert(exportResp.variants?.length === 2, "export has both variants");
    assert(!JSON.stringify(exportResp).includes("Write RELEASE_NOTES.md summarizing"), "export excludes prompt text");

    // Screenshots as local evidence
    await page.goto(`${viewer.url}/#/exp/${report.experimentId}`, { waitUntil: "networkidle0" });
    const artifacts = path.join(repo, "artifacts");
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, "viewer-e2e-detail.png"), fullPage: true });
    await page.evaluate(() => {
      const btn = document.querySelector("[data-evidence] button") as HTMLElement;
      btn.focus();
    });
    await page.keyboard.press("Enter");
    await page.waitForSelector("#drawer:not([hidden])");
    await page.screenshot({ path: path.join(artifacts, "viewer-e2e-drawer.png"), fullPage: true });

    assert(errors.length === 0, `no page errors (got: ${errors.join(" | ")})`);
    console.log(`E2E OK — ${CANDIDATE_BROWSERS[0]}`);
    console.log(`screenshots: ${path.join(artifacts, "viewer-e2e-detail.png")}, ${path.join(artifacts, "viewer-e2e-drawer.png")}`);
  } finally {
    await browser.close();
    await viewer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
