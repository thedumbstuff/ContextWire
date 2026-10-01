"""Watchtower - build-progress dashboard for ContextWire.

Adapted from opensource/statarb/watchtower (the reference implementation).
Reads ``roadmap.yaml`` (the single source of truth) on every request, runs each
task's checks, derives an effective status per task and serves the result as
JSON plus a single-page UI with two tabs: Build (phases/tasks/decisions) and
Features (the feature backlog, incl. features noted from the official Claude
desktop app for later upgrades).

    python watchtower/server.py              # serve on http://127.0.0.1:8766
    python watchtower/server.py --once       # print a terminal summary and exit
    python watchtower/server.py --once --features   # feature backlog summary
    python watchtower/server.py --no-checks  # skip running checks

Effective status (see the roadmap.yaml header):
    done + all checks pass    -> verified
    done + any check fails    -> claimed
    in_progress               -> in_progress
    blocked                   -> blocked
    pending with unmet deps   -> blocked_by_deps
    pending otherwise         -> ready

Stdlib only plus PyYAML.
"""


from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import yaml

WATCHTOWER_DIR = Path(__file__).resolve().parent
REPO_ROOT = WATCHTOWER_DIR.parent
STATIC_DIR = WATCHTOWER_DIR / "static"
ROADMAP_NAME = "roadmap.yaml"

CHECK_TTL_S = 60.0
CMD_TIMEOUT_S = 120
IMPORT_TIMEOUT_S = 120

VALID_STATUSES = ("done", "in_progress", "pending", "blocked")
DECISION_STATUSES = ("open", "resolved", "deferred")
EFFECTIVE_STATUSES = ("verified", "claimed", "in_progress", "ready", "blocked_by_deps", "blocked")
CHECKED_STATUSES = ("done", "in_progress")
ALL_CHECK_TYPES = ("path", "import", "cmd")


# ---------------------------------------------------------------- roadmap io

