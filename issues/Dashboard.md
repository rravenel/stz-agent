# Dashboard

Single-file status. Updated 2026-11-24. The issue files stay authoritative, and `scripts/list-issues.py` ignores this file.

**36 issues: 16 closed, 17 resolved, 1 in progress, 1 blocked, 1 open.** #0034–#0036 are new, filed from reviews.

## Needs you

| # | What | How |
|---|---|---|
| 1 | Push to `main` | The harness blocked Claude's push. From the main checkout: `git merge --ff-only followups && git push origin main` |
| 2 | Real-model demo run (#0017) | Needs a model key in Secrets Manager or Bedrock access, and spends money. The run-book is in the issue |
| 3 | Three decisions (#0034) | Crash backoff, Com self-invoke, spec and protocol edits |
| 4 | Confirm and close | Every `resolved` issue waits for your confirmation; only you can set `closed` |

## This run

| Issue | Track | Status | Commit | Review | Live check |
|---|---|---|---|---|---|
| #0031 queue-permission tests | A | resolved | `42d8a27` | APPROVE | n/a |
| #0033 stranded messages | A | resolved | `169c7ce`, `346a135` | BOUNCE, then APPROVE | E2E PASS |
| #0029 Prime self-wake follow-up | B | resolved | with #0033 | APPROVE | E2E PASS |
| #0032 token in Secrets Manager | A | resolved | `79c1648`, `e50d11e` | APPROVE | new token works; old and wrong get 401 |
| #0021 Bedrock adapter | B | resolved | `c7c08b4`, `3dd4dbf` | BOUNCE, then APPROVE | **not run** (no live Bedrock call) |
| #0020 QuickJS in Lambda | B | resolved | `15ffdbc` | APPROVE | 9 of 9 restores pass |
| #0023 end-to-end run | A | resolved | n/a | RESOLVE | E2E PASS; cost ratio 0.23 |
| #0035 empty model replies | B | resolved | `1937430` | APPROVE | normal path only |
| #0017 demo | B | in progress | n/a | mock criteria met | mock PASS; cost ratio 0.21 |
| #0034 crash backoff, Com race, docs | A/B | blocked on you | `1937430` (part) | APPROVE (part) | normal path only |
| #0036 remaining test gaps | A/B | open, low priority | `1937430` (part) | partly done | n/a |

`StzAgent-rene` runs `1937430` with the mock model. The shared `demo` stack was not touched.
