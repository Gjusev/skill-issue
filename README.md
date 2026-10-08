# Skill Issue

Do your skills help the agent, or just take up context?

Skill Issue is a local, open-source harness that runs **the same task twice —
once without a skill (baseline), once with it — under identical conditions**,
and shows you the evidence: whether the skill was installed and actually read,
what an independent verifier observed, what changed, and the time/token
measurements the runner provides. No accounts, no backend, nothing uploaded.

It makes **descriptive comparisons**, not rankings. One run answers "what
happened here?", never "which skill is best".

## What you get

- A CLI (`src/cli.ts`) that validates, previews, runs, reports and exports
  experiments defined by a versioned `TaskSpec`.
- Two runners:
  - `claude-code` — real Claude Code CLI in headless mode, with isolated
    configuration per run (fresh `CLAUDE_CONFIG_DIR`, project-only settings,
    no machine MCP/plugins/skills), so the baseline is not contaminated.
  - `fixture` — a deterministic simulated agent for testing the harness and
    demoing the flow without any model.
- An independent verifier per task: it runs outside the agent's workspace, is
  hashed before and after each run, and its exit code decides pass/fail. The
  agent never grades itself.
- A local web viewer (`node src/cli.ts viewer`) with side-by-side variants,
  activation evidence (installed ≠ read ≠ followed), change lists, and
  measurements where absent numbers read "not measured", never 0.
- A sanitized, shareable export that excludes prompts, raw traces and
  absolute paths by default.
- A skill (`skills/skill-issue/`) that teaches an agent to prepare, run and
  interpret these comparisons honestly.

## Requirements

- Node.js ≥ 22.6 (runs the TypeScript source natively; no build step).
- The real runner additionally needs the `claude` CLI installed and
  authenticated.

## Quick start

```bash
npm install
npm test                # engine, runners, sanitization, comparability (no model, no keys)
npm run test:e2e        # viewer in a real browser (needs a local Edge/Chrome; skips honestly if absent)

# Fixture demo end to end — no model involved:
node src/cli.ts validate examples/tasks/release-notes.fixture.json
node src/cli.ts run examples/tasks/release-notes.fixture.json
node src/cli.ts viewer  # open http://127.0.0.1:4173
```

The fixture demo compares a "release notes" task with and without the example
`release-notes-format` skill: the scripted baseline writes free-form notes and
fails the verifier; the skill variant reads the skill and passes. That demo
exercises the whole pipeline — it is not evidence about real agents.

To compare with a real agent (consumes model usage; explicit action):

```bash
node src/cli.ts prepare examples/tasks/release-notes.claude-code.json
node src/cli.ts run examples/tasks/release-notes.claude-code.json
```

## Commands

| command | what it does | model? |
|---|---|---|
| `validate <spec>` | check a TaskSpec and its paths | no |
| `prepare <spec>` | show the execution plan and limits | no |
| `run <spec>` | execute the experiment | yes, unless the runner is `fixture` |
| `report <experimentDir>` | text summary of an experiment | no |
| `export <experimentDir>` | write the sanitized shareable export | no |
| `viewer [--data-dir] [--port]` | serve the local web viewer | no |

## Definitions the tool is strict about

- **Installed** — SKILL.md exists in the run's workspace config (engine-checked).
- **Observed read** — the run's event stream shows the skill invoked or read.
- **Verifier passed** — an independent script observed the success criterion.
  These are three separate claims; the viewer labels them separately.
- **Not measured** — tokens/cost the runner did not report are shown as null,
  never as 0, never estimated.
- **Invalid comparison** — if starting bytes, configuration, or the verifier's
  integrity differ between variants, the records are marked invalid and are
  not presented as evidence about the skill.
- `infrastructure_error` is a harness/provider failure, not a task failure.

## Project layout

```
src/core/       engine, TaskSpec/RunRecord, hashing, sanitization, export
src/runners/    spawn+tree-kill, stream parser, fixture + claude-code runners
src/report/     local viewer server and UI
skills/skill-issue/   the distributable skill
examples/       synthetic task, verifier and example skill (public, no secrets)
fixtures/       test fixtures
tests/          unit/integration tests + browser e2e
```

## Scope and limits

- Descriptive comparison only; no statistical superiority claims from small n.
- The harness isolates *configuration*, not the machine: workspaces are plain
  directories. Run only tasks and skills you trust.
- The budget limit is passed to the runner's supported flag; the tool does not
  promise hard spend enforcement.
- Only the Claude Code runner is validated. Other CLIs are not claimed.

## Skill

See [`skills/skill-issue/SKILL.md`](skills/skill-issue/SKILL.md) — it guides
an agent through framing a verifiable task, previewing without cost, running
with explicit confirmation, and interpreting reports without overclaiming.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test (fixtures only, no keys)
npm run test:e2e    # browser e2e via puppeteer-core (local Edge/Chrome)
```

CI runs typecheck + tests on every push (`.github/workflows/ci.yml`); the
real-agent smoke test is intentionally not part of CI.

## License

MIT. See [LICENSE](LICENSE).
