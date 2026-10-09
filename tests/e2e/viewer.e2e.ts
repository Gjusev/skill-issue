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

import assert from "node:assert/strict";

async function main() {
  if (CANDIDATE_BROWSERS.length === 0) {
    console.log("SKIPPED: no local browser found (set PUPPETEER_EXECUTABLE_PATH to run this e2e).");
    return;
  }

  // 1. Generate fixture experiments (no model): one normal, one timeout,
  //    one with an invalid comparison (verifier tampered mid-run).
  const dataDir = await mkdtemp(path.join(tmpdir(), "skill-issue-e2e-"));
  const repo = path.resolve(import.meta.dirname, "..", "..");
  const { writeFile } = await import("node:fs/promises");
  const specPath = path.join(repo, "examples", "tasks", "release-notes.fixture.json");
  const report = await runExperiment(specPath, createFixtureRunner(), { dataDir });
  assert(report.records.length === 2, "experiment produced two records");
  const skillRec = report.records.find((r) => r.variantId === "skill");
  assert(skillRec?.status === "passed", "skill variant passed");
  const baseRec = report.records.find((r) => r.variantId === "baseline");
  assert(baseRec?.status === "failed", "baseline failed");

  // timeout experiment
  const timeoutSpec = {
    specVersion: 1,
    id: "e2e-timeout",
    task: { prompt: "x", workspaceCopyFrom: path.join(repo, "examples", "workspaces", "release-notes") },
    verifier: { copyFrom: path.join(repo, "examples", "verifiers", "release-notes"), command: ["node", "verify.mjs"], successCriteria: "x" },
    skill: { name: "release-notes-format", path: path.join(repo, "examples", "skills", "release-notes-format") },
    agent: { runner: "fixture", fixture: { baseline: [{ action: "sleep", ms: 60_000 }], skill: [{ action: "sleep", ms: 60_000 }] } },
    limits: { timeoutMsPerRun: 800, repetitions: 1 },
  };
  const timeoutSpecPath = path.join(dataDir, "timeout-spec.json");
  await writeFile(timeoutSpecPath, JSON.stringify(timeoutSpec), "utf8");
  const timeoutReport = await runExperiment(timeoutSpecPath, createFixtureRunner(), { dataDir });
  assert(timeoutReport.records.every((r) => r.status === "timeout"), "timeout statuses");

  // invalid comparison experiment (skill variant tampers with the verifier)
  const tamperSpec = JSON.parse(JSON.stringify(timeoutSpec));
  tamperSpec.id = "e2e-invalid";
  tamperSpec.limits = { timeoutMsPerRun: 20_000, repetitions: 1 };
  tamperSpec.agent.fixture = {
    baseline: [{ action: "exit", code: 0 }],
    skill: [
      { action: "writeFile", path: "../../../verifier/verify.mjs", content: "process.exit(0)\n" },
      { action: "exit", code: 0 },
    ],
  };
  const tamperSpecPath = path.join(dataDir, "tamper-spec.json");
  await writeFile(tamperSpecPath, JSON.stringify(tamperSpec), "utf8");
  const tamperReport = await runExperiment(tamperSpecPath, createFixtureRunner(), { dataDir });
  assert(tamperReport.records.some((r) => r.status === "invalid_comparison"), "tamper produces invalid_comparison");

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

    // List shows all three experiments with honest status chips
    await page.goto(`${viewer.url}/`, { waitUntil: "networkidle0" });
    const listText = await page.evaluate(() => document.body.textContent ?? "");
    assert.ok(listText.includes(report.experimentId));
    assert.ok(listText.includes(timeoutReport.experimentId));
    assert.ok(listText.includes(tamperReport.experimentId));
    assert.ok(listText.includes("not comparable"), "invalid experiment flagged in the list");

    // Timeout detail: TIMEOUT badge, verifier not run, endReason mentions the kill
    await page.goto(`${viewer.url}/#/exp/${timeoutReport.experimentId}`, { waitUntil: "networkidle0" });
    let detailText = await page.evaluate(() => document.body.textContent ?? "");
    assert.ok(detailText.toUpperCase().includes("TIMEOUT"), "timeout badge visible");
    assert.ok(detailText.includes("verifier not run"), "verifier explicitly not run on timeout");
    assert.ok(detailText.includes("process tree killed"));

    // Invalid comparison detail: the tamper reason is visible and named
    await page.goto(`${viewer.url}/#/exp/${tamperReport.experimentId}`, { waitUntil: "networkidle0" });
    detailText = await page.evaluate(() => document.body.textContent ?? "");
    assert.ok(detailText.includes("Comparison not valid"), "invalid banner shown");
    assert.ok(detailText.includes("verifier files were modified"), "tamper reason named");
    assert.ok(detailText.includes("excluded from comparison"));

    // API rejects malformed experiment ids (path traversal guard)
    const badId = await page.evaluate(async () => {
      const r = await fetch("/api/experiments/..%5C..%5Cetc");
      return r.status;
    });
    assert.equal(badId, 400, "encoded traversal id must be rejected");

    // Keyboard-only: Tab reaches interactive controls in DOM order
    await page.goto(`${viewer.url}/#/exp/${report.experimentId}`, { waitUntil: "networkidle0" });
    const tabWalk = await page.evaluate(() => {
      const focusables = Array.from(document.querySelectorAll("a[href], button:not([disabled])"));
      const first = focusables[0] as HTMLElement;
      first.focus();
      return { total: focusables.length, activeIsControl: document.activeElement === first };
    });
    assert.ok(tabWalk.total >= 6, `expected several keyboard-reachable controls, got ${tabWalk.total}`);
    assert.ok(tabWalk.activeIsControl);

    // Responsive layout: the report remains usable without horizontal page overflow,
    // and evidence actions retain a touch-friendly target at a narrow viewport.
    await page.setViewport({ width: 390, height: 844 });
    await page.reload({ waitUntil: "networkidle0" });
    const mobileLayout = await page.evaluate(() => {
      const evidence = document.querySelector(".evidence-link");
      return {
        pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        evidenceHeight: evidence ? Number.parseFloat(getComputedStyle(evidence).minHeight) : 0,
      };
    });
    assert.ok(mobileLayout.pageFits, "mobile report has no horizontal page overflow");
    assert.ok(mobileLayout.evidenceHeight >= 40, "evidence controls keep a 40px minimum target");
    await page.setViewport({ width: 1280, height: 900 });

    // Screenshots as local evidence
    await page.goto(`${viewer.url}/#/exp/${report.experimentId}`, { waitUntil: "networkidle0" });
    const artifacts = path.join(repo, "artifacts");
    const { mkdir } = await import("node:fs/promises");
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
