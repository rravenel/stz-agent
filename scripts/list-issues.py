#!/usr/bin/env python3
"""List the issue tracker — status, progress, and what to pick up next.

    list-issues.py                 # the default view for this project
    list-issues.py --next          # just the next actionable issue (for agents)
    list-issues.py -S              # the summary block alone
    list-issues.py --blocked       # everything waiting on a human
    list-issues.py --json          # machine-readable, for scripting
    list-issues.py -h              # everything else

Shipped by the IssuesSkill and copied into a project as `scripts/list-issues.py`.
It replaces reading the `issues/` folder file by file: one call gives an agent
the whole queue's state for a fraction of the context, and it never goes stale
because it reads the markdown directly — there is no index or cache.

Two views
  Flat      — relevance ordering: fresh (touched in the last 2 days), then
              still-open, then recently resolved. Finished issues untouched for
              over 3 days are hidden unless -a is given — the listing is about
              what is coming and what just landed, not the whole archive.
  Grouped   — issues bucketed by a metadata field (Phase, Milestone, …) with a
              completion percentage and bar per group. Used automatically when
              `issues/project.json` declares a `grouping` (see below); force it
              with --by-group, force flat with --flat.

Grouping config, in `issues/project.json`:

    "grouping": {
      "field": "Phase",
      "pattern": "^(?P<num>\\\\d+)\\\\s*[—-]?\\\\s*(?P<label>.*)$",
      "singular": "Phase",
      "unassigned": "Unphased"
    }

`field` names the metadata row to group by. `pattern` extracts an ordering
number and an optional label from that row's value, via the named groups
`num` (sort order), `key` (group identity — defaults to `num`), and `label`
(display text). Two more optional keys supply labels the issues don't carry:
`labels` is an inline `{key: label}` map, and `labels_from` reads them out of
another file — `{"path": "docs/guide.md", "pattern": "^\\\\*\\\\*(?P<key>M\\\\d+)\\\\s*—\\\\s*(?P<label>[^.*]+)"}`.

Blocked work is first-class. An issue is blocked when its status is `blocked`
or it carries a `## Blocked` section, and it is *dependency-blocked* when its
text says it is blocked by / depends on an issue that is not yet done. Neither
kind is ever offered by --next, because a queue that hands an agent an
unworkable issue is how a run stalls.

On a terminal the output is colored and grouped; piped or redirected it
degrades to plain aligned columns (number, status, group, title) for grep/awk.
NO_COLOR is honored.

The issues folder is ./issues when present, otherwise the first immediate
subdirectory holding an Issues.md/Issue.md guide or a project.json marker,
repeated up the parent directories and stopping at the enclosing git repo root
(so it works from anywhere inside a project, and never reaches sideways into
an unrelated one). Pass a directory to override.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
from dataclasses import dataclass, field as dc_field
from pathlib import Path

# Bump when the script changes in a way a project's copy should pick up. The
# skill compares this against the copy in scripts/ and offers to refresh it.
SCRIPT_VERSION = "1"

FRESH_SECS = 172_800   # 2 days — the "just touched" band
RECENT_SECS = 259_200  # 3 days — how long a finished issue stays in the listing
WEEK_SECS = 604_800    # 7 days — the last age band before a date reads as old

ISSUE_FILE_RE = re.compile(r"^\d{4}\.md$")
TITLE_RE = re.compile(r"^#\s*(\d+)\s*[—–-]\s*(.+?)\s*$")
ROW_RE = re.compile(r"^\|\s*\*\*(?P<key>[^*]+)\*\*\s*\|\s*(?P<val>.*?)\s*\|\s*$")
HEADING_RE = re.compile(r"^##+\s+(.*?)\s*$")
CHECKBOX_RE = re.compile(r"^\s*[-*]\s+\[(?P<mark>[ xX])\]\s*(?P<text>.*)$")
# "Blocked by #0161", "blocked on #12", "depends on #0044". Bounded to the rest
# of the sentence so a paragraph mentioning other issues later doesn't get
# swept in as a dependency.
DEP_RE = re.compile(r"(?i)\b(?:blocked\s+(?:by|on)|depends?\s+on)\b[^.\n]{0,80}?#(\d{1,4})")
NEEDS_OWNER_RE = re.compile(r"(?i)\*\*needs\s+(?:owner|user)\b")
WANTS_FEEDBACK_RE = re.compile(r"(?i)\*\*wants\s+owner\s+feedback:?\*\*")

DEFAULT_GROUP_PATTERN = r"^(?P<num>\d+)\s*[—–-]?\s*(?P<label>.*)$"

# Status vocabulary. Anything unrecognized lands in "other" and is treated as
# non-terminal, so an unknown status shows up as work to do rather than
# silently vanishing from the list after a week.
DONE_STATUSES = {"resolved", "closed", "done", "fixed", "complete", "completed"}
DROPPED_STATUSES = {"wontfix", "won't fix", "duplicate", "invalid"}
ACTIVE_STATUSES = {"in-progress", "in progress", "wip"}
OPEN_STATUSES = {"open", "new", "todo", "reopened"}
BLOCKED_STATUSES = {"blocked", "waiting", "on-hold", "on hold"}
TERMINAL_STATUSES = DONE_STATUSES | DROPPED_STATUSES

SUMMARY_ORDER = ["open", "in-progress", "blocked", "resolved", "closed", "wontfix"]

GLYPHS = {"done": "✓", "active": "◐", "open": "○", "blocked": "⛔", "dropped": "⊘", "other": "•"}


def kind_of(status: str) -> str:
    s = status.strip().lower()
    if s in DONE_STATUSES:
        return "done"
    if s in DROPPED_STATUSES:
        return "dropped"
    if s in ACTIVE_STATUSES:
        return "active"
    if s in BLOCKED_STATUSES:
        return "blocked"
    if s in OPEN_STATUSES:
        return "open"
    return "other"


def human_age(secs: float) -> str:
    """Compact age: 12s, 4m, 3h, 2d, 5w, 6mo, 1y."""
    secs = int(secs)
    for limit, div, suffix in (
        (60, 1, "s"), (3_600, 60, "m"), (86_400, 3_600, "h"),
        (604_800, 86_400, "d"), (2_592_000, 604_800, "w"),
        (31_536_000, 2_592_000, "mo"),
    ):
        if secs < limit:
            return f"{secs // div}{suffix}"
    return f"{secs // 31_536_000}y"


class Palette:
    """ANSI codes, or empty strings when color is off."""

    NAMES = dict(
        reset="0", dim="2", bold="1", red="31", green="32",
        yellow="33", blue="34", magenta="35", cyan="36", gray="90",
    )

    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled
        for name, code in self.NAMES.items():
            setattr(self, name, f"\033[{code}m" if enabled else "")


# --- grouping configuration --------------------------------------------


@dataclass
class Grouping:
    """How to bucket issues, read from project.json's `grouping` object."""

    field: str
    pattern: re.Pattern
    singular: str = ""
    unassigned: str = "Ungrouped"
    labels: dict[str, str] = dc_field(default_factory=dict)

    @classmethod
    def load(cls, cfg: dict, issues_dir: Path) -> "Grouping | None":
        field_name = (cfg.get("field") or "").strip()
        if not field_name:
            return None
        raw = cfg.get("pattern") or DEFAULT_GROUP_PATTERN
        try:
            pattern = re.compile(raw)
        except re.error as exc:
            print(f"warning: grouping.pattern is not a valid regex ({exc}); "
                  f"falling back to the default", file=sys.stderr)
            pattern = re.compile(DEFAULT_GROUP_PATTERN)

        labels = {str(k): str(v) for k, v in (cfg.get("labels") or {}).items()}
        labels.update(cls._labels_from(cfg.get("labels_from"), issues_dir))

        return cls(
            field=field_name,
            pattern=pattern,
            singular=str(cfg.get("singular") or "").strip(),
            unassigned=str(cfg.get("unassigned") or f"Un{field_name.lower()}ed"),
            labels=labels,
        )

    @staticmethod
    def _labels_from(spec, issues_dir: Path) -> dict[str, str]:
        """Group labels scraped out of another document.

        Best effort by design: a moved or restructured source file costs the
        labels, not the report, so every failure returns an empty map.
        """
        if not isinstance(spec, dict):
            return {}
        path, raw = spec.get("path"), spec.get("pattern")
        if not path or not raw:
            return {}
        target = issues_dir.parent / path
        try:
            text = target.read_text(encoding="utf-8", errors="replace")
            pattern = re.compile(raw)
        except (OSError, re.error):
            return {}
        out: dict[str, str] = {}
        for line in text.splitlines():
            m = pattern.match(line)
            if m:
                try:
                    out.setdefault(m.group("key"), m.group("label").strip().rstrip("."))
                except IndexError:
                    # The pattern is missing a `key` or `label` group; the
                    # labels are optional, so drop them rather than failing.
                    return {}
        return out

    def parse(self, raw: str) -> tuple[str, int | None, str]:
        """Split a field value into (group key, sort number, inline label)."""
        raw = (raw or "").strip()
        if not raw or raw in {"—", "-", "n/a", "N/A"}:
            return (self.unassigned, None, "")
        m = self.pattern.match(raw)
        if not m:
            return (raw, None, "")
        groups = m.groupdict()
        num_s = groups.get("num")
        num = None
        if num_s and num_s.isdigit():
            num = int(num_s)
        elif m.lastindex and not groups:
            first = m.group(1)
            if first and first.isdigit():
                num = int(first)
        key = groups.get("key") or num_s or raw
        label = (groups.get("label") or "").strip()
        return (str(key).strip(), num, label)

    def heading(self, key: str, label: str) -> str:
        label = self.labels.get(key) or label
        if key == self.unassigned:
            return self.unassigned
        head = " ".join(p for p in (self.singular, key) if p)
        return f"{head} — {label}" if label else head

    def sort_key(self, key: str, num: int | None) -> tuple[int, int, str]:
        """Numbered groups first in numeric order, then named, then unassigned."""
        if key == self.unassigned:
            return (2, 0, "")
        if num is not None:
            return (0, num, key)
        return (1, 0, key)


