#!/usr/bin/env python3
"""Pick the next workable issue for one track, or list a track's issues.

Usage:
  scripts/next-issue.py A            # next issue for Track A (milestones A0, A1, ...)
  scripts/next-issue.py B --list     # every Track B issue with status and blockers

An issue is workable when its Status is `open`, it has no `## Blocked`
section, and every issue it names with "Depends on #NNNN" or "Blocked by
#NNNN" is `resolved` or `closed`. Milestones are drained in order (A0 before
A1), then by issue number. Prints `NNNN  <milestone>  <title>`; exits 1 with
nothing on stdout when no issue is workable. Stdlib only.
"""
import pathlib
import re
import sys

ISSUES = pathlib.Path(__file__).resolve().parent.parent / "issues"
DONE = {"resolved", "closed"}
ROW = re.compile(r"^\|\s*\*\*(?P<k>[^*]+)\*\*\s*\|\s*(?P<v>.*?)\s*\|\s*$")
DEP = re.compile(r"(?:depends on|blocked by|blocked on)\s+((?:#\d{4}[\s,and]*)+)", re.I)
MILESTONE = re.compile(r"^(?P<track>[A-Z])(?P<num>\d+)")


def load():
    issues = {}
    for path in sorted(ISSUES.glob("[0-9][0-9][0-9][0-9].md")):
        text = path.read_text(encoding="utf-8")
        lines = text.splitlines()
        title = lines[0].split("—", 1)[-1].strip() if lines else ""
        meta = {}
        for line in lines[1:]:
            if line.startswith("## "):
                break
            m = ROW.match(line)
            if m and m["k"] not in meta:  # first row wins
                meta[m["k"]] = m["v"]
        deps = {d for grp in DEP.findall(text) for d in re.findall(r"#(\d{4})", grp)}
        issues[path.stem] = {
            "id": path.stem,
            "title": title,
            "status": meta.get("Status", "").lower(),
            "milestone": meta.get("Milestone", ""),
            "deps": sorted(deps - {path.stem}),
            "blocked_section": "\n## Blocked" in text,
        }
    return issues


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 2
    track = argv[0].upper()
    issues = load()

    def key(i):
        m = MILESTONE.match(i["milestone"])
        return (int(m["num"]) if m else 99, i["id"])

    mine = sorted(
        (i for i in issues.values() if i["milestone"].upper().startswith(track)), key=key
    )
    if not mine:
        print(f"no issues with a Milestone starting with {track!r}", file=sys.stderr)
        return 1

    def waiting(i):
        return [d for d in i["deps"] if issues.get(d, {}).get("status") not in DONE]

    if "--list" in argv:
        for i in mine:
            w = waiting(i)
            extra = f"  waits on #{', #'.join(w)}" if w and i["status"] not in DONE else ""
            ms = i["milestone"].split()[0] if i["milestone"] else "-"
            print(f"{i['id']}  {i['status']:<11} {ms:<4} {i['title']}{extra}")
        return 0

    for i in mine:
        if i["status"] == "open" and not i["blocked_section"] and not waiting(i):
            print(f"{i['id']}  {i['milestone'].split()[0]}  {i['title']}")
            return 0
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
