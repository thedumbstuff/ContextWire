## What and why

<!-- One feature or fix. Link the issue or roadmap task (e.g. P6.3). -->

## How I verified it

<!-- Tests added/run; for UI changes, a screenshot without personal paths. -->

## Checklist

- [ ] `npx tsc --noEmit`, `npm test`, `cargo test --manifest-path src-tauri/Cargo.toml` and the watchtower tests pass
- [ ] `roadmap.yaml` (task status / checks / features) and `docs/changelog.md` updated
- [ ] The hook client still never blocks Claude, and nothing new logs prompts or conversation text