# --- issue parsing -----------------------------------------------------


class Issue:
    """One `NNNN.md`, parsed far enough to place it in the queue."""

    def __init__(self, path: Path, grouping: Grouping | None) -> None:
        self.path = path
        self.num = path.stem
        self.title = "(no title)"
        self.status = "?"
        self.module = ""
        self.group_key = grouping.unassigned if grouping else ""
        self.group_num: int | None = None
        self.group_label = ""
        self.ac_done = 0
        self.ac_total = 0
        self.prereq_unmet = 0
        self.prereq_total = 0
        self.needs_owner = False
        self.wants_feedback = False
        self.has_blocked_section = False
        self.deps: list[str] = []
        self.duplicate_metadata = False
        self.mtime = path.stat().st_mtime
        self.rank = 0

        section = ""
        seen_group = False
        text = path.read_text(encoding="utf-8", errors="replace")
        for i, line in enumerate(text.splitlines()):
            if i == 0:
                m = TITLE_RE.match(line)
                if m:
                    self.num, self.title = m.group(1), m.group(2)
                continue

            h = HEADING_RE.match(line)
            if h:
                section = h.group(1).strip().lower()
                if section.startswith("blocked"):
                    self.has_blocked_section = True
                continue

            m = ROW_RE.match(line)
            if m:
                # First row wins. Issues have carried two metadata blocks after
                # a bad edit — last-write-wins silently reported the stale one,
                # so finished work read as open for days. --lint reports the
                # duplication outright rather than leaving it to be noticed.
                key = m.group("key").strip().lower()
                val = m.group("val").strip()
                if key == "status":
                    if self.status == "?":
                        self.status = val or "?"
                    else:
                        self.duplicate_metadata = True
                elif key == "module" and not self.module:
                    self.module = val
                elif grouping and key == grouping.field.strip().lower():
                    if not seen_group:
                        seen_group = True
                        self.group_key, self.group_num, self.group_label = grouping.parse(val)
                    else:
                        self.duplicate_metadata = True
                continue

            cb = CHECKBOX_RE.match(line)
            if cb:
                checked = cb.group("mark") in "xX"
                if section.startswith("prerequisite"):
                    self.prereq_total += 1
                    if not checked:
                        self.prereq_unmet += 1
                        if NEEDS_OWNER_RE.search(cb.group("text")):
                            self.needs_owner = True
                elif section.startswith("acceptance"):
                    self.ac_total += 1
                    if checked:
                        self.ac_done += 1

            if NEEDS_OWNER_RE.search(line) and section.startswith("blocked"):
                self.needs_owner = True
            if WANTS_FEEDBACK_RE.search(line):
                self.wants_feedback = True

            for dep in DEP_RE.findall(line):
                dep = dep.zfill(4)
                if dep != self.num.zfill(4) and dep not in self.deps:
                    self.deps.append(dep)

    # -- derived state

    @property
    def key(self) -> str:
        return self.status.strip().lower()

    @property
    def kind(self) -> str:
        if self.has_blocked_section and not self.is_done and not self.is_wontfix:
            return "blocked"
        return kind_of(self.status)

    @property
    def is_done(self) -> bool:
        return self.key in DONE_STATUSES

    @property
    def is_in_progress(self) -> bool:
        return self.key in ACTIVE_STATUSES

    @property
    def is_wontfix(self) -> bool:
        return self.key in DROPPED_STATUSES

    @property
    def is_blocked(self) -> bool:
        return self.kind == "blocked"

    @property
    def is_terminal(self) -> bool:
        return self.key in TERMINAL_STATUSES

    @property
    def counts(self) -> bool:
        """Whether this issue belongs in a completion denominator."""
        return not self.is_wontfix

    @property
    def number(self) -> int:
        try:
            return int(self.num)
        except ValueError:
            return 10**9

    @property
    def age_secs(self) -> float:
        return time.time() - self.mtime

    def unresolved_deps(self, by_num: dict[str, "Issue"]) -> list[str]:
        """Dependencies that are not yet done — the reason to skip this issue."""
        out = []
        for dep in self.deps:
            other = by_num.get(dep)
            if other is not None and not (other.is_done or other.is_wontfix):
                out.append(dep)
        return out

    def glyph(self) -> str:
        return GLYPHS[self.kind]

    def color(self, p: Palette) -> str:
        return {
            "done": p.green, "active": p.cyan, "open": p.yellow,
            "blocked": p.red, "dropped": p.gray, "other": p.magenta,
        }[self.kind]

    def as_dict(self, by_num: dict[str, "Issue"]) -> dict:
        return {
            "id": self.num,
            "title": self.title,
            "status": self.status,
            "kind": self.kind,
            "module": self.module,
            "group": self.group_key,
            "group_label": self.group_label,
            "age_seconds": int(self.age_secs),
            "acceptance": {"done": self.ac_done, "total": self.ac_total},
            "prerequisites": {"unmet": self.prereq_unmet, "total": self.prereq_total},
            "blocked": self.is_blocked,
            "needs_owner": self.needs_owner,
            "wants_feedback": self.wants_feedback,
            "depends_on": self.deps,
            "unresolved_deps": self.unresolved_deps(by_num),
            "path": str(self.path),
        }


