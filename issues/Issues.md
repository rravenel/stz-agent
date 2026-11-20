# stz-agent

Work tracker for the stz-agent hackathon PoC: a scale-to-zero AI agent harness on AWS Lambda (Doorman, Prime and Com functions in TypeScript, infrastructure in Python CDK, deployed to `us-west-2`). The design is in `docs/spec.md` and `docs/protocol.md`; when an issue and the docs disagree, the docs win and the issue gets a note. Issues here are mostly features to build, not bugs, so their titles describe what is missing.

## Two tracks, two teams (read this first)

The work follows the two parallel tracks in `docs/spec.md` §10. Each team's orchestrator works **only its own track**, so the two never edit the same files.

| Track | Owner | Milestones | Owns these paths (only this track edits them) |
|---|---|---|---|
| **A: infra and plumbing** | @rene and Rene's agents (A0: Elliot) | `A0` contracts, `A1` CDK + spike S2, `A2` comms worker, Com, Doorman, `A3` integration, `A4` client + cost report | `app.py`, `stz_agent/`, `tests/unit/`, `functions/package.json` and lockfile, `functions/tsconfig*.json`, `functions/shared/`, `functions/doorman/`, `functions/com/`, `client/`, `scripts/cost-report.ts` |
| **B: agent harness (Prime)** | @offwhite (Brennan) and Brennan's agents | `B1` spike S1, `B2` Prime REPL, loop and adapters, `B3` checkpoint and exit, `B4` demo run | `spikes/s1-quickjs/`, `functions/prime/` |

A0 is the exception: Elliot (@offwhite's agent) builds it, Track B reviews it, and then A1 and B1 start. Rules that keep the tracks out of each other's way:

- **Pick work with `scripts/next-issue.py A` (or `B`)**, not `list-issues.py --next`: the latter drains the earliest milestone across *both* tracks. `scripts/next-issue.py B --list` shows one track with what each issue waits on. `./scripts/list-issues.py` is still the overall status view.
- **`A0` is the only shared milestone.** It defines the contracts both tracks code against (`functions/shared/envelope.ts`, S3 keys, `state.json` types, the comms-worker interface and its in-memory fake). Track A builds it in the first ~20 minutes; Track B reviews it. After `A0` lands, a change to `functions/shared/` that Track B depends on needs a note on the Track B issue it affects.
- **Track B never edits Track A's paths, and vice versa.** If you need something there (a dependency, an env var on the Prime function, a stack output), file an issue in the other track's next milestone, reference it with "Depends on #NNNN", and work around it with the fake until it lands.
- **npm dependencies:** Track B adds its packages to `functions/prime/package.json` only. On a `functions/package-lock.json` (or `requirements.lock`) conflict, take the other side's lockfile and have a person re-run `scripts/lock.sh`; never hand-merge a lockfile.
- **Branches and worktrees:** each issue is worked on its own branch, `track-a/NNNN-short-name`, `track-b/NNNN-short-name` or (milestone `I`) `infra/NNNN-short-name`, in its own **git worktree**. The main checkout always stays on `main`. Only a change that has passed review is merged to `main` and pushed (see "Workspaces and git").
- **Cross-track dependencies** are written in prose as `Depends on #NNNN`, which both listing scripts read.

## Working in Agora (how the workflow runs here)

We don't use Claude Code subagents. Every phase of the workflow below is done by a **separate Agora agent**, a member with its own handle, model and instructions. Each team runs its agents on its own computer with `kolo runner`, so the two teams' agents never share a machine, a checkout or a subscription. Wherever the rest of this guide says "subagent", read "the agent for that phase", and "dispatch" means "@mention it in the issue's task thread".

### Rooms

| Room | Who | Used for |
|---|---|---|
| `#hackathon` | both people, both teams' agents | cross-track questions, A0 review, requests for the other track, status |
| `#track-a` | @rene, Rene's agents | all Track A issue work |
| `#track-b` | @offwhite, Brennan's agents | all Track B issue work |

Keep phase traffic in the track rooms. Each runner keeps a CLI session per agent **per room**, so a crowded room fills every agent's context.

### Agents: one per role, per team

| Role | Model | Does | Suggested (Track B) |
|---|---|---|---|
| **Orchestrator** | Opus, or the person | picks the next issue, opens its Agora task, wakes the planner, collects blocked asks | Gideon, or @offwhite |
| **Planner** | Fable (`claude-fable-5-2`) | phase 1: probes prerequisites, writes `## Prerequisites` + `## Plan`. No code | new agent |
| **Implementer** | Sonnet (`claude-sonnet-5-5`) | phase 2 | new agent |
| **Reviewer** | Opus (`claude-opus-5-5`) | phase 3 | Elliot |
| **Checker** | Haiku (`claude-haiku-5-5`) | runs a named script in a named worktree and replies with the stdout verbatim, nothing else | Joey |

Implementer and reviewer must be **different agents**: the review is the independent check. All of a team's agents have `workspace` access, and their `mention_policy` is `owner` (only their own person and that person's agents can wake them) unless a room needs otherwise.

### One issue = one Agora task

1. The orchestrator runs `scripts/next-issue.py A|B` and creates a task in the track room: title `#NNNN <issue title>`, body with the issue path, milestone and branch name (`track-b/NNNN-short-name`). Every phase happens **in that task's thread**.
2. It wakes the planner with an @mention in the thread. Task assignment alone only puts the task in the agent's inbox; **a hosted agent is woken only by an @mention or by a reply in a thread it started.**
3. Each phase ends by **@mentioning the next agent with an explicit instruction**, e.g. "@reviewer-b review #0012 on `track-b/0012-repl` at `abc1234`". End with that ask, not a bare status report. Agora's guard doesn't wake anyone for thanks or status reports.
4. Task status follows the issue:

