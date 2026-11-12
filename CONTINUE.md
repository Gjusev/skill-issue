# CONTINUE.md — handoff for coding agents

## Where this stopped

v0.1.4 plus project 3B: the leaderboard batch mode (`feature/leaderboard-batch` branch, PR open, NOT merged). All machinery is built and offline-tested; NO real evaluation run has happened and NO real skill has been installed.

What exists now:

- `leaderboard/manifest.yaml` — 15 candidate skills from the research shortlist (`docs/planning/3A-skills-leaderboard-plan.md`, local-only — `docs/` is gitignored): repos, full 40-hex pinned commits (GitHub API, 2026-11-12), licenses, 3 deterministic task designs each (45 total). All tasks are `status: designed`; `remotion-best-practices` is `excluded` (license unresolved).
- `src/leaderboard/manifest.ts` — dependency-free YAML-subset parser + manifest validation.
- `src/leaderboard/sandbox.ts` — the security gate. Scans every skill file (markdown fence-aware) for network / shell-exec / secret patterns; refuses before any install. Localhost URLs inside fences are allowed (fixture-server tasks).
- `src/leaderboard/rows.ts` — the results JSONL row contract; `success: true | false | null` where null is an abstention (infra error / refusal), never a silent failure (reliagate convention).
- `src/leaderboard/batch.ts` — phase 1 security-gates every skill (refusals recorded with reasons even when the budget stops later), phase 2 runs admitted skills through the existing engine. `--resume` skips recorded (skill, task, variant, attempt) keys; `--max-runs` is a hard cap — an experiment that would exceed it is never started.
- `src/leaderboard/stats.ts` — per-skill paired comparison via the reliagate CLI subprocess (`gate --json`, exit codes 0/2/3 respected) + Wilson CIs via reliagate's Python library. NO statistics in TypeScript; if reliagate is unreachable, numbers degrade to null and the verdict becomes "no data".
- `src/leaderboard/site.ts` + `report.ts` — static site at `leaderboard/site/` (summary table + one page per skill with raw runs). Works on empty/partial data ("no data yet" states), offline.
- `.github/workflows/leaderboard.yml` — `workflow_dispatch` only; schedule line present but COMMENTED OUT with an owner-approval TODO; additionally gated on the `LEADERBOARD_SPEND_APPROVED` repo variable. Runs batch + report and opens a PR with changed results.
- Tests: `npm test` — 112 green, offline (fixture harness only; no skill installs, no agent runs). New files: `manifest.test.ts`, `leaderboard-rows.test.ts`, `sandbox.test.ts`, `batch.test.ts`, `reliagate.test.ts`, `site.test.ts`.

## Next steps (in order)

1. **Owner approves spend.** Nothing below happens without it. The first real increment is the research doc's recommendation: 8 skills x 2 tasks x k=5 = 160 runs ≈ **$10–19** (Claude-only, +30% overhead ≈ $13–25).
2. Implement the first increment's tasks: for each chosen task, create the workspace seed directory + verifier script + prompt, then flip its manifest entry to `status: implemented` (workspaceSeed, verifierDir, verifierCommand, prompt). Deterministic verifiers only — never an LLM judge.
3. Check out each chosen skill repo at its pinned commit into a local directory and set `skill.source` in the manifest. The security gate will refuse anything with network/shell/secret patterns; fix the task design or drop the skill — never weaken the gate to admit a skill.
4. Run the batch (see README section), then `leaderboard-report`, review the site, commit results + site, open a PR.
5. Deferred (documented, not built): a Codex runner (see NOTES.md — the runner interface is ready, the work is validating a second real CLI), container/VM-level sandboxing for skills that legitimately need to execute code, and the remaining 37 task implementations.

## Non-negotiable constraints

- **No real runs without owner approval.** `batch` with the `claude-code` harness consumes model usage. The offline machinery must stay runnable with `--harness fixture` and in CI for free.
- **Live endpoint policy (owner rule).** All live agent runs go through the Z.ai Coding Plan ONLY: base `https://api.z.ai/api/coding/paas/v4`, model `glm-5.3-flash` (pinned — never glm-4.6 or anything else in code/docs/examples), key from env (e.g. `SKILL_ISSUE_ZAI_KEY`). On a billing or endpoint error: STOP and report — never fall back to another provider or pay-per-call.
- **No statistics in TypeScript.** pass^k, McNemar, Wilson CIs live in reliagate (github.com/Gjusev/reliagate). skill-issue writes JSONL reliagate consumes and invokes the reliagate CLI as a subprocess. Don't copy formulas across.
- **Abstentions are never failures.** `success: null` (infra error, refusal) counts in n, never in a verdict. Verdict "helps" ONLY when reliagate's paired test is significant AND in the positive direction.
- **Deterministic verifiers only.** Every leaderboard task checks a file / test run / lint / ffprobe / schema / fixture-server state. Never an LLM judge, never a "vibe check".
- **License discipline.** Skills without a verifiable license stay `excluded`. For `anthropics/skills` (repo-level None, per-skill Apache-2.0 LICENSE.txt) publish hashes + URLs only and re-check at publication time.
- **No AGENTS.md** — this CONTINUE.md is the handoff artifact; keep it current.
- Conventional commits in English; git user Gjusev <yoa.yoa91@gmail.com>.

## How to verify your work

```bash
cd /root/work/skill-issue-leaderboard
npm ci
npm run typecheck   # tsc, must stay clean
npm test            # 112 tests, offline, fixture-only
npm run build       # dist must compile
node src/cli.ts leaderboard-report --manifest leaderboard/manifest.yaml   # renders the empty-data site, no model
```

There is no Codex runner yet. `skill-issue`'s runner interface (`src/runners/types.ts`) is the extension point; scaffold behind `createCodexRunner()` only if validated against the real CLI — do not ship an untested stub.
