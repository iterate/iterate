---
status: in-progress
size: medium
pull_request: https://github.com/iterate/iterate/pull/2303
---

# Package the Guestbook app

## Status

About 70% done. The package, combined factory contract, physical worker, browser artifact, generated template, migration bridge, and deployed specs are implemented. The paired config update and live preview/trace proof remain.

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

- [x] Add a failing public contract test for one factory exposing both `fetch` and `processEvent`. _Red import failure, then green dispatch + event-delivery contract in `guestbook.test.ts`._
- [x] Export the packaged Guestbook runtime and physical configured-worker artifact. _`iterate/guestbook` owns the factory; `dist/guestbook/configured-worker.mjs` owns the stateful runtime._
- [x] Embed a browser-ready Guestbook client with a guard against bare browser imports. _The client build emits one self-contained asset and `check-guestbook-client-bundle.ts` rejects imports._
- [ ] Preserve durable identity, stream history, processor state, and subscription migration.
- [x] Compose both Guestbook methods in the generated config-repo worker. _One `GuestbookApp.create(this.env)` instance receives routed HTTP and committed events._
- [x] Remove Guestbook implementation source from generated config repos. _Only two temporary one-line source-upgrade bridges remain at paths persisted by old WAKE refs._
- [ ] Prove browser signing and reload still work.
- [ ] Prove an externally appended Guestbook event reaches state through `processEvent`.
- [ ] Prove existing Guestbook state survives the source move.
- [ ] Update the paired `iterate/config` pull request.
- [ ] Run package, type, lint, format, browser, preview, and trace checks.

## Implementation log

- Assumption: keeping the current durable key and processor storage shape is the compatibility boundary; source ownership may move without changing application identity.
- Assumption: duplicate wakeups during subscription migration are acceptable only if they are bounded and idempotent. They must not create duplicate entries or unexplained error telemetry.
- Red/green: the public contract test first failed because `./index.ts` did not exist, then passed after the factory dispatched HTTP to the physical ref and forwarded only `/guestbook` events.
- The packaged app appends an idempotent `subscription-removed` fact for `app-guestbook#guestbook`; project-worker `processEvent` is now the sole durable delivery spine.
- `project-ingress.e2e.test.ts` now appends an entry directly to the stream and waits for packaged state, while `guestbook-package-migration.e2e.test.ts` crosses from the former `createApp` ref to the physical worker with the same durable key.
- Local package build, package tests (170), full typecheck, lint, template typecheck, and template unit tests pass.
