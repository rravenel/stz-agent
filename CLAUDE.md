# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

stz-agent is a "Scale to Zero" cloud agent architecture. Infrastructure is defined with the AWS CDK in Python (Python 3.12, `aws-cdk-lib` v2) and deploys to `us-west-2`. The stack is still the CDK scaffold, and no resources are defined yet.

## Commands

Always activate the venv first: `source .venv/bin/activate`. Dependencies are in `requirements.txt` (CDK libs) and `requirements-dev.txt` (pytest).

- `pytest`: run all unit tests
- `pytest tests/unit/test_stz_agent_stack.py::test_sqs_queue_created`: run a single test
- `cdk synth`: synthesize CloudFormation, which runs `python3 app.py` (fast way to check the app builds)
- `cdk diff`, `cdk deploy`, `cdk destroy`: compare, deploy, or delete *your own* stack
- `aws sso login --profile stz-dev`: refresh credentials when the 8-hour SSO session expires

`cdk.json` sets `"profile": "stz-dev"`, so `cdk` commands use it automatically. Plain `aws` commands need `--profile stz-dev` or `AWS_PROFILE=stz-dev`. The account is already CDK-bootstrapped, so don't run `cdk bootstrap`.

### Scripts (agents use these, not the raw commands)

`scripts/` wraps every build and test step so only failures reach your context: one line per step, and an excerpt plus a log path under `.logs/` on failure. Run them from the repo root.

- `scripts/setup.sh`: venv and npm installs. A person runs it, because agent sandboxes can't install packages.
- `scripts/check.sh`: build and all tests, the verification command. It ends with `CHECK OK` or `CHECK FAILED`.
- `scripts/build.sh`, `scripts/test.sh [all|py|ts] [args]`: the two halves of `check.sh`.
- `scripts/deploy.sh [env]`: build and deploy your stack. It needs AWS credentials, so a person runs it.

## Work tracking

Work is tracked as markdown issues in `issues/`, split into two tracks so two teams can work in parallel without conflicts. Read `issues/Issues.md` before picking up work: it covers the tracks, which paths each track owns, the plan → implement → review workflow, and the rule that scripts run in a Haiku subagent. Use `scripts/next-issue.py A|B` to pick the next issue.

## Architecture

- `app.py` is the CDK entry point. It creates exactly one `StzAgentStack`, named `StzAgent-<env>`. `env` comes from CDK context (`-c env=<name>`) and defaults to the OS username (`getpass.getuser()`), so each developer deploys an isolated copy. It must match `[a-zA-Z][a-zA-Z0-9-]{0,30}`. The shared demo stack is `-c env=demo`.
- The stack's account and region come from `CDK_DEFAULT_ACCOUNT`/`CDK_DEFAULT_REGION`, which the CLI fills in from the active profile. Nothing is hardcoded.
- Every stack is tagged `project=stz-agent` and `env=<env>`.
- `stz_agent/stz_agent_stack.py` (`StzAgentStack`) is where resources go.
- Tests in `tests/unit/` synthesize the stack with `aws_cdk.assertions.Template.from_stack` and assert on resource properties. The existing test is a placeholder that makes no assertions yet.

## Cautions

- `cdk deploy`/`cdk destroy` without `-c env=...` target the stack for the current OS user. Passing `-c env=demo` targets the shared demo stack, so confirm before deploying or destroying it.
- AWS SSO: Identity Center is in `us-east-2`, but resources live in `us-west-2`.

## GitHub

- The repo is `rravenel/stz-agent` (remote `origin`, over SSH), and the default branch is `main`. Use the `gh` CLI for issues and PRs. It's already authenticated.
- Reading GitHub (listing or viewing issues, PRs, diffs, checks) is fine anytime.
- Ask before anything that posts or changes GitHub issues or PRs: opening, editing, commenting on, labeling, closing or merging them. Show what will be posted first.
- The main checkout stays on `main`. Each issue is worked on its own branch in a git worktree (`.worktrees/NNNN-short-name`). Only a change that has passed review is merged to `main` and pushed, by the reviewer, following `issues/Issues.md` ("Workspaces and git"). No other pushes, and never force-push.