def load_roadmap(root: Path = REPO_ROOT) -> dict:
    """Parse roadmap.yaml under ``root``. Raises on missing file or bad YAML."""
    with open(Path(root) / ROADMAP_NAME, encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    if not isinstance(data, dict):
        raise ValueError("roadmap.yaml must be a mapping at the top level")
    data.setdefault("phases", [])
    data.setdefault("open_decisions", [])
    return data


def iter_tasks(roadmap: dict):
    """Yield (phase, task) pairs in file order."""
    for phase in roadmap.get("phases") or []:
        for task in phase.get("tasks") or []:
            yield phase, task


def lint_roadmap(roadmap: dict) -> list[str]:
    """Return a list of structural problems (empty list = clean roadmap)."""
    problems: list[str] = []
    task_ids = [str(t.get("id")) for _, t in iter_tasks(roadmap)]
    decision_ids = [str(d.get("id")) for d in roadmap.get("open_decisions") or []]
    phase_ids = [str(p.get("id")) for p in roadmap.get("phases") or []]

    for label, ids in (("task", task_ids), ("decision", decision_ids), ("phase", phase_ids)):
        seen: set[str] = set()
        for i in ids:
            if i in seen:
                problems.append(f"duplicate {label} id {i}")
            seen.add(i)

    known_tasks = set(task_ids)
    known_decisions = set(decision_ids)
    for _, t in iter_tasks(roadmap):
        tid = t.get("id")
        if not t.get("title"):
            problems.append(f"{tid}: missing title")
        if t.get("status") not in VALID_STATUSES:
            problems.append(f"{tid}: invalid status {t.get('status')!r}")
        eff = t.get("effort")
        if not isinstance(eff, int) or isinstance(eff, bool) or not 1 <= eff <= 5:
            problems.append(f"{tid}: effort must be an int 1..5, got {eff!r}")
        for dep in t.get("depends_on") or []:
            if str(dep) not in known_tasks:
                problems.append(f"{tid}: depends_on unknown task {dep}")
            if str(dep) == str(tid):
                problems.append(f"{tid}: depends on itself")
        dec = t.get("decision")
        if dec is not None and str(dec) not in known_decisions:
            problems.append(f"{tid}: decision references unknown decision {dec}")
        for chk in t.get("checks") or []:
            ctype = chk.get("type") if isinstance(chk, dict) else None
            if ctype not in ALL_CHECK_TYPES:
                problems.append(f"{tid}: unknown check type {ctype!r}")
    for d in roadmap.get("open_decisions") or []:
        if str(d.get("status") or "open").strip().lower() not in DECISION_STATUSES:
            problems.append(f"decision {d.get('id')}: invalid status {d.get('status')!r} "
                            f"(expected one of {', '.join(DECISION_STATUSES)})")
        for b in d.get("blocks") or []:
            if str(b) not in known_tasks:
                problems.append(f"decision {d.get('id')}: blocks unknown task {b}")
    problems.extend(_find_cycles(roadmap))
    return problems


def _find_cycles(roadmap: dict) -> list[str]:
    graph = {str(t.get("id")): [str(d) for d in t.get("depends_on") or []] for _, t in iter_tasks(roadmap)}
    state: dict[str, int] = {}
    found: list[str] = []

    def visit(n: str, stack: list[str]) -> None:
        state[n] = 1
        for m in graph.get(n, []):
            if m not in graph:
                continue
            if state.get(m) == 1:
                found.append("dependency cycle: " + " -> ".join(stack[stack.index(m):] + [m]))
            elif m not in state:
                visit(m, stack + [m])
        state[n] = 2

    for n in graph:
        if n not in state:
            visit(n, [n])
    return found


# ---------------------------------------------------------------- checks

_cache: dict[tuple, tuple[float, dict]] = {}
_cache_lock = threading.Lock()
_key_locks: dict[tuple, threading.Lock] = {}


def check_target(check: dict) -> str:
    return str(check.get("path") or check.get("module") or check.get("run") or "")


def _tail(text: str, limit: int = 600) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else "..." + text[-limit:]


def _windows_cmd(cmd: str) -> str:
    """cmd.exe reads '/x' as a switch, so an unquoted 'venv/Scripts/python.exe'
    fails. Normalise slashes in the leading executable token only."""
    if os.name != "nt":
        return cmd
    head, sep, rest = cmd.lstrip().partition(" ")
    if "/" in head and not head.startswith(("/", "-", '"')) and "://" not in head:
        head = head.replace("/", "\\")
    return head + sep + rest


def run_check(check: dict, root: Path, venv_python: str | None) -> dict:
    """Run one check and return {ok, detail}. Never raises."""
    ctype = check.get("type")
    root = Path(root)
    try:
        if ctype == "path":
            rel = str(check.get("path", ""))
            p = root / rel
            if rel and p.exists():
                kind = "dir" if p.is_dir() else f"{p.stat().st_size} bytes"
                return {"ok": True, "detail": f"exists ({kind})"}
            return {"ok": False, "detail": f"missing: {rel}"}

        if ctype == "import":
            module = str(check.get("module", ""))
            if not venv_python:
                return {"ok": False, "detail": "venv missing (no venv_python in roadmap.yaml)"}
            py = root / venv_python
            if not py.exists():
                return {"ok": False, "detail": "venv missing"}
            proc = subprocess.run(
                [str(py), "-c", f"import {module}"],
                cwd=root, capture_output=True, text=True, timeout=IMPORT_TIMEOUT_S,
            )
            if proc.returncode == 0:
                return {"ok": True, "detail": f"import {module} ok"}
            err = (proc.stderr or proc.stdout or "").strip().splitlines()
            return {"ok": False, "detail": err[-1] if err else f"exit {proc.returncode}"}

        if ctype == "cmd":
            cmd = str(check.get("run", ""))
            proc = subprocess.run(
                _windows_cmd(cmd), shell=True, cwd=root,
                capture_output=True, text=True, timeout=CMD_TIMEOUT_S,
            )
            out = _tail((proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else ""))
            if proc.returncode == 0:
                return {"ok": True, "detail": out or "exit 0"}
            return {"ok": False, "detail": f"exit {proc.returncode}: {out}" if out else f"exit {proc.returncode}"}

        return {"ok": False, "detail": f"unknown check type {ctype!r}"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "detail": f"timed out after {CMD_TIMEOUT_S}s"}
    except Exception as exc:  # a broken check must never break the dashboard
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


def cached_check(check: dict, root: Path, venv_python: str | None, force: bool = False) -> dict:
    """run_check with a per-check TTL cache; ``force`` re-runs regardless."""
    key = (str(root), str(venv_python)) + tuple(sorted((str(k), str(v)) for k, v in check.items()))
    with _cache_lock:
        lock = _key_locks.setdefault(key, threading.Lock())
    with lock:  # concurrent requests wait for one run instead of duplicating it
        with _cache_lock:
            hit = _cache.get(key)
        if hit and not force and time.time() - hit[0] < CHECK_TTL_S:
            return dict(hit[1], cached=True, ran_at=hit[0])
        started = time.time()
        result = run_check(check, root, venv_python)
        with _cache_lock:
            _cache[key] = (started, result)
        return dict(result, cached=False, ran_at=started)


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


# ---------------------------------------------------------------- state

def git_info(root: Path) -> dict:
    try:
        proc = subprocess.run(
            ["git", "log", "-1", "--format=%h%x1f%cI%x1f%s"],
            cwd=root, capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"available": False, "detail": f"git unavailable: {exc}"}
    if proc.returncode != 0 or not proc.stdout.strip():
        detail = (proc.stderr or "").strip().splitlines()
        return {"available": False, "detail": detail[-1] if detail else "no commits"}
    h, date, subject = (proc.stdout.strip().split("\x1f") + ["", "", ""])[:3]
    return {"available": True, "hash": h, "date": date, "subject": subject}


def decision_status(decision: dict) -> str:
    """open | resolved | deferred; missing means open. Unknown values count as
    open (so they keep blocking) and are reported by lint_roadmap."""
    st = str(decision.get("status") or "open").strip().lower()
    return st if st in DECISION_STATUSES else "open"


def effective_status(status: str, unmet_deps: list, checks: list[dict]) -> str:
    """Map a task's declared status plus derived facts to the UI status."""
    if status == "done":
        return "claimed" if any(c.get("ok") is False for c in checks) else "verified"
    if status == "in_progress":
        return "in_progress"
    if status == "blocked":
        return "blocked"
    return "blocked_by_deps" if unmet_deps else "ready"


def progress(tasks: list[dict]) -> dict:
    total = sum(t["effort"] for t in tasks)
    effort = {s: 0 for s in EFFECTIVE_STATUSES}
    counts = {s: 0 for s in EFFECTIVE_STATUSES}
    for t in tasks:
        effort[t["effective_status"]] += t["effort"]
        counts[t["effective_status"]] += 1

    def pct(x: float) -> float:
        return round(100.0 * x / total, 1) if total else 0.0

    return {
        "effort_total": total,
        "effort": effort,
        "counts": counts,
        "tasks_total": len(tasks),
        "pct_verified": pct(effort["verified"]),
        # everything marked done, whether or not its checks pass
        "pct_claimed": pct(effort["verified"] + effort["claimed"]),
        "pct_claimed_only": pct(effort["claimed"]),
        "pct_in_progress": pct(effort["in_progress"]),
    }


def _task_sort_key(task: dict, phase_order: dict) -> tuple:
    try:
        num = tuple(int(p) for p in task["id"].lstrip("P").split("."))
    except ValueError:
        num = (10 ** 6,)
    return (phase_order.get(task["phase"], 10 ** 6), num, task["id"])


def build_state(root: Path = REPO_ROOT, run_checks: bool = True, refresh: bool = False,
                check_types: tuple[str, ...] = ALL_CHECK_TYPES) -> dict:
    """Build the full dashboard state.

    ``run_checks=False`` skips all checks. ``check_types`` restricts which check
    types execute (tests pass ("path",)); the rest are reported as "not run".
    """
    root = Path(root)
    roadmap = load_roadmap(root)
    venv_python = roadmap.get("venv_python")
    decisions = {str(d.get("id")): d for d in roadmap.get("open_decisions") or []}
    raw = list(iter_tasks(roadmap))
    status_by_id = {str(t.get("id")): t.get("status") for _, t in raw}

    # run every eligible check concurrently - they are subprocess/IO bound
    results: dict[tuple[str, int], dict] = {}
    if run_checks:
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = {}
            for _, t in raw:
                if t.get("status") not in CHECKED_STATUSES:
                    continue
                for i, chk in enumerate(t.get("checks") or []):
                    if isinstance(chk, dict) and chk.get("type") in check_types:
                        futures[(str(t.get("id")), i)] = pool.submit(
                            cached_check, chk, root, venv_python, refresh)
            results = {k: f.result() for k, f in futures.items()}

    phases_out, all_tasks, phase_order = [], [], {}
    for pi, phase in enumerate(roadmap.get("phases") or []):
        pid = str(phase.get("id"))
        phase_order[pid] = pi
        ptasks = []
        for t in phase.get("tasks") or []:
            tid = str(t.get("id"))
            status = t.get("status", "pending")
            deps = [str(d) for d in t.get("depends_on") or []]
            unmet = [d for d in deps if status_by_id.get(d) != "done"]

            checks_out = []
            for i, chk in enumerate(t.get("checks") or []):
                chk = chk if isinstance(chk, dict) else {"type": None}
                r = results.get((tid, i))
                base = {"type": chk.get("type"), "target": check_target(chk)}
                if r is None:
                    if not run_checks:
                        reason = "not run (checks disabled)"
                    elif status not in CHECKED_STATUSES:
                        reason = f"not run (task is {status})"
                    else:
                        reason = "not run (check type disabled)"
                    checks_out.append({**base, "ok": None, "detail": reason, "ran": False})
                else:
                    checks_out.append({**base, "ok": r["ok"], "detail": r["detail"], "ran": True,
                                       "cached": r["cached"],
                                       "ran_at": datetime.fromtimestamp(r["ran_at"], timezone.utc)
                                       .isoformat(timespec="seconds")})
            failed = sum(1 for c in checks_out if c["ok"] is False)
            eff = effective_status(status, unmet, checks_out)

            dec_id = t.get("decision")
            dec = decisions.get(str(dec_id)) if dec_id is not None else None
            why = []
            if eff == "claimed":
                why.append(f"Marked done but {failed} check(s) fail.")
            if t.get("why"):
                why.append(str(t["why"]).strip())
            dec_status = decision_status(dec) if dec is not None else None
            if dec_status == "resolved":
                outcome = f" - {dec['outcome']}" if dec.get("outcome") else ""
                why.append(f"Decision {dec_id} resolved: {dec.get('title')}{outcome}.")
            elif dec is not None:
                label = " (deferred)" if dec_status == "deferred" else ""
                why.append(f"Gated on decision {dec_id}{label}: {dec.get('title')}.")
            elif dec_id is not None:
                why.append(f"Gated on decision {dec_id} (not in open_decisions).")
            if unmet:
                why.append("Waiting on " + ", ".join(unmet) + ".")

            task_out = {
                "id": tid,
                "phase": pid,
                "title": t.get("title", ""),
                "status": status,
                "effective_status": eff,
                "effort": int(t.get("effort") or 0),
                "depends_on": deps,
                "unmet_deps": unmet,
                "decision": None if dec_id is None else str(dec_id),
                "decision_title": dec.get("title") if dec else None,
                "decision_status": dec_status,
                "task_why": t.get("why"),
                "why": " ".join(why),
                "checks": checks_out,
                "checks_summary": {
                    "total": len(checks_out),
                    "passed": sum(1 for c in checks_out if c["ok"] is True),
                    "failed": failed,
                    "not_run": sum(1 for c in checks_out if not c["ran"]),
                },
            }
            ptasks.append(task_out)
            all_tasks.append(task_out)
        phases_out.append({"id": pid, "name": phase.get("name", ""), "goal": phase.get("goal", ""),
                           "progress": progress(ptasks), "tasks": ptasks})

    by_id = {t["id"]: t for t in all_tasks}
    decisions_out, resolved_out = [], []
    for did, d in decisions.items():
        dstatus = decision_status(d)
        declared = [str(b) for b in d.get("blocks") or []]
        declared += [t["id"] for t in all_tasks if t["decision"] == did and t["id"] not in declared]
        # a resolved decision blocks nothing, whatever its blocks list still says
        blocks = [] if dstatus == "resolved" else declared
        entry = {
            "id": did, "title": d.get("title", ""), "status": dstatus,
            "outcome": d.get("outcome"), "why": d.get("why", ""),
            "default": d.get("default", ""), "blocks": blocks,
            "blocks_open": [b for b in blocks if by_id.get(b, {}).get("status") != "done"],
            "blocks_declared": declared,
        }
        (resolved_out if dstatus == "resolved" else decisions_out).append(entry)

    next_up = sorted((t for t in all_tasks if t["effective_status"] == "ready"),
                     key=lambda t: _task_sort_key(t, phase_order))
    mtime = (root / ROADMAP_NAME).stat().st_mtime
    return {
        "project": roadmap.get("project", root.name),
        "tagline": roadmap.get("tagline", ""),
        "updated": str(roadmap.get("updated", "")),
        "venv_python": venv_python,
        "venv_present": bool(venv_python) and (root / str(venv_python)).exists(),
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "roadmap_mtime": datetime.fromtimestamp(mtime, timezone.utc).isoformat(timespec="seconds"),
        "checks_enabled": run_checks,
        "check_ttl_s": CHECK_TTL_S,
        "git": git_info(root),
        "overall": progress(all_tasks),
        "phases": phases_out,
        "decisions": decisions_out,  # open + deferred
        "resolved_decisions": resolved_out,
        "next_up": [{"id": t["id"], "phase": t["phase"], "title": t["title"],
                     "effort": t["effort"], "why": t["why"]} for t in next_up],
        "claimed": [t["id"] for t in all_tasks if t["effective_status"] == "claimed"],
        "problems": lint_roadmap(roadmap),
    }


# ---------------------------------------------------------------- terminal

def _bar(pv: float, pc: float, pi: float, width: int = 30) -> str:
    v = round(width * pv / 100)
    c = max(round(width * pc / 100) - v, 0)
    i = max(min(width - v - c, round(width * pi / 100)), 0)
    return "[" + "#" * v + "!" * c + "~" * i + "." * (width - v - c - i) + "]"


def _clip(s, n: int) -> str:
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 3] + "..."


