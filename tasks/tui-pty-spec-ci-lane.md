---
state: todo
priority: high
size: small
dependsOn: []
tags: [ci, tui, e2e, depot]
---

# Put the TUI PTY spec into a CI lane

`apps/os/e2e/tui-test/` (Microsoft TUI Test driving the real `iterate chat`
binary through a PTY) runs in NO CI lane today. Two consequences observed on
2026-07-17 during PR #2063:

1. The spec sat broken on main for 10 days (the 2026-07-07 wake-marker feed
   items made its "No messages yet" assertion unreachable) and nobody noticed.
2. When run by hand it was the ONLY gate that caught a real dist-artifact bug
   (react bundled into the TUI beside external @opentui/react → two reacts →
   invalid-hook-call in exactly the artifact users run — invisible to unit
   tests, typecheck, and the source-mode data-layer smoke).

## What to do

- Wire `e2e/tui-test/run.ts` (and/or `data-layer-smoke.ts`) into the preview
  e2e workflow (`.depot/workflows/cloudflare-previews.yml`) after the deploy —
  it already creates and releases a disposable project and needs only the
  admin-secret env the lane has.
- It must run against the BUILT package (`pnpm --dir packages/iterate build`
  first, or assert the launcher's dist fallback), because dist-only failures
  are precisely what it catches.
- Budget: the spec is ~10s once the deployment is warm; the smoke ~30s.
