# Changelog

## 0.1.3 (2026-10-09)

- Refined the local viewer with clearer experiment hierarchy, responsive
  evidence controls, touch-friendly targets, and reduced-motion support.
- Reworked the README around the no-cost fixture path, deliberate real-agent
  runs, and the limits of a descriptive comparison.
- Browser e2e now checks the narrow viewport has no horizontal page overflow
  and evidence controls retain a 40px minimum target.

## 0.1.2 (2026-10-09)

- Docs: universal skill install via `npx skills@latest add Gjusev/skill-issue`
  (verified end to end), README refresh on the npm page.

## 0.1.1 (2026-10-09)

- Fixed the published package's bin: Node forbids type stripping under
  node_modules, so the npm artifact now ships compiled `dist/` (tsc emit plus
  viewer assets and the fixture agent). The bin prefers `dist/cli.js` and
  falls back to `src/cli.ts` for git clones; a build step runs in CI.
  0.1.0 and 1.0.0 are deprecated (their bin crashes on install).

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
