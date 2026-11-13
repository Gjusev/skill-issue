# NOTES.md — engineering notes for the leaderboard batch mode (project 3B)

Branch `feature/leaderboard-batch`. Companion to `CONTINUE.md` and the research doc
`docs/planning/3A-skills-leaderboard-plan.md` (local-only; `docs/` is gitignored).

## Decisions and why

- **Reuse the engine, don't fork it.** `batch` generates a `TaskSpec` per (skill, task) and calls `runExperiment`. That inherits identical-starting-bytes workspaces, per-run isolation, the external hashed verifier, and `invalid_comparison` marking for free. One JSONL row per `RunRecord`.
- **YAML without dependencies.** The repo is dependency-free; `src/leaderboard/manifest.ts` implements the manifest's YAML subset (nested maps, lists of maps, block scalars, quoted strings, comments) and hard-errors on anything else. The real manifest is itself a parser test.
- **Security gate scans markdown fences.** Prose URLs are common in legit skills; URLs inside code fences are instructions the agent may follow, so they're scanned. Secrets are refused even in prose. Localhost URLs are exempt (fixture-server tasks) and the exemption is switchable.
- **Two-phase batch.** Phase 1 security-gates ALL skills and records refusals before any run; phase 2 runs within `--max-runs`. Earlier single-loop design dropped later refusals when the budget stopped early — the results file must always explain what was refused and why.
- **`--max-runs` is coarse on purpose.** It refuses to start an experiment that would exceed the cap rather than truncating repetitions, because a truncated experiment produces an invalid paired comparison.
- **Refusals are rows, not log lines.** They use `success: null` + `error: "refused by security gate: …"`, so `--resume` skips them, reliagate counts them as abstentions (never failures), and the site shows them per skill.
- **Spec ids are kebab.** `runExperiment`'s spec validation requires `^[a-z0-9][a-z0-9-]*$`, so spec id = `skill-task` while the JSONL `task_id` = `skill/task` (one global namespace).
- **Reliagate is a subprocess boundary.** `SKILL_ISSUE_RELIGATE_CMD` (default `python3 -m reliagate.cli`) + `SKILL_ISSUE_RELIGATE_HOME` (added to PYTHONPATH, default `/root/reliagate`) make it work from a clone or a pip install. Gate exit 3 (or an unparseable report) degrades to verdict "no data" — never to a guessed verdict. Wilson CIs are requested from `reliagate.metrics` through a small python subprocess; if python/reliagate is absent they render as "CI n/a".
- **Verdict contract.** `helps` = McNemar p < alpha AND new consistently-solved fraction > baseline. `hurts` = significant and lower. Everything else, including a tiny-but-significant gain in the wrong direction or an infra error, is "no evidence" / "no data". k=5 per task means almost everything will honestly be "no evidence" — that is the expected first-increment result (OpenSkillEval's prior).
- **Reliagate JSONL projection.** Leaderboard rows are projected to `{task_id, attempt, success, version, metadata}`; `version` is `baseline` for baseline rows and the pinned skill commit for skill rows.

## Known limits (inherited + new)

- The harness isolates configuration, not the machine. The security gate is a deny-by-pattern scan, not a sandbox; run real batches in a disposable container/VM.
- The `claude-code` runner parses `stream-json` for tokens/costs; `cost_estimate` stays null when the provider doesn't report it (never estimated).
- No Codex runner exists yet; that's deferred to a validated implementation behind `src/runners/types.ts` (see CONTINUE.md).
- All 45 manifest tasks are `status: designed`. The batch skips designed tasks (no phantom rows) — implementing seeds + verifiers is the next work item, one increment at a time.
- Pinned commits were captured 2026-11-12 from the GitHub API. Skills drift; re-pin and re-run on drift before publishing any table.
