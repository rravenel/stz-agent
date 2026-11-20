# AGENTS.md

Instructions for every coding agent working in this repository (Claude Code, Codex, OpenCode and others). This is the single source of truth for agent instructions: `CLAUDE.md` only imports this file.

## Project

stz-agent is a "Scale to Zero" cloud agent architecture. Infrastructure is defined with the AWS CDK in Python (Python 3.12, `aws-cdk-lib` v2) and deploys to `us-west-2`. The Lambda functions (Doorman, Prime, Com) are TypeScript in `functions/`. The stack is still the CDK scaffold, and no resources are defined yet.

## Must-knows

- **Work tracking:** issues live in `issues/`. Read `issues/Issues.md` before you pick anything up. It defines the tracks (A: infra and plumbing, B: the Prime harness, plus the cross-track `I` build-infrastructure milestone), which paths each track owns, and the plan → implement → review workflow. Pick work with `scripts/next-issue.py A|B|I`, and edit only the paths your track owns.
- **Build and test only through `scripts/`.** Use `scripts/check.sh` to verify (it must end with `CHECK OK`), and `scripts/test.sh [py|ts]` while iterating. Don't run `pytest`, `npm test`, `tsc` or `cdk` directly: the scripts print only failures, and full logs go to `.logs/`. The verification of record for a review is a `scripts/check.sh` run by the team's Checker agent (Haiku); see `issues/Issues.md` ("Scripts").
- **People-only steps:** `scripts/setup.sh` and `scripts/lock.sh` (installing and locking dependencies; never hand-edit a lock file) and anything that needs AWS (`scripts/deploy.sh`, the spikes, the demo). Agents have no AWS credentials, so mark these steps **Needs owner:** in the issue.
- **Git:** the main checkout stays on `main`. Work each issue in its own worktree and branch (`.worktrees/NNNN-…`, branch `track-a/NNNN-…`, `track-b/NNNN-…` or `infra/NNNN-…`). Only a reviewed change is merged to `main` and pushed. Never force-push.
- **Shared demo stack:** never deploy or destroy `-c env=demo` without explicit confirmation.

## Scripts

`scripts/` wraps every build and test step so only failures reach your context: one line per step, and an excerpt plus a log path under `.logs/` on failure. Run them from the repo root.

- `scripts/setup.sh`: venv and npm installs, exactly from the lock files. A person runs it, because agent sandboxes can't install packages.
- `scripts/lock.sh [--upgrade]`: re-resolve `requirements.lock` and `functions/package-lock.json` after a dependency change, then run setup. A person runs it; commit the lock files with the change.
- `scripts/check.sh`: build and all tests, the verification command. It ends with `CHECK OK` or `CHECK FAILED`.
- `scripts/build.sh`, `scripts/test.sh [all|py|ts] [args]`: the two halves of `check.sh`.
- `scripts/deploy.sh [env]`: build and deploy your stack. It needs AWS credentials, so a person runs it.

## Dependencies and toolchain

Direct dependencies are in `requirements.txt` (CDK libs), `requirements-dev.txt` (pytest) and `functions/package.json`. `requirements.lock` pins every Python package with hashes and is what gets installed; `functions/package-lock.json` is installed with `npm ci`. The toolchain is pinned by `.python-version` (3.12, enforced) and `.nvmrc` (Node 22, warned). The CDK CLI is pinned in `functions/package.json` (`functions/node_modules/.bin/cdk`), not installed globally.

## Raw commands (for people)

Agents use the scripts above. For a person at a terminal, with the venv active (`source .venv/bin/activate`):

- `pytest`, or `pytest tests/unit/test_stz_agent_stack.py::test_sqs_queue_created` for one test
- `functions/node_modules/.bin/cdk synth|diff|deploy|destroy`: synthesize, compare, deploy or delete *your own* stack (`cdk.json`'s `python3 app.py` needs the venv active)
- `aws sso login --profile stz-dev`: refresh credentials when the 8-hour SSO session expires

`cdk.json` sets `"profile": "stz-dev"`, so `cdk` commands use it automatically. Plain `aws` commands need `--profile stz-dev` or `AWS_PROFILE=stz-dev`. The account is already CDK-bootstrapped, so don't run `cdk bootstrap`.

## Architecture

- `app.py` is the CDK entry point. It creates exactly one `StzAgentStack`, named `StzAgent-<env>`. `env` comes from CDK context (`-c env=<name>`) and defaults to the OS username (`getpass.getuser()`), so each developer deploys an isolated copy. It must match `[a-zA-Z][a-zA-Z0-9-]{0,30}`. The shared demo stack is `-c env=demo`.
- The stack's account and region come from `CDK_DEFAULT_ACCOUNT`/`CDK_DEFAULT_REGION`, which the CLI fills in from the active profile. Nothing is hardcoded.
- Every stack is tagged `project=stz-agent` and `env=<env>`.
- `stz_agent/stz_agent_stack.py` (`StzAgentStack`) is where resources go.
- Tests in `tests/unit/` synthesize the stack with `aws_cdk.assertions.Template.from_stack` and assert on resource properties. The existing test is a placeholder that makes no assertions yet.
- The design is in `docs/spec.md` and `docs/protocol.md`.

## Cautions

- `cdk deploy`/`cdk destroy` without `-c env=...` target the stack for the current OS user. Passing `-c env=demo` targets the shared demo stack, so confirm before deploying or destroying it.
- AWS SSO: Identity Center is in `us-east-2`, but resources live in `us-west-2`.

## GitHub

- The repo is `rravenel/stz-agent` (remote `origin`, over SSH), and the default branch is `main`. Use the `gh` CLI for issues and PRs. It's already authenticated.
- Reading GitHub (listing or viewing issues, PRs, diffs, checks) is fine anytime.
- Ask before anything that posts or changes GitHub issues or PRs: opening, editing, commenting on, labeling, closing or merging them. Show what will be posted first.
- The main checkout stays on `main`. Each issue is worked on its own branch in a git worktree (`.worktrees/NNNN-short-name`). Only a change that has passed review is merged to `main` and pushed, by the reviewer, following `issues/Issues.md` ("Workspaces and git"). No other pushes, and never force-push.
