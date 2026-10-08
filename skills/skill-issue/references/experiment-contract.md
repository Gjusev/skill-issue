# Experiment contract

Data shapes understood by the `skill-issue` CLI. Everything here is local and
versioned; nothing is uploaded anywhere.

## TaskSpec (input, written by you)

```jsonc
{
  "specVersion": 1,
  "id": "kebab-case-id",
  "description": "one line, shown in the viewer",
  "task": {
    "prompt": "the exact request given to the agent in BOTH variants",
    "workspaceCopyFrom": "path/to/dir-with-the-starting-files"   // relative to the spec file
  },
  "verifier": {
    "copyFrom": "path/to/verifier-dir",        // copied OUTSIDE the workspace before the agent runs
    "command": ["node", "verify.mjs"],         // cwd = verifier copy; {workspace} placeholder allowed
    "timeoutMs": 20000,
    "successCriteria": "human-readable observable criterion"
  },
  "skill": { "name": "the-skill", "path": "path/to/dir-containing-SKILL.md" },
  "agent": {
    "runner": "claude-code",                   // or "fixture" (simulated, no model)
    "model": "sonnet", "effort": "low",        // optional, applied to BOTH variants
    "permissions": "acceptEdits"               // or "bypass" for tasks that need commands (trusted fixtures only)
  },
  "limits": {
    "timeoutMsPerRun": 300000,
    "maxBudgetUsd": 0.25,                      // passed to the runner's budget flag; not a hard guarantee
    "repetitions": 1
  }
}
```

Rules that make the comparison fair:

- The prompt, model, effort, permissions, limits and starting bytes are
  identical across variants; the ONLY difference is the skill directory
  installed at `<workspace>/.claude/skills/<name>/` in the skill variant.
- The verifier never runs from inside the agent's workspace and is hashed
  before and after each run. If its bytes change, the run is marked
  `invalid_comparison`.
- The agent must not be shown the expected answers. Put private expectations
  in the verifier, not in the prompt.

## RunRecord (output, written by the engine)

Per variant and repetition you get:

- `status`: `passed` | `failed` | `timeout` | `cancelled` |
  `infrastructure_error` | `invalid_comparison`
  - `passed`/`failed` describe the **verifier's observation**, not the agent's
    opinion (agents never grade themselves here).
  - `timeout`/`cancelled` mean the process tree was killed.
  - `infrastructure_error` means the harness or provider broke (spawn failure,
    auth error, corrupt output stream). It says nothing about the task.
  - `invalid_comparison` means a comparability precondition failed; the run
    cannot be used as evidence about the skill.
- `skillEvidence`:
  - `installed` — engine verified SKILL.md exists in the run's workspace
    config. Claims nothing about reading or following.
  - `observedRead` — the run's event stream shows a `Skill` tool_use naming
    the skill, or a Read/Edit on its files. Claims nothing about following.
  - Following the skill is measured only by the verifier, as a task outcome.
- `metrics`: `durationMs` is engine-measured wall clock. `tokensIn`,
  `tokensOut`, `costUsd`, `turns` are `null` when the runner did not report
  them — null means *not measured*, never zero.
- `changes`: files created/modified/deleted, excluding the skill config dir.
- `hashes`: task spec, initial workspace (excluding the skill install),
  skill tree, verifier before/after.

## Fixture runner

`agent.runner: "fixture"` executes scripted steps (`writeFile`, `readSkill`,
`invokeSkill`, `sleep`, `emit`, `metrics`, `exit`) through the same engine and
parser as the real runner. It exists to test the harness deterministically and
to demo the flow without models. A fixture result is never evidence about a
real agent or skill.

## Where data lands

`<dataDir>/experiments/<experimentId>/` (default `runs/`, gitignored):
`experiment.json` (full report), `variants/<variant>-r<N>/workspace/` (the
actual workspaces, kept for inspection), `verifier/` (the executed copy),
`export.json` (after `node src/cli.ts export <experimentDir>`).

The sanitized export excludes by default: prompt text (kept as a hash), raw
event traces, agent output, absolute paths, environment details.
