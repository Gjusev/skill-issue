# Skill Issue

Do your skills help the agent, or just take up context?

Skill Issue runs the same task twice, once without a skill (the baseline) and once with it, under identical conditions. Then it shows you what happened: whether the skill was installed and read, what an independent verifier observed, which files changed, and whatever time and token numbers the runner reports. Everything runs on your machine. There is no account, no backend, and nothing leaves it.

One run answers "what happened here?" It cannot answer "which skill is best", and the tool does not pretend otherwise. A single comparison is one observation, and the report says so.

## What is in the box

The CLI (`src/cli.ts`) validates, previews, runs, reports and exports experiments defined by a versioned `TaskSpec`. Two runners can execute them:

- `claude-code`: the real Claude Code CLI, headless. Each run gets its own empty `CLAUDE_CONFIG_DIR`, project-only settings and no machine MCP servers or plugins, so the baseline is not contaminated by whatever is installed on your machine.
- `fixture`: a scripted agent with no model. It speaks the same stream format as the real one, which makes it useful for testing the harness and demoing the flow without spending anything.

Every task gets an independent verifier: a script that runs outside the agent's workspace, is hashed before and after each run, and decides pass or fail by its exit code. The agent never grades its own work.

A local web viewer (`node src/cli.ts viewer`) puts the variants side by side with activation evidence, change lists and measurements. Numbers the runner did not report read "not measured", never 0. The shareable export strips prompts, raw traces and absolute paths by default and keeps hashes instead.

The skill in `skills/skill-issue/` teaches an agent to prepare, run and read these comparisons without overclaiming.

## Requirements

Node.js 22.6 or newer (the TypeScript source runs natively, there is no build step). The real runner also needs the `claude` CLI installed and authenticated.

## Quick start

```bash
npm install
npm test                # engine, runners, sanitization, comparability; no model, no keys
npm run test:e2e        # viewer in a real browser; needs a local Edge/Chrome, skips if absent

# Fixture demo, no model involved:
node src/cli.ts validate examples/tasks/release-notes.fixture.json
node src/cli.ts run examples/tasks/release-notes.fixture.json
node src/cli.ts viewer  # then open http://127.0.0.1:4173
```

The demo compares a "release notes" task with and without the example `release-notes-format` skill. The scripted baseline writes free-form notes and fails the verifier; the skill variant reads the skill and passes. That exercises the whole pipeline. It says nothing about real agents, and the report labels it as a fixture run.

To compare with a real agent (this consumes model usage, so it is an explicit step):

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

## The words the tool is strict about

| term | meaning |
|---|---|
| installed | SKILL.md exists in the run's workspace config; the engine checks this before the agent starts |
| observed read | the run's event stream shows the skill being invoked or read |
| verifier passed | an independent script observed the success criterion |

These are three separate claims and the viewer labels them separately. None of them implies the next one.

Token and cost fields the runner did not report are null, shown as "not measured", and never estimated. If starting bytes, configuration or verifier integrity differ between variants, the records are marked `invalid_comparison` and carry no weight as evidence. An `infrastructure_error` is a harness or provider problem, not a task failure.

## Project layout

```
src/core/       engine, TaskSpec/RunRecord, hashing, sanitization, export
src/runners/    spawn + tree kill, stream parser, fixture and claude-code runners
src/report/     local viewer server and UI
skills/skill-issue/   the distributable skill
examples/       synthetic task, verifier and example skill
fixtures/       test fixtures
tests/          unit and integration tests plus the browser e2e
```

## Scope and limits

Comparisons are descriptive. Claiming a skill is better needs several repetitions per variant and more than one task, and even then this tool will show you differences rather than statistics. The harness isolates configuration, not the machine: workspaces are plain directories, so run only tasks and skills you trust. The budget limit is passed to the runner's supported flag and is not a hard spend guarantee. Only the Claude Code runner has been validated; nothing here claims support for other CLIs.

## Skill

See [`skills/skill-issue/SKILL.md`](skills/skill-issue/SKILL.md). It walks an agent through framing a verifiable task, previewing without cost, running with explicit confirmation, and reading reports without inventing conclusions.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test, fixtures only, no keys
npm run test:e2e    # browser e2e via puppeteer-core with a local Edge/Chrome
```

CI runs typecheck and tests on every push (`.github/workflows/ci.yml`). The real-agent smoke test stays out of CI on purpose: it needs authentication and spends money.

## License

MIT. See [LICENSE](LICENSE).
