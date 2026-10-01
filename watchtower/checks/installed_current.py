"""Watchtower check: the installed ContextWire is the latest build of the latest source.

Passes when
  1. %LOCALAPPDATA%\\ContextWire\\contextwire.exe is byte-identical to
     src-tauri/target/release/contextwire.exe, and
  2. that release build is newer than every source file that goes into it.
Exit 0 = pass; otherwise prints what is stale and exits 1.
"""

from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUILT = ROOT / "src-tauri" / "target" / "release" / "contextwire.exe"
INSTALLED = Path(os.environ.get("LOCALAPPDATA", "")) / "ContextWire" / "contextwire.exe"
SOURCES = [ROOT / "src", ROOT / "src-tauri" / "src", ROOT / "index.html",
           ROOT / "src-tauri" / "Cargo.toml", ROOT / "src-tauri" / "tauri.conf.json"]


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def newest_source() -> tuple[float, Path]:
    files = [f for s in SOURCES for f in ([s] if s.is_file() else s.rglob("*")) if f.is_file()]
    return max((f.stat().st_mtime, f) for f in files)


def main() -> int:
    if not INSTALLED.exists():
        print(f"not installed: {INSTALLED}")
        return 1
    if not BUILT.exists():
        print("no release build: run npm run tauri build")
        return 1
    problems = []
    if sha(INSTALLED) != sha(BUILT):
        problems.append("installed exe differs from the latest release build - reinstall the NSIS setup")
    t, f = newest_source()
    if t > BUILT.stat().st_mtime:
        problems.append(f"source changed after the last release build ({f.relative_to(ROOT)}) - rebuild")
    if problems:
        print("; ".join(problems))
        return 1
    print("installed = latest release build = latest source")
    return 0


if __name__ == "__main__":
    sys.exit(main())
