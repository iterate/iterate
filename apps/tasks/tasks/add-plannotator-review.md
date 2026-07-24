---
status: in-progress
size: large
---

# Add Iterate-backed Plannotator review

## Status

Porting the proven standalone integration into `apps/tasks`. The monorepo app already has Editor
and Preview tabs; Review will be a third surface. Durable annotation behavior, verified authorship,
and local multiplayer proof remain.

## Outcome

An open workspace task has a Review tab powered by the published Plannotator UI. Project members
can attach comments or deletion suggestions to task markdown, see each other's annotations live,
and recover them after refresh. Iterate's workspace stream is the storage and multiplayer backend;
the collaborative editor remains the markdown source of truth.

## Decisions

- Preserve the existing Editor and Preview tabs; add Review alongside them.
- Consume `@plannotator/ui` and `@plannotator/core`, with an explicit pnpm patch if the published
  package still needs its TypeScript 5.9 and `highlight.js` compatibility fixes.
- Store annotation mutations as namespaced durable events on the existing workspace stream.
- Scope annotations to the workspace-relative task path and stamp authors from the verified
  project session.
- Keep selected tab and annotation in route search state instead of adding React component state.
- Keep images and AI disabled.

## Checklist

- [ ] Specify and implement the durable annotation journal through a public behavior test.
- [ ] Expose annotation snapshot/add/update/remove on `TasksWorkspace`.
- [ ] Add the published Plannotator packages and browser-only Review surface.
- [ ] Preserve Editor/Preview behavior and add URL-backed Review selection.
- [ ] Prove verified authorship cannot be spoofed by the browser.
- [ ] Verify tests, typecheck, production build, and two-browser live behavior.

## Implementation log

- 2026-07-24: Started from the monorepo's current `apps/tasks`, preserving its newer presence,
  draft-settling, shared UI, and Preview work beyond the former standalone repository.