def print_summary(state: dict, out=None) -> None:
    w = (out or sys.stdout).write
    o = state["overall"]
    g = state["git"]
    w(f"{state['project']} - {state['tagline']}\n")
    if g.get("available"):
        w(f"last commit : {g['hash']} {g['date']}  {g['subject']}\n")
    else:
        w(f"last commit : none ({g.get('detail')})\n")
    w(f"roadmap.yaml: modified {state['roadmap_mtime']}   checks: {'on' if state['checks_enabled'] else 'OFF'}"
      f"\n")
    w("legend      : # verified   ! claimed (done but a check fails)   ~ in progress\n\n")
    w(f"OVERALL {_bar(o['pct_verified'], o['pct_claimed'], o['pct_in_progress'])}  "
      f"verified {o['pct_verified']:.1f}%  claimed {o['pct_claimed']:.1f}%  "
      f"in progress {o['pct_in_progress']:.1f}%   ({o['effort_total']} pts, {o['tasks_total']} tasks)\n\n")
    w(f"{'phase':<6}{'name':<26}{'progress':<33}{'ver%':>6}{'clm%':>7}{'wip%':>7}{'pts':>5}\n")
    for p in state["phases"]:
        pr = p["progress"]
        w(f"{p['id']:<6}{_clip(p['name'], 25):<26}{_bar(pr['pct_verified'], pr['pct_claimed'], pr['pct_in_progress']):<33}"
          f"{pr['pct_verified']:6.1f}{pr['pct_claimed']:7.1f}{pr['pct_in_progress']:7.1f}{pr['effort_total']:5d}\n")

    tasks = [t for p in state["phases"] for t in p["tasks"]]

    def fails(t):
        for c in t["checks"]:
            if c["ok"] is False:
                w(f"          FAIL {c['type']:<6} {_clip(c['target'], 45)}\n"
                  f"               -> {_clip(c['detail'], 90)}\n")

    claimed = [t for t in tasks if t["effective_status"] == "claimed"]
    if claimed:
        w(f"\n!!! CLAIMED ({len(claimed)}) - marked done but a check fails:\n")
        for t in claimed:
            w(f"  {t['id']:<7} {_clip(t['title'], 90)}\n")
            fails(t)

    wip = [t for t in tasks if t["effective_status"] == "in_progress"]
    if wip:
        w(f"\nIN PROGRESS ({len(wip)}) - check results as a live hint:\n")
        for t in wip:
            s = t["checks_summary"]
            w(f"  {t['id']:<7} checks {s['passed']}/{s['total']} pass  {_clip(t['title'], 70)}\n")
            fails(t)

    blocked = [t for t in tasks if t["effective_status"] in ("blocked", "blocked_by_deps")]
    w(f"\nBLOCKED ({len(blocked)}):\n")
    for t in blocked:
        tag = "decision" if t["effective_status"] == "blocked" else "deps"
        w(f"  {t['id']:<7} [{tag:<8}] {_clip(t['why'] or t['title'], 100)}\n")

    w(f"\nNEXT UP ({len(state['next_up'])} ready, nothing blocking):\n")
    for t in state["next_up"]:
        w(f"  {t['id']:<7} ({t['effort']}pt) {_clip(t['title'], 95)}\n")
    if not state["next_up"]:
        w("  (none)\n")

    w(f"\nOPEN DECISIONS ({len(state['decisions'])}):\n")
    for d in state["decisions"]:
        tag = "DEFERRED " if d["status"] == "deferred" else ""
        w(f"  {d['id']:<4} {tag}{_clip(d['title'], 32):<33} blocks {', '.join(d['blocks']) or '-'}\n")
        if d.get("outcome"):
            w(f"       -> {_clip(d['outcome'], 95)}\n")
    if not state["decisions"]:
        w("  (none)\n")
    resolved = state.get("resolved_decisions") or []
    if resolved:
        w(f"resolved: {', '.join(d['id'] for d in resolved)}\n")

    if state["problems"]:
        w(f"\nROADMAP PROBLEMS ({len(state['problems'])}):\n")
        for pr in state["problems"]:
            w(f"  - {pr}\n")




