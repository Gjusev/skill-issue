# Changelog

## 0.1.0 (2026-10-09)

First complete release.

- Two-variant comparison engine (baseline vs skill) with per-run isolated
  workspaces, hashed initial bytes, independent verifier (hashed before and
  after each run), and comparability finalization: contaminated or tampered
  runs are marked `invalid_comparison` instead of counted as evidence.
- Runners: `claude-code` (real CLI, headless, isolated `CLAUDE_CONFIG_DIR`,
  project-only settings, no machine MCP/plugins) and `fixture` (deterministic
  simulated agent, no model).
- Six record states with strict semantics; unavailable token/cost metrics
  stay null and render as "not measured".
- Local web viewer: side-by-side variants, separate activation evidence
  (installed / observed read / verifier), keyboard-operable evidence drawer,
  sanitized export endpoint.
- CLI: `init`, `validate`, `prepare`, `run`, `report`, `export`, `viewer`,
  `--version`. Process-tree timeout and cancellation (Windows taskkill /T,
  POSIX group kill).
- Distributable skill `skills/skill-issue/` with experiment contract and
  report-interpretation references.
- Tests: 75 unit/integration, 8 CLI end-to-end, browser e2e (local
  Edge/Chrome). Validated on Windows 11 and Ubuntu (WSL2). CI runs
  typecheck, unit and CLI e2e; the real-agent smoke stays opt-in and local.
- Known limits: descriptive comparisons only (no statistical claims), one
  real runner validated, configuration isolation is not a machine sandbox.