| Issue status | Agora task | Set by |
|---|---|---|
| `open` (planned) | `open` | planner |
| `in-progress` | `claimed` (`claim_task`) | implementer |
| implementation drafted | `needs_review` | implementer |
| `resolved` | `done`, with the resolve commit in the note | reviewer |
| bounced to `open` | `open`, with the review notes | reviewer |
| `blocked` | `blocked`, with the exact ask, @mentioning the person | any phase |
| `closed` | (already `done`) | the person, after checking the merge on `main` |

### Owner issues: the person is in the loop

Some work only a person can do: anything that needs AWS credentials (deploy, spikes, live runs), package installs, secrets. Don't make an agent issue wait on it. Split it out:

- **The agent issue** goes as far as an agent can: code, scripts, tests, and a `## Run-book` section with the exact commands and what they should print. Its "done" is `CHECK OK`, so it resolves through the normal workflow.
- **The owner issue** is a separate `NNNN.md` with an `**Assignee**` row naming the person (e.g. `| **Assignee** | @rene |`), `Depends on #<agent issue>`, `## Steps (person)` and `## What to paste back`. `next-issue.py` never hands an issue with an Assignee row to an agent. `next-issue.py A --owner` lists the ones that are ready.

The orchestrator treats the person like any other agent:

1. Each time it picks work, it also runs `next-issue.py <track> --owner`. For each ready owner issue, it creates the Agora task titled `#NNNN <title>` and **assigns it to the person** (`assignee: @rene`).
2. It then posts **at the top level of the track room** (not only in the task thread), **@mentioning the person**: what to run (point at `## Steps (person)`) and what to paste back. A person isn't woken by a task assignment any more than an agent is. Re-mention them once if the task sits for a while.
3. The person posts the output in the task thread and @mentions the orchestrator. The orchestrator assigns an agent to record the results in the issue (and in docs, if the issue says so), and review resolves it. A failure becomes a new bug issue for an agent.

### Hops: let a chain run

A chain like orchestrator → planner → implementer → checker → reviewer → orchestrator is 5–6 agent hops. Agora holds an agent's mention past the room's hop limit (default 3) and flags it `needs_human`. **Each room owner sets `agent_hops` to 8** for `#track-a` and `#track-b` (`PATCH /api/v1/rooms/{room}` or the room settings). A held message isn't lost: a person posting in the thread lets it continue. Agora also pauses agents that go in circles; a second bounce on the same issue is parked as `blocked` anyway.

### Workspaces and git: main stays on `main`, work happens in worktrees

