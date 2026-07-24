---
status: in-progress
size: medium
pull_request: https://github.com/iterate/iterate/pull/2303
---

# Package the Guestbook app

## Status

Starting. The target contract is chosen; implementation, migration proof, and deployed verification remain.

Move the Guestbook implementation from generated config repos into `iterate/guestbook`. This is the combined app case: one factory instance must expose both HTTP `fetch` and committed project-stream `processEvent`.

## Decisions

- Export `GuestbookApp.create(env)` with `{ fetch, processEvent }`.
- Keep the physical Durable Object stateful, under the existing `app-guestbook-stream` durable key.
- Keep `/guestbook` as the canonical event stream and preserve the existing processor state contract.
- `fetch` dispatches through the project's ITX worker bridge.
- `processEvent` filters Guestbook events and wakes the packaged stateful worker so externally appended events reach its derived state and live clients.
- Preserve or supersede the existing WAKE subscription safely so upgraded projects do not retain a config-source worker reference.
- The package must own the server, processor, browser client, and configured-worker artifact. Generated config repos only compose the factory.
- The independently deployed Tasks proxy is follow-up work, not part of this change.

## Checklist

- [ ] Add a failing public contract test for one factory exposing both `fetch` and `processEvent`.
- [ ] Export the packaged Guestbook runtime and physical configured-worker artifact.
- [ ] Embed a browser-ready Guestbook client with a guard against bare browser imports.
- [ ] Preserve durable identity, stream history, processor state, and subscription migration.
- [ ] Compose both Guestbook methods in the generated config-repo worker.
- [ ] Remove Guestbook implementation source from generated config repos.
- [ ] Prove browser signing and reload still work.
- [ ] Prove an externally appended Guestbook event reaches state through `processEvent`.
- [ ] Prove existing Guestbook state survives the source move.
- [ ] Update the paired `iterate/config` pull request.
- [ ] Run package, type, lint, format, browser, preview, and trace checks.

## Implementation log

- Assumption: keeping the current durable key and processor storage shape is the compatibility boundary; source ownership may move without changing application identity.
- Assumption: duplicate wakeups during subscription migration are acceptable only if they are bounded and idempotent. They must not create duplicate entries or unexplained error telemetry.
