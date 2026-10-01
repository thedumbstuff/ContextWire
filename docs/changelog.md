# Changelog

## 2026-10-01

- Project started. Researched the official Claude desktop app; it cannot link to
  running terminal consoles, so ContextWire is built (decisions D1-D4 in roadmap.yaml).
- Installed Rust (rustup stable, cargo 1.98.1); scaffolded Tauri 2 + vanilla-ts.
- Watchtower adapted from statarb: Build tab + new Features tab (feature backlog
  incl. 23 features captured from code.claude.com/docs/en/desktop). Lints
  unknown feature keys (unquoted commas in YAML flow maps) and flags features
  declared shipped whose task is not verified.