# ---------------------------------------------------------------- features

FEATURE_STATUSES = ("shipped", "building", "planned", "idea", "wont")
FEATURE_SOURCES = ("own", "official")
FEATURE_KEYS = ("id", "title", "source", "area", "status", "task", "note")


def lint_features(roadmap: dict, task_ids: set[str]) -> list[str]:
    problems: list[str] = []
    seen: set[str] = set()
    for f in roadmap.get("features") or []:
        fid = str(f.get("id"))
        if fid in seen:
            problems.append(f"duplicate feature id {fid}")
        seen.add(fid)
        if not f.get("title"):
            problems.append(f"feature {fid}: missing title")
        extra = sorted(str(k) for k in f if k not in FEATURE_KEYS)
        if extra:  # usually an unquoted comma inside a {flow: mapping}
            problems.append(f"feature {fid}: unknown keys {extra} (quote values that contain commas)")
        if f.get("status") not in FEATURE_STATUSES:
            problems.append(f"feature {fid}: invalid status {f.get('status')!r}")
        if f.get("source") not in FEATURE_SOURCES:
            problems.append(f"feature {fid}: invalid source {f.get('source')!r}")
        if f.get("task") is not None and str(f.get("task")) not in task_ids:
            problems.append(f"feature {fid}: task references unknown task {f.get('task')}")
    return problems


