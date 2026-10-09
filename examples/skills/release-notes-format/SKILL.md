---
name: release-notes-format
description: Use when writing RELEASE_NOTES.md or any release summary from project notes. Prescribes the exact section structure and entry format the project expects.
metadata:
  internal: true
---

# Release notes format

When asked to write release notes for this project:

1. Read the notes source referenced by the task (e.g. `notes.md`).
2. Create or update `RELEASE_NOTES.md` with exactly three level-2 sections, in this order:
   - `## Changelog`
   - `## Known Issues`
   - `## Roadmap`
3. Under each section, write one bullet per item, phrased as a short factual line.
4. Classify items from the notes: user-visible changes go to Changelog, known
   problems to Known Issues, planned work to Roadmap.
5. Do not add other sections, titles, commentary, or a table of contents.
