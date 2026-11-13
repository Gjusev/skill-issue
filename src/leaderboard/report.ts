/**
 * Report step: group the results JSONL by skill, run the per-skill paired
 * comparison through the reliagate CLI (src/leaderboard/stats.ts) and render
 * the static site (src/leaderboard/site.ts).
 *
 * Works on empty and partial data: skills without rows still appear with
 * "no data" verdicts, and the site renders "no data yet" states.
 */
import path from "node:path";
import { loadManifest } from "./manifest.ts";
import { readRows, type LeaderboardRunRow } from "./rows.ts";
import { computeSkillStat, type ReliagateOptions, type SkillStat } from "./stats.ts";
import { renderSite, type SiteData, type SiteSkillRow } from "./site.ts";
import { writeFile } from "node:fs/promises";

export interface ReportOptions extends ReliagateOptions {
  manifestPath: string;
  /** Override the results JSONL path (default: manifest results key). */
  rowsFile?: string;
  /** Output dir for the static site (default: leaderboard/site next to the manifest). */
  siteDir?: string;
  /** Repetition count shown in the site header (default: manifest k). */
  k?: number;
}

export interface ReportResult {
  stats: SkillStat[];
  siteDir: string;
  files: string[];
  rowsFile: string;
  totalRuns: number;
}

export async function generateReport(opts: ReportOptions): Promise<ReportResult> {
  const loaded = await loadManifest(opts.manifestPath);
  if (!loaded.ok || !loaded.manifest) {
    throw new Error(`invalid manifest:\n- ${loaded.errors.join("\n- ")}`);
  }
  const manifest = loaded.manifest;
  const baseDir = loaded.baseDir;
  const rowsFile = path.resolve(opts.rowsFile ?? path.join(baseDir, manifest.results));
  const siteDir = path.resolve(opts.siteDir ?? path.join(baseDir, "site"));
  const { rows, errors } = await readRows(rowsFile);
  if (errors.length > 0) {
    throw new Error(`results file has invalid rows:\n- ${errors.join("\n- ")}`);
  }

  const stats: SkillStat[] = [];
  const siteSkills: SiteSkillRow[] = [];
  for (const skill of manifest.skills) {
    const skillRows: LeaderboardRunRow[] = rows.filter((r) => r.skill_id === skill.id);
    const stat = await computeSkillStat(skillRows, { id: skill.id, commit: skill.commit }, opts);
    stats.push(stat);
    const refusalRow = skillRows.find((r) => typeof r.error === "string" && r.error.startsWith("refused by security gate"));
    siteSkills.push({
      id: skill.id,
      repo: skill.repo,
      license: skill.license,
      commit: skill.commit,
      installs: skill.installs ?? null,
      excluded: skill.excluded ? (skill.excludedReason ?? "excluded") : null,
      tasks: skill.tasks.length,
      tasksWithData: stat.tasksWithData,
      runs: skillRows.length,
      baseline: { successes: stat.baseline.successes, total: stat.baseline.total, ci: stat.baseline.ci },
      skill: { successes: stat.skill.successes, total: stat.skill.total, ci: stat.skill.ci },
      verdict: stat.verdict,
      costDeltaUsd: stat.costDeltaUsd,
      pValue: stat.pValue,
      refusalReason: refusalRow ? (refusalRow.error ?? null) : null,
      runsDetail: skillRows,
    });
  }

  const data: SiteData = {
    generatedAt: new Date().toISOString(),
    name: manifest.name,
    harness: manifest.harness,
    k: opts.k ?? manifest.k,
    skills: siteSkills,
    totalRuns: rows.length,
  };
  const { files } = await renderSite(data, siteDir);
  const statsFile = path.join(siteDir, "stats.json");
  await writeFile(statsFile, JSON.stringify({ generatedAt: data.generatedAt, stats }, null, 2) + "\n", "utf8");
  files.push(statsFile);

  return { stats, siteDir, files, rowsFile, totalRuns: rows.length };
}
