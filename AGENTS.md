# AGENTS.md

Instructions for coding agents (Codex, OpenCode, Claude Code and others) working in this repository.

**`CLAUDE.md` is the source of truth.** Read it in full before you start: it covers the project, commands, architecture, cautions and GitHub rules, and they apply to every agent, not only Claude. This file only repeats the parts you must not miss. If the two files disagree, follow `CLAUDE.md` and fix this file.

## Must-knows

- **Work tracking:** issues live in `issues/`. Read `issues/Issues.md` before you pick anything up. It defines the two tracks (A: infra and plumbing, B: the Prime harness), which paths each track owns, and the plan → implement → review workflow. Pick work with `scripts/next-issue.py A|B`, and edit only the paths your track owns.
- **Build and test only through `scripts/`.** Use `scripts/check.sh` to verify (it must end with `CHECK OK`), and `scripts/test.sh [py|ts]` while iterating. Don't run `pytest`, `npm test`, `tsc` or `cdk` directly: the scripts print only failures, and full logs go to `.logs/`.
- **People-only steps:** `scripts/setup.sh` (installing dependencies) and anything that needs AWS (`scripts/deploy.sh`, the spikes, the demo). Agents have no AWS credentials, so mark these steps **Needs owner:** in the issue.
- **Git:** one branch per issue (`track-a/NNNN-…` or `track-b/NNNN-…`). Never push to `main`. Ask before pushing or posting anything to GitHub.
- **Shared demo stack:** never deploy or destroy `-c env=demo` without explicit confirmation.

<!-- Stub: extend as the project grows. Keep CLAUDE.md authoritative. -->
