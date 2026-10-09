---
name: skill-issue
description: Use when the user wants to know whether a specific skill actually helps an agent on a concrete task — preparing a baseline-vs-skill comparison, running it with the skill-issue harness, or interpreting its report (activation evidence, verifier result, timing and token metrics). Also for "does this skill do anything?", "A/B test my skill", "skill made no difference". Not for writing or installing skills, not for general benchmark rankings, and not for summarizing SKILL.md files.
---

# Skill Issue — does the skill change the result?

You are helping the user run an honest local comparison: the same task, twice —
once without a skill (baseline), once with it — under identical conditions,
then reading the evidence. The harness is a CLI in the Skill Issue repository
(`skill-issue`). Find it first: it is either the current working directory, or
a clone the user points you to. All commands below assume its root as cwd and
Node.js ≥ 22.18.

**Do not start here for anything else.** If the user only wants a skill
written, installed, or summarized, this skill does not apply — say so and stop.

## The flow

1. **Frame the task.** One bounded task, one repository-or-fixture of starting
   files, one *observable* success criterion the agent cannot fake (a file
   with exact content, a check that exits 0, a test that passes). If the
   criterion is subjective ("better code"), stop and negotiate a checkable one
   with the user before anything else.
2. **Write the three pieces** (see `references/experiment-contract.md` for the
   full schema):
   - starting workspace: a directory whose bytes are the task's initial state;
   - verifier: a script outside that workspace that exits 0 only when the
     criterion holds;
   - TaskSpec JSON: prompt + paths + limits. Scaffold them with
     `node src/cli.ts init <dir>` (creates a working fixture-runner comparison
     you then edit), or start from `examples/tasks/release-notes.fixture.json`.
3. **Preview without spending anything.** `validate` and `prepare` never touch
   a model:
   ```bash
   node src/cli.ts validate path/to/task.json
   node src/cli.ts prepare path/to/task.json
   ```
   Fix every reported error before continuing.
4. **Get explicit confirmation, then run.** Executing a real agent consumes the
   user's model usage. State what will run, how many times, and the limits
   (timeout per run, budget flag), then run only after the user agrees:
   ```bash
   node src/cli.ts run path/to/task.json --data-dir runs
   ```
   For infra/testing without any model, use a spec whose `agent.runner` is
   `"fixture"` (deterministic simulated agent — proves the harness, never a
   skill's real effect).
5. **Show and interpret.** Open `node src/cli.ts viewer --data-dir runs` and
   read the result by the rules in `references/interpreting-reports.md`.

## Hard rules when interpreting

- Never declare a skill "better", "best" or "superior" from one repetition or
  one experiment. Say what happened in these runs, nothing more.
- `installed`, `observed read` and `task passed` are three different facts.
  Report them separately, exactly as the viewer labels them.
- Missing tokens/cost mean *not measured*. Never present them as 0, and never
  estimate them.
- `infrastructure_error` is a harness/provider problem — it is not evidence
  the agent failed the task, and not evidence about the skill.
- If the report says the comparison is invalid (different starting bytes,
  configuration drift, verifier tampered), the run proves nothing about the
  skill. Say that plainly and re-run a valid one if asked.
- A fixture run validates the pipeline only. Never present it as a real-agent
  result.

## Limits to state out loud

- One comparison is descriptive, not statistical. Fewer than ~3 repetitions of
  each variant cannot support a superiority claim.
- The harness isolates configuration (fresh config dir, project-only settings)
  but the machine is not a sandbox; run only tasks and skills you trust.
- Token/cost numbers appear only when the runner reports them.

## References

- `references/experiment-contract.md` — TaskSpec and RunRecord fields, states,
  evidence levels, and what each one does and does not prove.
- `references/interpreting-reports.md` — worked wording for common report
  shapes, including the no-metrics and invalid-comparison cases.