- Each team keeps **one checkout** of the repo on its runner computer (Track B: `~/Developer/Hackathon/stz-agent`, inside the runner's `--workspace`). **That checkout always stays on `main`, and nobody edits files in it directly, except issue files (below).** It's used for creating worktrees, merging, and issue updates.
- **Every issue gets a worktree** at `.worktrees/NNNN-short-name` inside that checkout (git-ignored). The planner creates it when it starts the issue, from an up-to-date `main`:

  ```sh
  cd ~/Developer/Hackathon/stz-agent            # the main checkout
  git fetch https://github.com/rravenel/stz-agent.git main && git merge --ff-only FETCH_HEAD
  git worktree add -b track-b/NNNN-short-name .worktrees/NNNN-short-name main
  ```

  Every later phase (implementer, checker, reviewer) works **only inside that worktree path**, which goes in the task body. All of a team's agents share the repository on one machine, so commits made in the worktree are visible to the next phase at once, with no push in between.
- **Issue files change on `main`, pushed at once.** Every edit to `issues/NNNN.md` is made in the main checkout and committed and pushed right away, never on the issue branch: filing, `## Plan`, the status flip to `in-progress`, drafted notes, `resolved`, a bounce to `open`, `blocked`, `closed`. That way both teams (and `next-issue.py`) always see each issue's true status on GitHub `main`, and issue branches carry only code, so they never conflict on issue files. Stage only the issue file:

  ```sh
  cd ~/Developer/Hackathon/stz-agent            # main checkout, on main
  git fetch https://github.com/rravenel/stz-agent.git main && git merge --ff-only FETCH_HEAD
  # edit issues/NNNN.md
  git add issues/NNNN.md && git commit -m "#NNNN <message>"
  git push https://github.com/rravenel/stz-agent.git main
  ```

  If the push is rejected because the other side pushed first, run `git fetch https://github.com/rravenel/stz-agent.git main && git rebase FETCH_HEAD` and push again. Never force-push. Commit messages:
  - planner: `#NNNN Plan`
  - implementer: `#NNNN Status: in-progress` when it starts, then `#NNNN Notes: implementation drafted` (status stays `in-progress`)
  - reviewer: `#NNNN Resolve: <title>` or `#NNNN Review: <reason>`, after the merge below
- **Code commits go on the issue branch** in the worktree, as before.
- **Merging to `main` (the reviewer, on approve, one merge at a time):**

  ```sh
  cd ~/Developer/Hackathon/stz-agent            # main checkout, on main
  git fetch https://github.com/rravenel/stz-agent.git main && git merge --ff-only FETCH_HEAD
  git -C .worktrees/NNNN-short-name rebase main # bring the branch up to date
  # re-verify after the rebase: scripts/check.sh in the worktree must end CHECK OK
  git merge --ff-only track-b/NNNN-short-name
  git push https://github.com/rravenel/stz-agent.git main
  git worktree remove .worktrees/NNNN-short-name && git branch -d track-b/NNNN-short-name
  ```

  If the push is rejected because the other team pushed first, fetch, rebase, re-check and push again. Never force-push. Then make the `#NNNN Resolve` commit on `main` and push it (above).
- **Sandbox notes** (checked in an agent run): `git worktree add`, commit and `git worktree remove` all work inside the workspace. git over SSH is blocked, so fetch and push use the HTTPS URL above, not `origin`. Don't use `push -u` or other commands that write `.git/config`, which is write-protected.
- The two teams meet only on GitHub `main`. Pull it before starting each issue.

### What only people do

- Run `scripts/setup.sh` after any dependency change. Agent sandboxes can't install packages: pip's temporary `cacert.pem` is denied, and package registries are unreachable.
- Anything needing AWS: `scripts/deploy.sh`, the spikes, integration and the demo.
- Move issues to `closed` or `wontfix` (after checking the merged change on `main`).
- Set up agents, rooms and `agent_hops`, and keep the team's main checkout on `main`.

An agent that hits one of these sets the issue and task to `blocked`, writes the exact ask, and @mentions its person (@rene or @offwhite).

### Cross-track requests

Ask in `#hackathon`, @mentioning the other track's person: one team's agents can't wake the other team's agents (`mention_policy: owner`). The person files the issue in their track (`Depends on #NNNN`) or relays to their own agent.

## Scripts: deterministic build and test, failures only

All building and testing goes through `scripts/`. Never call `pytest`, `npm test`, `tsc` or `cdk synth` directly in an agent context: their output floods the context. Every script prints **one line per step** (`ok   <step> (Ns) <summary>`), and on failure `FAIL <step> … log: .logs/<step>.log` plus an excerpt of at most 40 error lines. Full logs stay in `.logs/` (git-ignored); read one only when the excerpt isn't enough, and then with `grep` or `tail`, not whole.

| Script | What it does | Needs AWS |
|---|---|---|
| `scripts/setup.sh` | Creates `.venv` with the `.python-version` Python and installs `requirements.lock` (hash-checked); `npm ci` in each TS package | no (network) |
| `scripts/lock.sh [--upgrade]` | Re-resolves `requirements.lock` and each `package-lock.json` after a dependency change, then runs setup. A person runs it | no (network) |
| `scripts/build.sh` | `typecheck` + `build` npm scripts in `functions/` and `client/` (when present), then CDK synth into `cdk.out/` | no |
| `scripts/test.sh [all\|py\|ts] [args]` | pytest (CDK assertions) and `npm test` per TS package. **Zero tests run counts as a failure** | no |
| `scripts/check.sh` | `build.sh` then `test.sh all`; ends with `CHECK OK` or `CHECK FAILED` | no |
| `scripts/deploy.sh [env]` | build, then `cdk deploy` (the pinned CLI in `functions/`) of your stack with `stz-dev`; prints stack outputs. `demo` requires `--yes` | **yes** |
| `scripts/next-issue.py A\|B [--list]` | next workable issue for a track | no |
| `scripts/list-issues.py` | overall status view (from the issues skill) | no |

**Who runs the scripts.** The scripts are quiet by design: one line per step, errors only. So the **implementer** runs `scripts/check.sh` in the issue's worktree while working. The **verification of record** for review is a run by the team's **Checker** (Haiku): the reviewer @mentions it with *"Run `scripts/check.sh` in `.worktrees/NNNN-short-name` at `<commit>` and reply with its stdout verbatim and nothing else."* The checker replies in the thread, which wakes the reviewer again. If a step fails, the reviewer decides whether to ask for `.logs/<step>.log` (by `grep`/`tail`, never whole). `.logs/` is per worktree.

**TS package contract.** Every TS package (`functions/`, `client/`) defines npm scripts `typecheck` (`tsc --noEmit`), `build` (esbuild bundles into `dist/`) and `test` (`node --test` on `*.test.ts`; Node runs TypeScript directly, so tests need no installed packages). The scripts above pick them up automatically; nothing else needs wiring.

**Agent sandbox limits** (hosted Agora agents):
- `scripts/setup.sh` can't run inside the agent sandbox: pip writes a temporary `cacert.pem`, and `*.pem` paths are denied. Package registries may be blocked too. **A person runs `scripts/setup.sh`** after any dependency change; agents then run `check.sh` normally.
- Agents have no AWS credentials. Anything that deploys or calls AWS is verified by a person running `scripts/deploy.sh` or the named command. The issue says so in `## Prerequisites` with `**Needs owner:**`.

This file is the local guide for managing issues in this project. The companion Mac app (Issues.app) watches the `issues/` folder and renders the current state. Markdown files (and `project.json`) are the source of truth — there is no generated artifact or index to keep in sync.

The `# stz-agent` heading above should match the `name` field in `issues/project.json`. `project.json` is the canonical source for the project's identity (name + repo URL); this guide is the workflow companion.

## Folder layout

```
issues/
├── project.json       # canonical project name + repo URL (+ optional grouping)
├── Issues.md          # this file
├── model-pricing.json # daily-refreshed model price cache (see "Token usage and cost tracking")
├── 0001.md            # one file per issue
├── 0001/              # optional sibling folder for screenshots, crash logs, etc.
│   └── screenshot.png
├── 0002.md
└── …

scripts/
└── list-issues.py     # the status view over issues/ — run this, don't read the folder
```

## Seeing where things stand

**`./scripts/list-issues.py` is the status view over `issues/`. Run it before picking up work** — one call, twenty lines, instead of a hundred file reads and the context they cost.

```bash
./scripts/list-issues.py            # summary + progress + the most relevant issues
./scripts/list-issues.py --next     # just the next actionable issue — the dispatch call
./scripts/list-issues.py -S         # the summary alone
./scripts/list-issues.py --blocked  # everything waiting on a human or a dependency
./scripts/list-issues.py -s open    # filter by status
./scripts/list-issues.py -h         # everything else
```

`--next` prints the lowest-numbered issue an agent **can actually start**: it skips issues that are `blocked` and issues waiting on an unresolved dependency, and it exits non-zero with nothing on stdout when the queue has no workable issue left. Handing a subagent an unworkable issue spends the dispatch before any work happens, which is why the pick goes through this rather than "lowest open number".

By default the listing shows what's coming and what just landed: issues finished more than **3 days** ago are hidden, with the footer saying how many and `-a` showing them. A tracker with hundreds of resolved issues stays readable, and nothing is lost — the folder is the archive.

The script reads the markdown directly — no index, no cache, never stale. Subagents should read only the one issue they were given plus any it explicitly depends on; queue-level questions go through this script.

**Status questions get answered in the conversation**, not by pointing at the Mac app: run the script and summarize where things stand, what's next, and what's parked with each blocker's exact ask.

## Project config (`project.json`)

A small JSON file naming the project and its repo. Two required fields:

```json
{
  "name": "stz-agent",
  "url": "https://github.com/rravenel/stz-agent"
}
```

- `name` — the project's human-readable name. Match the heading at the top of this file.
- `url` — the project's canonical web URL (HTTPS form, not SSH). Typically a GitHub URL; GitLab, Bitbucket, etc. work too.

When the repo moves or renames, edit `project.json` directly. Don't infer the project's name from the parent folder path — `project.json` is authoritative.

<!-- Optional. Delete this paragraph if the project doesn't sequence its
     issues into phases / milestones. -->

If this project works through its issues in ordered chunks, add a `grouping` object so the listing groups by it and drains the earliest incomplete group first:

```json
"grouping": {
  "field": "Phase",
  "pattern": "^(?P<num>\\d+)\\s*[—–-]?\\s*(?P<label>.*)$",
  "singular": "Phase",
  "unassigned": "Unphased"
}
```

Each issue then carries a matching metadata row — `| **Phase** | 6 — Workshops |`. Document the vocabulary under "Module conventions" below so filing agents use it consistently.

## Status values

| File value | Display name | Meaning |
|---|---|---|
| `open` | Open | Filed but not yet started |
| `in-progress` | In Progress | Actively being worked on |
| `blocked` | Blocked | No agent can proceed until a human acts |
| `resolved` | Resolved | Work is done; awaiting user confirmation |
| `closed` | Closed | User has confirmed the fix |
| `wontfix` | Won't Fix | Acknowledged but won't be addressed |

Use the **file value** (lowercase, hyphenated) in the issue's metadata table. The Mac app converts to the display name when rendering.

`blocked` always pairs with a `## Blocked` section naming the **exact ask** — the literal command or sentence that clears it. It means *a human must act*, not *this is hard*; a merely stuck issue bails back to `open` with `## Notes` so the next subagent can try. The Mac app doesn't know `blocked` yet and renders it as Open; `./scripts/list-issues.py --blocked` is the accurate view.

## Critical rule: never close without explicit confirmation

The most important rule of this workflow: an issue must **never** be marked `resolved`, `closed`, or `wontfix` based on inference. Only when the user has said so in plain language. Specifically, do not infer resolution from:

- a code change you (or a subagent) just made
- a commit message
- the filing of a related issue
- the user saying "thanks, that looks better"

Leave status at `open` (or `in-progress` if work has started) until the user confirms in words like "close this", "this is fixed", "mark resolved", or "won't fix". When in doubt, ask.

The deliberate exception: the **review subagent** (Opus, phase 3 of the standard workflow) may set `resolved` after independently re-verifying the fix (work-is-done-but-not-confirmed). The implementation subagent never sets `resolved` — it leaves the issue `in-progress` for review. No subagent ever sets `closed` — that's the user's call. This separation is the entire reason `resolved` and `closed` are different states.

## Working unattended

This queue is meant to be worked for hours with nobody at the keyboard. Two rules make that possible.

**Decide, don't ask.** When you hit a reversible judgement call — two defensible designs, an ambiguity in the issue, an unsettled convention — pick what you would have recommended and act. Record it under `## Decisions taken without the owner` in the issue: what you chose, what you rejected, what would change your mind. Add the literal line `**Wants owner feedback:** <one sentence>` to the ones genuinely worth a review; that exact string is what a later pass greps for. A question asked at 02:00 costs the whole remaining run.

**A blocker stops one issue, never the run.** If something needs a human — a permission, a credential, a device, an approval, a project policy — first try to work around it: retry once reading the real error, find another route to the same result, or narrow the scope and ship the part that works (filing the rest as its own linked issue). Only when none of that produces anything shippable, set the issue to `blocked`, write the `## Blocked` section with an exact ask, and hand back. The orchestrator takes the next workable issue immediately and collects every human ask into one report at the end of the run.

**What still stops an agent cold.** Deciding reversible calls doesn't extend to the owner's own calls. Without a direct instruction, never: set `closed` or `wontfix`; push anything other than a reviewed merge to `main` (above); force-push; deploy, publish, or take any other outward-facing action; spend money; delete or rewrite history; edit a document the owner owns (record the proposed amendment in `## Gotchas`); touch a sibling repo; or override a prohibition in this file or `AGENTS.md`.

<!-- Add this project's own hard stops here — e.g. "no agent launches a
     browser without the owner's say-so for that run". -->

## Git tracking

This project's choice on whether `issues/` is in git determines whether lifecycle events produce commits. Check on every operation:

```bash
git rev-parse --is-inside-work-tree 2>/dev/null   # is this a git repo?
git check-ignore -q issues/                        # exit 0 = ignored, 1 = tracked
```

- **Not a git repo, or `issues/` is ignored**: edit files only; never commit. The Mac app still tracks changes from the working copy.
- **`issues/` is tracked**: each lifecycle event below produces its own commit.

When tracked:

| Event | What's committed | Commit message |
|---|---|---|
| Initial setup | `project.json` + `Issues.md` together | `Add issue tracker setup` (or bundle with the first `#NNNN` commit) |
| File a new issue | the new `NNNN.md` (and `project.json` / `Issues.md` if newly created) | `#NNNN <issue title>` |
| Planning adds `## Plan` | markdown (the `## Plan` section) | folded into `#NNNN <issue title>` if it lands first, else `#NNNN Plan` |
| Edit project config | `project.json` only | `Update project config` (or e.g. `Update project URL`) |
| Implementation — code commit | code changes only | `#NNNN <verb> <title>` |
| Review — resolution commit | markdown update (status + Closed + Commit + summary), made by the Opus reviewer | `#NNNN Resolve: <title>` |
| Review — bounce to open | markdown (status back to `open` + `## Review notes`) | `#NNNN Review: <reason>` |
| Bail with notes | markdown only | `#NNNN Notes: <brief>` |
| Park as blocked | markdown only | `#NNNN Blocked: <one-line reason>` |
| Work-log row appended | markdown only | `#NNNN Work log: <model>, <total tokens>, $<cost>` |
| Daily pricing refresh | `model-pricing.json` only | `Update model pricing` |
| User-confirmed close | markdown only | `#NNNN Close` |
| Won't fix | markdown only | `#NNNN Won't fix` |

**Every status change is committed and pushed to `main` immediately**, including the flip to `in-progress` (`#NNNN Status: in-progress`). With two teams working in parallel, a status that exists only in one checkout is invisible to the other team and to `next-issue.py`. See "Workspaces and git" for the commands.

**Why two commits to resolve, not one:** the **Commit** metadata row records the hash of the code-fix commit, and that hash isn't known until *after* the code commit lands. Splitting resolution into a code commit and a resolution commit keeps each commit single-purpose ("fix the code", "document the fix") and lets the resolution commit reference the hash cleanly.

## Issue file format

Each issue is `NNNN.md` (4-digit zero-padded) with this structure:

```markdown
# NNNN — Title

| | |
|---|---|
| **Status** | open |
| **Module** | <module name(s)> |
| **Platform** | iOS · macOS · iPadOS · All |
| **First seen** | YYYY-MM-DD |

## Description

What is wrong. Lead with the punchline — the first paragraph shows in the Mac app summary.

## Steps to reproduce

1. …
2. …

## Expected behavior

What should happen.

## Actual behavior

What actually happens.

## Attachments

![caption](NNNN/screenshot.png)

## Notes

Any additional context, guesses at root cause, related code locations.
```

### Format details that matter

- **Title separator** is an em-dash (U+2014, `—`), not a hyphen.
- **Metadata field rows** must keep the field name in `**bold**` exactly.
- **Dates** are `YYYY-MM-DD`.
- **Module** can list multiple modules separated by ` / ` (e.g. `BlueskyFeed / BlueskyDataStore`).
- **Platform** is `iOS`, `macOS`, `iPadOS`, `All`, or any other string. `All` is treated as matching every platform filter.
- When status moves to `resolved` or `closed`, add a `**Closed**` row with today's date. When the move to `resolved` is the result of a fix commit, also add a `**Commit**` row with the short hash (`git rev-parse --short HEAD`).
- Steps / Expected / Actual / Attachments / Notes are conventional but not all required — for design-refinement or feature-gap issues, Description alone is fine.

## Filing a new issue

1. Confirm `issues/project.json` exists. If missing, create it (see schema above) before filing the first issue — `name` should match this guide's heading; `url` is the project's canonical web URL (HTTPS, not SSH).
2. Find the highest existing `NNNN.md` and increment. Start at `0001` if the folder is empty. Skip past reserved high numbers (e.g. `8888`, `9999` for test issues).
3. Create `issues/NNNN.md` from the template.
4. Set status to `open`.
5. Use today's date for First seen.
6. Phrase the title as a single declarative sentence describing the bug, not a question or a fix description.
7. **Plan it (phase 1).** Dispatch a fresh subagent on the **top available model (currently Fable)** to read this guide, `AGENTS.md`, the new issue, and the relevant code, then write `## Prerequisites` and `## Plan` into `issues/NNNN.md` (after `## Description`). It writes no code and leaves status at `open`. Record the planner's usage in `## Work log`. Skip if the user is jotting a quick note and doesn't want planning yet.

   Planning is where obstacles get found, because it is the only phase where hitting one is cheap. The planner **probes** each thing the fix will need — the verify command, services, credentials, devices, network, harness approvals, this file's own prohibitions, and any issue this one depends on — by actually running a cheap check, and records the result in `## Prerequisites` with the evidence. A box checked on reasoning rather than a command is worse than an unchecked one, because phase 2 will trust it. Anything unmet gets the literal marker `**Needs owner:**` and the exact command that clears it. The planner also settles every open question the implementer would otherwise have to ask.
8. **If `issues/` is tracked by git**, commit the new file with message `#NNNN <issue title>` so the issue enters git history with its `open` status — the `## Plan` rides along if it's landed, else commit it separately as `#NNNN Plan`. If ignored, skip.

## Updating an issue

Edit the file in place. The Mac app picks up changes automatically — no follow-up command. Touch only the rows or sections that changed; don't reformat the rest.

When status moves to `resolved` or `closed`, add a `**Closed**` row with the date. When the move to `resolved` was driven by a fix commit, also add a `**Commit**` row with the short hash. For any move toward `resolved`, `closed`, or `wontfix`, the "Critical rule" near the top of this file applies — those transitions require explicit user confirmation, not inference.

## The standard workflow (plan → implement → review)

Issues move from filed to resolved through a **three-phase pipeline**. Each phase is done by **that phase's Agora agent** (see "Working in Agora"), woken in the issue's task thread, on the model that fits the work:

| Phase | When | Model | The subagent does | Status after |
|---|---|---|---|---|
| **1. Planning** | at issue creation (see "Filing a new issue") | **Fable** (top model) | reads conventions + issue, writes `## Plan`; no code | `open` |
| **2. Implementation** | when the issue is worked | **Sonnet** | follows the plan, fixes, builds + verifies, code commit, drafts resolution sections | `in-progress` |
| **3. Review** | after implementation returns | **Opus** | independently re-verifies the diff, then approves or bounces | `resolved` or `open` |

Agora agents keep a CLI session per room, so they are **not** fresh between issues. That's why every phase still starts by re-reading this guide, `AGENTS.md` and the issue file, and why each phase is a different agent.

### Orchestrator: pick and dispatch

1. **Pricing cache:** skip it. Agora agents can't read each other's transcripts (see "Token usage and cost tracking").
2. **Pick the issue with `scripts/next-issue.py A|B`** (per track; see "Two tracks"). Then open its Agora task and @mention the planner, or the implementer if the issue already has a `## Plan`. `./scripts/list-issues.py --next`, the skill's picker, would cross tracks; don't use it here. `next-issue.py` returns the lowest-numbered issue in the track's earliest milestone that is `open`, not `blocked`, and has no unresolved dependency. Nothing on stdout (exit 1) means no workable issue is left: stop and report. Don't hand-roll the pick by globbing `issues/*.md`.
3. **The implementer** (phase 2) is woken by the planner's handoff, or by the orchestrator.
4. **The implementer hands off to the reviewer** (phase 3). The reviewer asks the checker for the verification run.
5. If the reviewer bounced the issue back to `open`, re-dispatch phase 2 **once**; a second bounce gets parked as `blocked` rather than looped again. Otherwise go back to step 2 for the next issue (or stop if only one was requested).

**Never stall the loop.** An agent that reports "parked as `blocked`" is not a reason to stop or to ask — go straight back to step 2. Collect every human ask into a single end-of-run report: what was resolved, what is parked and the exact ask for each, and which issues carry a `**Wants owner feedback:**` marker.

Usage is recorded per phase — locate the subagent's transcript, sum token counts (deduped by `requestId`), note the model, compute cost, and append a `## Work log` row. Bails and bounces get a row too. If the user names a specific issue ("fix 0046"), dispatch phase 2 to that id directly.

### Phase 2 — Implementation subagent (Sonnet): claim → fix → build → commit

A subagent starts with fresh context, so its first job is loading the project's conventions.

1. **Orient in the project.** Read, every time, in order:
   - **`issues/Issues.md`** (this file) — status vocabulary, module conventions, build/verify command, commit conventions, project rules. **Authoritative for issue-tracking workflow.**
   - **`AGENTS.md`** at the repo root, if it exists — project-wide guidance, code conventions, restricted areas, build/test commands. **Binding.**
   - **`issues/NNNN.md`** — the issue in full, **including its `## Prerequisites` and `## Plan`** and any attachments in `issues/NNNN/`.

   If the two guides disagree, prefer `AGENTS.md` for code/repo conventions and this file for issue-tracking specifics. Read only this issue and any it explicitly depends on — not the whole tracker.

2. **Read `## Prerequisites` before anything else.** The planner already probed the environment. An item marked `**Needs owner:**` is a wall it could not clear; if unmet prerequisites gate only part of the work, implement the part they don't gate.
3. **Set status to `in-progress`** in `issues/NNNN.md` on `main`, commit `#NNNN Status: in-progress` and push it at once (see "Workspaces and git"), then `claim_task` the Agora task.
4. **Make the code changes** required to fix the bug, following the `## Plan`. If you deviate, note why in `## Fix` so the reviewer understands. Decide reversible calls yourself and record them (see "Working unattended"); work around obstacles before giving up.
5. **Build *and* run the project's verification command, and confirm tests actually executed and passed.** Mandatory; cannot be shortcutted.

   - **Compilation is not verification.** "It builds" / "no type errors" does not count. Tests must actually run — unit tests execute, UI tests run on a simulator, the app launches, whatever the project defines as proof. A green build with zero tests run is a failure of this step.
   - **If you wrote or modified tests, you MUST execute those specific tests and observe them pass.** Confirm the test names appear in the output, the counts increased, and the result was success. A test that compiles but never ran proves nothing.
   - **Read the output, don't just check the exit code.** "0 tests run", "skipped", "no tests found", or "build succeeded" with no test summary are red flags even at exit code 0. iOS in particular reports `xcodebuild` success when no tests ran.
   - **If verification can't run in your environment** (no simulator, missing credentials, hardware, sandbox), you have not verified the fix. Look for another way to prove it first — a unit test where a UI test was planned, a fixture where a live service was needed. If there genuinely isn't one, **park the issue as `blocked`** naming the exact approval or credential that would let verification run. Don't bail to `open`; the next subagent would hit the identical wall.
   - **If the build was already failing before you started**, note it and bail — don't fix unrelated breakage.

6. **Make the code commit.** Stage *only the code changes* (not the issue markdown yet). The message starts with `#NNNN` and a short, declarative title — the verb that fits (`Fix`, `Add`, `Refactor`, `Update`, `Remove`, …); not every issue is a bug fix. Blank line, then a paragraph of detail. Example:

   ```
   #0046 Add navigation from avatar tap to profile

   The avatar tap on PostCardView was not wired to any NavigationLink.
   Threaded the author DID through the cell and connected onTapGesture
   to push ProfileView.
   ```

7. **Capture the commit hash** with `git rev-parse --short HEAD`.
8. **Draft the resolution sections in the markdown — but do NOT set `resolved`.** That's the reviewer's transition.

   - Leave **Status** at `in-progress`; add a `**Commit**` row with the short hash from step 7.
   - Add, all *after* `## Description`:
     - **`## Root cause`** — what was actually wrong.
     - **`## Fix`** — the approach taken; call out any divergence from the plan.
     - **`## Verification`** — the exact command(s) you ran and what you observed (e.g. "`xcodebuild test -scheme MyAppUITests` — 14 tests passed including the 3 new in `ReplyButtonUITests`"). Name new tests and confirm they ran.
     - **`## Files changed`** — one bullet per file, with a short note on what changed.
     - **`## Gotchas`** *(optional)* — surprises, dead ends, non-obvious behavior. Skip if nothing's notable; be specific when present.

9. **Commit the draft** on `main` (not in the worktree) as `#NNNN Notes: implementation drafted` and push it. Set the task to `needs_review`, then @mention the reviewer with the branch and commit hash. The reviewer makes the resolution commit in phase 3.

### Phase 3 — Review subagent (Opus): verify → resolve or bounce

An independent reviewer is the gate between "code landed" and "issue resolved". It owns the `resolved` transition; the implementation subagent never sets it.

1. **Orient** the same way (this file, `AGENTS.md`, `issues/NNNN.md` including the `## Plan` and the drafted resolution sections).
2. **Inspect the code commit** — read its diff (`git show <hash>`). Does it actually address the reported bug? Right scope? Any correctness, security, or regression risk?
3. **Re-run the verification command yourself** and read the output — don't trust the drafted `## Verification`. Confirm tests actually executed and passed (same standard as phase 2, step 4). This independent run is the core of the review.
4. **Decide:**
   - **Approve** (fix is correct, verification passed): change **Status** to `resolved`; add a `**Closed**` row with today's date; ensure the `**Commit**` row is present; add a top-of-resolution `## Resolution notes` blockquote (`> 🟢 Resolved YYYY-MM-DD — <one sentence>.`). **If `issues/` is tracked**, merge the code branch first, then make the resolution commit on `main` and push it — stage `issues/NNNN.md`, message `#NNNN Resolve: <title>`, body noting the code commit hash. If ignored, skip; the markdown is the record.
   - **Bounce** (verification failed, fix wrong, scope off): revert **Status** to `open`; add a `## Review notes` section stating exactly what failed and what the next implementation pass must fix. Leave the code commit in place unless you say otherwise in the notes. **If tracked**, commit the markdown on `main` with `#NNNN Review: <reason>` and push it. Return to the orchestrator, which re-dispatches phase 2.

Status flow: `open` (with `## Prerequisites` + `## Plan`) → `in-progress` → review → `resolved`, or bounced back to `open`. Any phase can instead park the issue at `blocked`, which withdraws it from the queue until a human acts. **Never set `closed`** — the user does that after verifying the fix.

### Build / verify command for this project

- **`scripts/check.sh`**. The implementer runs it while working; the team's Checker agent runs it for review (see "Scripts" above). It must end with `CHECK OK`, and the `pytest` / `test-functions` lines must show a non-zero passed count that includes any tests you added.
- Narrower runs while iterating: `scripts/test.sh py -k <name>`, `scripts/test.sh ts <file-filter>`.
- Work that needs AWS (deploys, spikes S1-in-Lambda and S2, integration, the demo) is verified by a person with `scripts/deploy.sh` plus the steps named in the issue. Until they report back, the issue is `blocked` with the exact ask.

### When the subagent can't finish

Two endings, and picking the wrong one is costly. **Bail** when an agent could still make progress — the issue returns to the queue. **Park** when only a human can unstick it — the issue leaves the queue until they do.

**Bail to `open`** — unreproducible, out of scope, the build won't pass after reasonable effort:

1. **Discard or stash any partial code changes** so the bail doesn't accidentally include half-done work.
2. **Revert status to `open`** in the issue markdown so the issue goes back into the queue.
3. **Add a `## Notes` section** describing what was tried, why work stopped, and what you'd try next. Be specific.
4. **If `issues/` is tracked by git**, commit the markdown change with message `#NNNN Notes: <one-line bail summary>`. If ignored, skip.
5. Return with a one-line summary of why work stalled.

**Park as `blocked`** — a permission, credential, device, approval, or policy no agent can supply, and the work-arounds produced nothing shippable:

1. Discard or stash partial changes, same as a bail.
2. Set **Status** to `blocked`.
3. Add a `## Blocked` section with **Needs**, **Exact ask** (the literal command, `!`-prefixed if the owner should run it in-session, or the literal sentence to say), **Tried**, **Unblocks**, and the **Parked** date. The exact ask is the field that matters: a blocker the owner can't clear in one action stays.
4. **If `issues/` is tracked by git**, commit the markdown with `#NNNN Blocked: <one-line reason>`.
5. Return one line — parked, and what it needs.

Never use `wontfix` or `closed` to escape a stuck issue, and never use `blocked` as a synonym for "hard".

## Token usage and cost tracking

**In Agora this section is best-effort.** Each run's transcript stays on its owner's runner, so record the model and phase with `—` for tokens and cost unless the person adds them; Agora's agent pages show runs per agent. Otherwise, every dispatch gets a usage record on the issue it worked: which model did the work, exactly how many tokens it consumed, and an estimated cost. The **orchestrator** records this after the subagent returns — a subagent can't measure its own totals. Under the three-phase workflow each issue accumulates a row per phase — **planning (Fable), recorded at filing time; implementation (Sonnet); review (Opus)** — plus a row for every bounce or bail.

### Pricing cache (`issues/model-pricing.json`)

Anthropic publishes prices on the docs site (no API endpoint). Fetch once per day, cache to:

```json
{
  "fetched": "YYYY-MM-DD",
  "source": "https://docs.claude.com/en/docs/about-claude/pricing",
  "currency": "USD per MTok",
  "models": {
    "claude-fable-5": { "input": 5.00, "output": 25.00, "cache_write_5m": 6.25, "cache_read": 0.50 },
    "claude-opus-4-8": { "input": 5.00, "output": 25.00, "cache_write_5m": 6.25, "cache_read": 0.50 },
    "claude-sonnet-4-6": { "input": 3.00, "output": 15.00, "cache_write_5m": 3.75, "cache_read": 0.30 }
  }
}
```

If `fetched` is today, use as-is. If the fetch fails, use the stale cache and note the staleness next to the cost; with no cache at all, record tokens and model with `—` for cost. Never trust example numbers over a fresh fetch.

### Getting exact token counts

Claude Code writes each subagent's transcript to `~/.claude/projects/<project-slug>/<session-id>/subagents/agent-<id>.jsonl`, where `<project-slug>` is the working directory with `/`, `.`, and `_` replaced by `-`. Assistant lines carry `message.usage` (exact `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) and `message.model`.

**Dedupe by `requestId`** — one API response can span several JSONL lines repeating the same usage object; summing every line over-counts. Find the newest agent file mentioning the issue id, keep one usage entry per `requestId`, and sum.

```
cost = (input × input_rate + output × output_rate
      + cache_read × cache_read_rate + cache_write × cache_write_5m_rate) / 1,000,000
```

If no transcript is available (different harness), record whatever total the harness reported, or `—`. Never fabricate counts.

### The `## Work log` section

One row per work session, conventionally the last section of the issue file (always after `## Description`). The optional **Phase** column (`plan` / `implement` / `review`) makes the three-phase breakdown legible:

```markdown
## Work log

| Date | Phase | Model | Input | Output | Cache read | Cache write | Cost |
|---|---|---|---|---|---|---|---|
| 2026-06-03 | plan | claude-fable-5 | 84 | 6,102 | 512,400 | 41,200 | $0.58 |
| 2026-06-04 | implement | claude-sonnet-4-6 | 120 | 18,530 | 2,904,110 | 98,400 | $1.12 |
| 2026-06-04 | review | claude-opus-4-8 | 96 | 9,240 | 1,331,200 | 44,800 | $1.05 |

**Total: $2.75**
```

Update the `**Total**` line whenever a row is appended. The `plan` row lands at filing time; the `implement` and `review` rows land as each phase returns. Bails and bounces get a row too. Don't reformat existing rows.

## Attachments

Screenshots, crash logs, console output, sample data, etc. live in a sibling folder `issues/NNNN/`. Reference them with paths *relative to the issue's `.md` file* — that means the folder prefix `NNNN/` is part of the link target. The bytes that ship are `1335/screenshot.png`, not `screenshot.png` and not `issues/1335/screenshot.png`.

```
issues/1335.md           ← the markdown that contains the link
issues/1335/screenshot.png   ← the file being linked

# inside 1335.md the link reads:
![caption](1335/screenshot.png)
```

Concrete example with both image and video attachments:

```markdown
## Attachments

![Reply button does nothing when tapped](1335/screenshot.png)
![Crash log](1335/crash.log)
[![Sidebar resize jitter](1335/sidebar-resize-jitter.poster.png)](1335/sidebar-resize-jitter.mov)
```

### Videos (`.mov`, `.mp4`, etc.)

Videos can't be embedded as `![…](…)` — markdown renderers treat that as an `<img>` and a `.mov` won't load. Instead, generate a poster frame with `qlmanage` and emit an image-inside-a-link (shown in the example above). Quick recipe — copy the video into `issues/NNNN/` first, then:

```bash
qlmanage -t -s 1280 -o issues/NNNN issues/NNNN/<basename>.<ext>
mv issues/NNNN/<basename>.<ext>.png issues/NNNN/<basename>.poster.png
```

`qlmanage` ships with macOS — no install. It reliably produces posters for AVFoundation-supported formats: `.mov`, `.mp4`, `.m4v`, `.qt`. For `.avi` it usually works; for `.mkv` and `.webm` it generally fails on stock macOS unless a third-party Quick Look generator is installed. If the rename step doesn't produce the `.poster.png`, fall back to the plain `![alt](NNNN/file.mov)` form with a `<!-- poster generation failed -->` HTML comment in the Attachments section. Don't apply the link wrapper to plain images, and don't generate posters for animated GIFs.

### macOS screenshot / screen recording filename gotcha

macOS Screenshot and Screen Recording filenames both use a **narrow no-break space** (U+202F) before AM/PM, visually identical to a regular space. A literal `cp` of the quoted filename will fail with "No such file or directory". Use a glob to skip past it:

```bash
mkdir -p issues/NNNN
cp ~/Desktop/Screenshot\ YYYY-MM-DD\ at\ H.MM.SS*PM.png issues/NNNN/screenshot.png
cp ~/Desktop/Screen\ Recording\ YYYY-MM-DD\ at\ H.MM.SS*PM.mov issues/NNNN/recording.mov
```

The `*` matches the U+202F. Substitute the actual timestamp; if you don't know which file the user means, list `~/Desktop/Screenshot*` or `~/Desktop/Screen\ Recording*` by mtime and pick the most recent.

## Module conventions for this project

Module names: `Contracts` (`functions/shared/` types), `CDK`, `CommsWorker`, `Com`, `Doorman`, `Prime`, `REPL`, `Client`, `Tooling` (scripts, cost report), `Spike`. Platform is always `AWS Lambda` or `Local`.

Milestone values (the `**Milestone**` row; `project.json` groups by it):

| Key | Track | Spec §10 slot | Scope |
|---|---|---|---|
| `A0 — Shared contracts` | A | 0:00–0:20 | TS workspace, envelope, S3 keys, `state.json`, comms-worker interface + fake |
| `A1 — Infra and spike S2` | A | 0:20–1:30 | CDK resources with stub functions; Lambda wake spike |
| `A2 — Comms worker, Com, Doorman` | A | 1:30–2:30 | `comms-worker.ts`, Com, Doorman |
| `A3 — Integration` | A | 2:30–3:15 | Doorman → Prime → Com → Prime, deployed |
| `A4 — Client and cost report` | A | 3:15–4:00 | TS CLI, `scripts/cost-report.ts` |
| `B1 — Spike S1` | B | 0:20–1:30 | QuickJS WASM snapshot/restore (fallback: replay) |
| `B2 — Prime harness` | B | 1:30–2:30 | REPL, agent loop, log, proxy, model adapters |
| `B3 — Checkpoint and exit` | B | 2:30–3:15 | checkpoint/restore, exit checklist, continuation |
| `B4 — Demo run` | B | 3:15–4:00 | success criteria with a real model and slow fetch |
| `I1 — Build infrastructure` | I | (outside §10) | cross-track tooling: pinned toolchain and deps for `scripts/`. Branches `infra/NNNN-short-name`; pick with `scripts/next-issue.py I` |