# --- locating the issues directory -------------------------------------


def is_issues_dir(d: Path) -> bool:
    return any((d / n).is_file() for n in ("project.json", "Issues.md", "Issue.md"))


def find_issues_in(base: Path) -> Path | None:
    direct = base / "issues"
    if direct.is_dir() and is_issues_dir(direct):
        return direct
    try:
        candidates = [d for d in sorted(base.iterdir()) if d.is_dir() and is_issues_dir(d)]
    except OSError:
        return None
    for c in candidates:
        if "issue" in c.name.lower():
            return c
    return candidates[0] if candidates else None


def resolve_issues_dir(arg: str | None) -> Path:
    """Honor an explicit DIR verbatim; otherwise search $PWD, then each parent."""
    cwd = Path.cwd()
    if arg:
        p = Path(arg)
        return p if p.is_absolute() else cwd / p
    home = Path.home()
    d = cwd
    while d != d.parent and d != home:
        found = find_issues_in(d)
        if found:
            return found
        if (d / ".git").exists():   # the repo root is the boundary
            break
        d = d.parent
    return cwd / "issues"


def load_project(issues_dir: Path) -> dict:
    cfg = issues_dir / "project.json"
    try:
        data = json.loads(cfg.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


# --- rendering ---------------------------------------------------------


def bar(done: int, total: int, width: int = 12) -> str:
    if total <= 0:
        return "░" * width
    filled = round(width * done / total)
    return "█" * filled + "░" * (width - filled)


def pct(done: int, total: int) -> int:
    return round(100 * done / total) if total else 0


def mixed_bar(kinds: dict[str, int], total: int, width: int, p: Palette) -> str:
    """A proportional bar: done, in flight, blocked, dropped, then remaining."""
    if total <= 0:
        return ""
    segments = [
        (kinds.get("done", 0), "█", p.green),
        (kinds.get("active", 0), "▓", p.cyan),
        (kinds.get("blocked", 0), "▚", p.red),
        (kinds.get("dropped", 0), "▒", p.gray),
        (kinds.get("open", 0) + kinds.get("other", 0), "░", p.dim),
    ]
    # Largest-remainder allocation, so a segment with any issues in it never
    # rounds away to nothing while a wider one absorbs the slack.
    exact = [(n * width / total) for n, _, _ in segments]
    widths = [int(x) for x in exact]
    leftover = width - sum(widths)
    order = sorted(range(len(segments)), key=lambda i: exact[i] - widths[i], reverse=True)
    for i in order[:leftover]:
        widths[i] += 1
    for i, (n, _, _) in enumerate(segments):
        if n and widths[i] == 0:
            donor = max(range(len(segments)), key=lambda j: widths[j])
            if widths[donor] > 1:
                widths[donor] -= 1
                widths[i] = 1
    return "".join(f"{c}{ch * w}{p.reset}" for (_, ch, c), w in zip(segments, widths) if w)


def issue_line(it: Issue, p: Palette, width: int, by_num: dict[str, Issue],
               show_age: bool = True) -> str:
    status = f"{it.glyph()} {it.status}"
    notes = []
    if it.is_in_progress and it.ac_total:
        notes.append(f"{it.ac_done}/{it.ac_total} AC")
    if it.prereq_unmet:
        notes.append(f"{it.prereq_unmet} prereq")
    deps = it.unresolved_deps(by_num)
    if deps:
        notes.append("needs " + " ".join(f"#{d}" for d in deps))
    if it.needs_owner:
        notes.append("needs owner")
    extra = f"  {p.dim}{' · '.join(notes)}{p.reset}" if notes else ""
    plain_extra = f"  {' · '.join(notes)}" if notes else ""

    age = human_age(it.age_secs) if show_age else ""
    acolor = ((p.green + p.bold) if it.age_secs <= FRESH_SECS
              else (p.yellow if it.age_secs <= WEEK_SECS else p.dim))
    tcolor = p.dim if it.is_terminal else p.reset

    prefix_w = 2 + 4 + 2 + 13 + 2 + (6 if show_age else 0)
    avail = max(20, width - prefix_w - len(plain_extra))
    title = it.title if len(it.title) <= avail else it.title[: avail - 1] + "…"

    agecol = f"{acolor}{age:>4}{p.reset}  " if show_age else ""
    return (f"  {p.gray}{it.num:<4}{p.reset}  "
            f"{it.color(p)}{status:<13}{p.reset}  {agecol}"
            f"{tcolor}{title}{p.reset}{extra}")


def print_summary(issues: list[Issue], name: str, grouping: Grouping | None,
                  p: Palette, by_num: dict[str, Issue]) -> None:
    total = len(issues)
    kinds: dict[str, int] = {}
    by_status: dict[str, int] = {}
    for it in issues:
        kinds[it.kind] = kinds.get(it.kind, 0) + 1
        by_status[it.status.lower()] = by_status.get(it.status.lower(), 0) + 1

    done = kinds.get("done", 0)
    dropped = kinds.get("dropped", 0)
    denom = total - dropped

    term_width = shutil.get_terminal_size((100, 24)).columns
    bar_width = max(20, min(46, term_width - 34))

    print(f"{p.bold}{name}{p.reset}{p.dim} · {total} issues{p.reset}")
    tail = f"{done}/{denom} done · {pct(done, denom)}%"
    if dropped:
        tail += f" · {dropped} dropped"
    print(f"  {mixed_bar(kinds, total, bar_width, p)}  {p.bold}{tail}{p.reset}")

    parts, seen = [], set()
    for status in SUMMARY_ORDER:
        seen.add(status)
        n = by_status.get(status, 0)
        if n:
            k = kind_of(status)
            col = {"done": p.green, "active": p.cyan, "open": p.yellow,
                   "blocked": p.red, "dropped": p.gray, "other": p.magenta}[k]
            parts.append(f"{col}{GLYPHS[k]} {status} {n}{p.reset}")
    for status in sorted(set(by_status) - seen):
        k = kind_of(status)
        parts.append(f"{p.magenta}{GLYPHS[k]} {status} {by_status[status]}{p.reset}")
    if parts:
        print("  " + "   ".join(parts))

    for it in sorted((i for i in issues if i.is_in_progress), key=lambda i: i.number):
        print(f"  {p.cyan}◐ In progress{p.reset}  {p.gray}{it.num}{p.reset} {it.title}")

    nxt = pick_next(issues, by_num, grouping)
    if nxt:
        print(f"  {p.yellow}○ Next up{p.reset}      {p.gray}{nxt.num}{p.reset} {nxt.title}")

    waiting = [i for i in issues if i.is_blocked or (not i.is_terminal and i.needs_owner)]
    if waiting:
        ids = " ".join(f"#{i.num}" for i in waiting[:8])
        more = f" +{len(waiting) - 8}" if len(waiting) > 8 else ""
        print(f"  {p.red}⛔ Blocked{p.reset}      {p.dim}{len(waiting)} waiting on a human: "
              f"{ids}{more}{p.reset}")

    feedback = [i for i in issues if i.wants_feedback]
    if feedback:
        ids = " ".join(f"#{i.num}" for i in feedback[:8])
        more = f" +{len(feedback) - 8}" if len(feedback) > 8 else ""
        print(f"  {p.magenta}?  Feedback{p.reset}     {p.dim}{len(feedback)} want a second "
              f"opinion: {ids}{more}{p.reset}")
    print()


def pick_next(issues: list[Issue], by_num: dict[str, Issue],
              grouping: Grouping | None) -> Issue | None:
    """The lowest-numbered issue an agent can actually start right now.

    Blocked issues and issues waiting on an unresolved dependency are skipped —
    handing an agent an unworkable issue is exactly how a run stalls. When the
    project groups its issues, the earliest incomplete group is drained first.
    """
    candidates = [i for i in issues
                  if i.kind in ("open", "other")
                  and not i.is_blocked
                  and not i.unresolved_deps(by_num)]
    if not candidates:
        return None
    if grouping:
        return min(candidates, key=lambda i: (grouping.sort_key(i.group_key, i.group_num),
                                              i.number))
    return min(candidates, key=lambda i: i.number)


SECTION_LABELS = {
    "fresh": "⚡ Fresh · last 2 days",
    "open": "○ Open · needs attention",
    "blocked": "⛔ Blocked · waiting on a human",
    "resolved": "✓ Resolved · last 3 days",
    "stale": "✓ Resolved · older",
}


def print_flat(shown: list[Issue], p: Palette, by_num: dict[str, Issue], hidden: int) -> None:
    width = shutil.get_terminal_size((100, 24)).columns
    prev = None
    for n, it in enumerate(shown):
        sect = {0: "fresh", 1: "fresh", 2: "open", 3: "blocked",
                4: "resolved"}.get(it.rank, "stale")
        if sect != prev:
            if n:
                print()
            print(f"{p.bold}{p.blue}{SECTION_LABELS[sect]}{p.reset}")
            prev = sect
        print(issue_line(it, p, width, by_num))
    footer = f"{len(shown)} shown"
    if hidden:
        footer += f" · {hidden} finished over 3 days ago hidden (-a to show)"
    print(f"{p.dim}{footer}{p.reset}")


def print_grouped(issues: list[Issue], listed, grouping: Grouping, name: str,
                  p: Palette, by_num: dict[str, Issue], only: str | None,
                  limit: int) -> int:
    groups: dict[str, list[Issue]] = {}
    nums: dict[str, int | None] = {}
    for it in issues:
        groups.setdefault(it.group_key, []).append(it)
        nums.setdefault(it.group_key, it.group_num)
    ordered = sorted(groups, key=lambda k: grouping.sort_key(k, nums.get(k)))

    if only:
        want = only.strip().lower()
        ordered = [k for k in ordered if k.lower() == want]
        if not ordered:
            print(f"no issues in {grouping.field.lower()} {only}", file=sys.stderr)
            return 1

    width = shutil.get_terminal_size((100, 24)).columns
    hidden = 0
    for k in ordered:
        members = sorted(groups[k], key=lambda i: i.number)
        counted = [i for i in members if i.counts]
        done = sum(1 for i in counted if i.is_done)
        in_prog = sum(1 for i in counted if i.is_in_progress)
        blocked = sum(1 for i in counted if i.is_blocked)
        openish = len(counted) - done - in_prog - blocked
        pc = pct(done, len(counted))
        pcolor = p.green if pc == 100 else (p.cyan if pc else p.dim)

        line = (f"\n{p.bold}{p.blue}{grouping.heading(k, members[0].group_label)}{p.reset}  "
                f"{p.dim}{done}/{len(counted)}{p.reset}  "
                f"{pcolor}{pc:>3}%{p.reset} {pcolor}{bar(done, len(counted))}{p.reset}  "
                f"{p.yellow}{openish} open{p.reset}")
        if in_prog:
            line += f"{p.dim} · {p.reset}{p.cyan}{in_prog} in progress{p.reset}"
        if blocked:
            line += f"{p.dim} · {p.reset}{p.red}{blocked} blocked{p.reset}"
        print(line)

        visible = listed(members)
        for n, it in enumerate(visible):
            if limit and n >= limit:
                break
            print(issue_line(it, p, width, by_num))
        # Count only what age hid, not what an explicit filter hid — telling a
        # user their --blocked view "hid 40 finished issues" is noise.
        hidden += sum(1 for i in members
                      if i not in visible and i.is_terminal and i.age_secs > RECENT_SECS)

    footer = []
    if hidden:
        footer.append(f"{hidden} finished issue{'s' if hidden != 1 else ''} untouched for "
                      f"over 3 days hidden (-a to show)")
    footer.append("a group at 100% is not a shipped group — its own exit criteria still apply")
    print(f"\n{p.dim}{' · '.join(footer)}{p.reset}\n")
    return 0


# --- main --------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="list-issues.py",
        description=("List issues with a summary of where the project stands. Grouped by "
                     "phase/milestone when project.json declares a grouping, otherwise by "
                     "relevance — freshest and most actionable first."),
        epilog=("DIR is a directory name relative to $PWD or an absolute path. Omitted, the "
                "script uses ./issues if present, otherwise shallow-scans $PWD and each parent "
                "up to the repo root for a folder holding Issues.md or project.json."),
    )
    ap.add_argument("dir", nargs="?", metavar="DIR", help="issues directory to read")
    ap.add_argument("-n", "--limit", type=int, default=0, metavar="N",
                    help="show at most N issues (per group when grouped; 0 = no limit)")
    ap.add_argument("-a", "--all", action="store_true", dest="show_all",
                    help="include finished issues untouched for over 3 days")
    ap.add_argument("-s", "--status", metavar="LIST",
                    help="only issues whose status is in this comma-separated list (implies -a)")
    ap.add_argument("-g", "--group", metavar="G", help="show only this group (e.g. 3, M2)")
    ap.add_argument("--open", action="store_true", dest="only_open",
                    help="hide finished issues; percentages still reflect everything")
    ap.add_argument("--blocked", action="store_true",
                    help="show only issues waiting on a human or an unresolved dependency")
    ap.add_argument("--next", action="store_true", dest="want_next",
                    help="print just the next actionable issue (id and title), or nothing")
    ap.add_argument("-S", "--summary-only", action="store_true", help="print the summary and stop")
    ap.add_argument("--no-summary", action="store_true", help="omit the summary block")
    ap.add_argument("--flat", action="store_true", help="force the relevance view")
    ap.add_argument("--by-group", action="store_true", help="force the grouped view")
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="emit machine-readable JSON and exit")
    ap.add_argument("--lint", action="store_true",
                    help="report issues with duplicated Status/group rows and exit")
    ap.add_argument("--version", action="version", version=f"list-issues.py v{SCRIPT_VERSION}")
    color = ap.add_mutually_exclusive_group()
    color.add_argument("--color", action="store_const", const="always", dest="color_mode")
    color.add_argument("--no-color", action="store_const", const="never", dest="color_mode")
    ap.set_defaults(color_mode="auto")
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    issues_dir = resolve_issues_dir(args.dir)
    if not issues_dir.is_dir():
        if args.dir:
            print(f"error: {issues_dir} not found", file=sys.stderr)
        else:
            print(f"error: no issues folder in {Path.cwd()} or any parent up to the repo root\n"
                  f"       (pass a directory: list-issues.py DIR)", file=sys.stderr)
        return 1

    project = load_project(issues_dir)
    name = str(project.get("name") or issues_dir.parent.name)
    grouping = Grouping.load(project.get("grouping") or {}, issues_dir)

    files = sorted(p for p in issues_dir.iterdir()
                   if p.is_file() and ISSUE_FILE_RE.match(p.name))
    if not files:
        print(f"no issue files in {issues_dir}", file=sys.stderr)
        return 0

    issues = [Issue(f, grouping) for f in files]
    by_num = {i.num.zfill(4): i for i in issues}

    if args.lint:
        bad = [i for i in issues if i.duplicate_metadata]
        for i in bad:
            print(f"{i.num}: duplicated Status/{grouping.field if grouping else 'group'} rows — "
                  f"reading status={i.status}")
        print(f"{len(bad)} issue(s) with duplicated metadata")
        return 1 if bad else 0

    if args.want_next:
        nxt = pick_next(issues, by_num, grouping)
        if not nxt:
            waiting = [i for i in issues if i.is_blocked]
            msg = "no actionable issue"
            if waiting:
                msg += f" ({len(waiting)} blocked: " + \
                       " ".join(f"#{i.num}" for i in waiting[:6]) + ")"
            print(msg, file=sys.stderr)
            return 1
        if args.as_json:
            print(json.dumps(nxt.as_dict(by_num), indent=2))
        else:
            print(f"{nxt.num}  {nxt.title}")
        return 0

    if args.as_json:
        kinds: dict[str, int] = {}
        for i in issues:
            kinds[i.kind] = kinds.get(i.kind, 0) + 1
        nxt = pick_next(issues, by_num, grouping)
        print(json.dumps({
            "project": name,
            "issues_dir": str(issues_dir),
            "grouping": grouping.field if grouping else None,
            "counts": kinds,
            "total": len(issues),
            "next": nxt.num if nxt else None,
            "issues": [i.as_dict(by_num) for i in issues],
        }, indent=2))
        return 0

    mode = args.color_mode
    use_color = mode == "always" or (
        mode == "auto" and sys.stdout.isatty() and not os.environ.get("NO_COLOR"))
    p = Palette(use_color)

    wanted: set[str] | None = None
    if args.status:
        wanted = {s.strip().lower() for s in args.status.split(",") if s.strip()}

    if not args.no_summary:
        # The summary always describes the whole folder, before any filtering.
        print_summary(issues, name, grouping, p, by_num)
        sys.stdout.flush()
    if args.summary_only:
        return 0

    def listed(members: list[Issue]) -> list[Issue]:
        """Filter for display only — counts above never move because of it."""
        out = []
        for it in members:
            if wanted is not None and it.status.lower() not in wanted:
                continue
            if args.blocked and not (it.is_blocked or it.unresolved_deps(by_num)):
                continue
            finished = it.is_terminal
            if args.only_open and finished:
                continue
            if not (args.show_all or wanted) and finished and it.age_secs > RECENT_SECS:
                continue
            out.append(it)
        return out

    grouped = (grouping is not None and not args.flat) or args.by_group
    if grouped and grouping is None:
        print("warning: --by-group needs a `grouping` object in project.json", file=sys.stderr)
        grouped = False

    if not use_color:
        for it in sorted(listed(issues), key=lambda i: i.number):
            g = f"  {it.group_key:<6}" if grouping else ""
            print(f"{it.num}  {it.status:<12}{g}  {human_age(it.age_secs):>5}  {it.title}")
        return 0

    if grouped:
        return print_grouped(issues, listed, grouping, name, p, by_num, args.group, args.limit)

    shown, hidden = [], 0
    for it in issues:
        if wanted is not None and it.status.lower() not in wanted:
            continue
        if args.blocked and not (it.is_blocked or it.unresolved_deps(by_num)):
            continue
        if args.only_open and it.is_terminal:
            continue
        # Rank buckets, lower is more relevant: fresh work, fresh finishes,
        # stale-but-open, blocked, resolved-this-week, older finishes.
        if it.is_blocked:
            it.rank = 3
        elif it.age_secs <= FRESH_SECS:
            it.rank = 1 if it.is_terminal else 0
        elif not it.is_terminal:
            it.rank = 2
        elif it.age_secs <= RECENT_SECS:
            it.rank = 4
        elif args.show_all or wanted is not None:
            it.rank = 5
        else:
            hidden += 1
            continue
        shown.append(it)

    if not shown:
        if hidden:
            print(f"no current issues in {issues_dir.name} "
                  f"({hidden} finished over 3 days ago hidden; use -a to show)",
                  file=sys.stderr)
        else:
            print(f"no issues matched in {issues_dir}", file=sys.stderr)
        return 0

    shown.sort(key=lambda i: (i.rank, -i.mtime))
    if args.limit > 0:
        shown = shown[: args.limit]
    print_flat(shown, p, by_num, hidden)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BrokenPipeError:
        # Piping into head/less closes the pipe early; that is not an error.
        # Redirect the fd *and* replace the wrapper — the buffered text left in
        # the old one would otherwise fail again during interpreter shutdown
        # and print "Exception ignored in <TextIOWrapper>" after a clean exit.
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        sys.stdout = open(os.devnull, "w")
        sys.exit(0)
    except KeyboardInterrupt:
        sys.exit(130)
