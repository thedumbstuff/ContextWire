"""Tests for the ContextWire watchtower (roadmap engine + feature backlog).

    python -m unittest discover -s watchtower/tests -q
"""

from __future__ import annotations

import io
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402

ROADMAP = textwrap.dedent("""
    project: demo
    tagline: test
    open_decisions:
      - {id: D1, title: pick, status: open, blocks: [P1.2]}
    phases:
      - id: P1
        name: one
        tasks:
          - {id: P1.1, title: exists, status: done, effort: 2, checks: [{type: path, path: here.txt}]}
          - {id: P1.2, title: missing file, status: done, effort: 1, checks: [{type: path, path: nope.txt}]}
          - {id: P1.3, title: next, status: pending, effort: 3, depends_on: [P1.1]}
          - {id: P1.4, title: waits, status: pending, effort: 1, depends_on: [P1.3]}
    features:
      - {id: F1, title: good, source: own, area: console, status: shipped, task: P1.1}
      - {id: F2, title: lying, source: official, area: review, status: shipped, task: P1.2}
      - {id: F3, title: later, source: official, area: review, status: idea}
""")


class WatchtowerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "roadmap.yaml").write_text(ROADMAP, encoding="utf-8")
        (self.root / "here.txt").write_text("x", encoding="utf-8")
        server.clear_cache()

    def tearDown(self):
        self.tmp.cleanup()

    def state(self):
        return server.full_state(self.root, check_types=("path",))

    def test_effective_statuses(self):
        tasks = {t["id"]: t for p in self.state()["phases"] for t in p["tasks"]}
        self.assertEqual(tasks["P1.1"]["effective_status"], "verified")
        self.assertEqual(tasks["P1.2"]["effective_status"], "claimed")
        self.assertEqual(tasks["P1.3"]["effective_status"], "ready")
        self.assertEqual(tasks["P1.4"]["effective_status"], "blocked_by_deps")

    def test_feature_mismatch_flags_shipped_on_unverified_task(self):
        fe = self.state()["features"]
        self.assertEqual(fe["mismatches"], ["F2"])
        self.assertEqual(fe["counts"]["shipped"], 2)
        self.assertEqual(fe["by_source"]["official"]["idea"], 1)
        f1 = next(i for i in fe["items"] if i["id"] == "F1")
        self.assertEqual(f1["task_status"], "verified")

    def test_unquoted_comma_in_flow_mapping_is_reported(self):
        bad = ROADMAP.replace("title: later,", "title: later, with comma,")
        (self.root / "roadmap.yaml").write_text(bad, encoding="utf-8")
        problems = self.state()["problems"]
        self.assertTrue(any("F3: unknown keys" in p for p in problems), problems)

    def test_feature_lint_bad_values(self):
        bad = ROADMAP.replace("status: idea}", "status: maybe, task: P9.9}").replace("source: own", "source: theirs")
        (self.root / "roadmap.yaml").write_text(bad, encoding="utf-8")
        problems = "\n".join(self.state()["problems"])
        self.assertIn("F3: invalid status 'maybe'", problems)
        self.assertIn("F3: task references unknown task P9.9", problems)
        self.assertIn("F1: invalid source 'theirs'", problems)

    def test_print_functions_run(self):
        s = self.state()
        buf = io.StringIO()
        server.print_summary(s, buf)
        server.print_features(s, buf)
        self.assertIn("CLAIMED", buf.getvalue())
        self.assertIn("MISMATCH", buf.getvalue())

    def test_real_roadmap_is_clean(self):
        state = server.full_state(server.REPO_ROOT, run_checks=False)
        self.assertEqual(state["problems"], [])
        self.assertTrue(state["features"]["items"])


if __name__ == "__main__":
    unittest.main()