def build_features(state: dict, roadmap: dict) -> dict:
    """Feature backlog joined with the live status of the task that delivers it.

    A feature declared ``shipped`` whose task is not verified is flagged
    ``mismatch`` - the same honesty rule as CLAIMED tasks."""
    by_id = {t["id"]: t for p in state["phases"] for t in p["tasks"]}
    items = []
    for f in roadmap.get("features") or []:
        tid = None if f.get("task") is None else str(f.get("task"))
        task = by_id.get(tid) if tid else None
        task_eff = task["effective_status"] if task else None
        status = f.get("status")
        items.append({
            "id": str(f.get("id")), "title": f.get("title", ""), "source": f.get("source"),
            "area": f.get("area") or "other", "status": status, "note": f.get("note") or "",
            "task": tid, "task_title": task["title"] if task else None, "task_status": task_eff,
            "mismatch": status == "shipped" and task is not None and task_eff != "verified",
        })
    counts = {s: sum(1 for i in items if i["status"] == s) for s in FEATURE_STATUSES}
    by_source = {s: {k: sum(1 for i in items if i["source"] == s and i["status"] == k)
                     for k in FEATURE_STATUSES} for s in FEATURE_SOURCES}
    return {"items": items, "counts": counts, "by_source": by_source,
            "mismatches": [i["id"] for i in items if i["mismatch"]]}


