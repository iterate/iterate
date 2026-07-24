---
status: complete
size: large
---

# Add Iterate-backed Plannotator review

## Status

Complete. Tasks now has a lazy-loaded Plannotator Review tab, durable Iterate-backed annotations,
verified authorship, live multiplayer updates, and a stable browser RPC connection. Tests, lint,
typecheck, production build, and a two-browser local proof all pass.

## Outcome

An open workspace task has a Review tab powered by the published Plannotator UI. Project members
can attach comments or deletion suggestions to task markdown, see each other's annotations live,
and recover them after refresh. Iterate's workspace stream is the storage and multiplayer backend;
the collaborative editor remains the markdown source of truth.

## Decisions

- Preserve the existing Editor and Preview tabs; add Review alongside them.
- Consume `@plannotator/ui` and `@plannotator/core`, with a pnpm patch for the published UI's
  TypeScript 5.9 and `highlight.js` interop issues.
- Store annotation mutations as namespaced durable events on the existing workspace stream.
- Scope annotations to the workspace-relative task path and stamp authors from the verified
  project session.
- Keep selected tab and annotation in route search state instead of adding React component state.
- Keep images and AI disabled.

## Checklist

- [x] Specify and implement the durable annotation journal through a public behavior test.
  *The journal folds add/update/remove events, validates durable shapes, and pages beyond the
  stream's 500-event read limit.*
- [x] Expose annotation snapshot/add/update/remove on `TasksWorkspace`.
  *`rpc-api.ts` forwards the new capability through the workspace's namespaced event stream.*
- [x] Add the published Plannotator packages and browser-only Review surface.
  *`workspace-task-review.tsx` lazy-loads UI 0.28.0 and core 0.22.0; AI and images stay disabled.*
- [x] Preserve Editor/Preview behavior and add URL-backed Review selection.
  *`workspace-task-sheet.tsx` keeps both existing tabs and derives Review/annotation selection from
  route search state.*
- [x] Prove verified authorship cannot be spoofed by the browser.
  *The journal test submits Mallory and observes the authenticated Iterate identity Ada.*
- [x] Verify tests, typecheck, production build, and two-browser live behavior.
  *Thirty-five tests pass; scoped lint, typecheck, and build pass. Two headed browsers observed
  global, selected-text, and deletion annotations live and after refresh, then removed the proof
  annotations.*

## Implementation log

- 2026-07-24: Ported from the former standalone Tasks integration onto the monorepo's current
  `apps/tasks`, preserving its newer presence, draft-settling, shared UI, and Preview work.
- 2026-07-24: Added filtered, paginated annotation history reads and visible failures for malformed
  durable annotation events.
- 2026-07-24: Ported the native WebSocket OPEN barrier and stopped application errors from tearing
  down the shared Cap'n Web session; the prior disconnect/reconnect symptom was not stale auth.
- 2026-07-24: The Review chunk is lazy but large (about 3.02 MB minified / 1.04 MB gzip) because
  upstream Plannotator bundles its rich Markdown, syntax, Mermaid, and KaTeX viewers.