def print_features(state: dict, out=None) -> None:
    w = (out or sys.stdout).write
    fe = state["features"]
    c = fe["counts"]
    w(f"FEATURES  shipped {c['shipped']}  building {c['building']}  planned {c['planned']}  "
      f"idea {c['idea']}  wont {c['wont']}\n")
    for src, label in (("own", "ContextWire core"), ("official", "from the official Claude desktop app")):
        w(f"\n{label}:\n")
        for i in fe["items"]:
            if i["source"] != src:
                continue
            task = f"  [{i['task']} {i['task_status']}]" if i["task"] else ""
            flag = "  !! MISMATCH" if i["mismatch"] else ""
            w(f"  {i['id']:<4} {i['status']:<8} {_clip(i['title'], 70)}{task}{flag}\n")


# ---------------------------------------------------------------- http

CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8", ".json": "application/json",
                 ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon"}


class Handler(BaseHTTPRequestHandler):
    server_version = "watchtower/1.0"
    run_checks = True
    root = REPO_ROOT

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj) -> None:
        self._send(code, json.dumps(obj, indent=1).encode("utf-8"), "application/json; charset=utf-8")

    def do_GET(self):  # noqa: N802
        url = urlparse(self.path)
        if url.path == "/api/state":
            refresh = parse_qs(url.query).get("refresh", ["0"])[0].lower() in ("1", "true", "yes")
            try:
                state = full_state(self.root, run_checks=self.run_checks, refresh=refresh)
            except Exception as exc:  # e.g. roadmap.yaml mid-edit and invalid
                self._json(500, {"error": f"{type(exc).__name__}: {exc}"})
                return
            self._json(200, state)
        elif url.path in ("/", "/index.html"):
            self._static("index.html")
        elif url.path.startswith("/static/"):
            self._static(url.path[len("/static/"):])
        else:
            self._send(404, b"not found", "text/plain; charset=utf-8")

    def _static(self, rel: str) -> None:
        base = STATIC_DIR.resolve()
        target = (base / rel).resolve()
        if base not in target.parents:
            self._send(403, b"forbidden", "text/plain; charset=utf-8")
        elif not target.is_file():
            self._send(404, b"not found", "text/plain; charset=utf-8")
        else:
            self._send(200, target.read_bytes(), CONTENT_TYPES.get(target.suffix, "application/octet-stream"))



def full_state(root: Path = REPO_ROOT, run_checks: bool = True, refresh: bool = False,
               check_types: tuple[str, ...] = ALL_CHECK_TYPES) -> dict:
    state = build_state(root, run_checks=run_checks, refresh=refresh, check_types=check_types)
    roadmap = load_roadmap(root)
    task_ids = {str(t.get("id")) for _, t in iter_tasks(roadmap)}
    state["features"] = build_features(state, roadmap)
    state["problems"] = state["problems"] + lint_features(roadmap, task_ids)
    return state


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="ContextWire watchtower build dashboard")
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--once", action="store_true", help="print a terminal summary and exit")
    ap.add_argument("--json", action="store_true", help="with --once, print the JSON state instead")
    ap.add_argument("--features", action="store_true", help="with --once, print the feature backlog")
    ap.add_argument("--no-checks", action="store_true", help="do not run checks")
    args = ap.parse_args(argv)

    if args.once:
        state = full_state(REPO_ROOT, run_checks=not args.no_checks)
        if args.json:
            print(json.dumps(state, indent=1))
        elif args.features:
            print_features(state)
        else:
            print_summary(state)
        return 0

    Handler.run_checks = not args.no_checks
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"watchtower: {REPO_ROOT / ROADMAP_NAME} -> http://{args.host}:{args.port} "
          f"(checks {'on' if Handler.run_checks else 'off'}, ttl {int(CHECK_TTL_S)}s)", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
