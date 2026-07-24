---
status: complete
size: medium
pull_request: https://github.com/iterate/iterate/pull/2303
---

# Package the Guestbook app

## Status

Done. Guestbook is packaged behind one combined fetch/event factory, config retains only migration bridges, source and state migrations pass, and the live browser, ingress, preview, and telemetry proofs are clean.

Move the Guestbook implementation from generated config repos into `iterate/starter-apps/guestbook`. This is the combined app case: one factory instance must expose both HTTP `fetch` and committed project-stream `processEvent`.

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
- [x] Export the packaged Guestbook runtime and physical configured-worker artifact. _`iterate/starter-apps/guestbook` owns the factory; `dist/starter-apps/guestbook/configured-worker.mjs` owns the stateful runtime._
- [x] Embed a browser-ready Guestbook client with a guard against bare browser imports. _The client build emits one self-contained asset and `check-guestbook-client-bundle.ts` rejects imports._
- [x] Preserve durable identity, stream history, processor state, and subscription migration. _The deployed createApp→createWorker test kept `app-guestbook-stream`, its folded entry, and retired `app-guestbook#guestbook`._
- [x] Compose both Guestbook methods in the generated config-repo worker. _One `GuestbookApp.create(this.env)` instance receives routed HTTP and committed events._
- [x] Remove Guestbook implementation source from generated config repos. _Only two temporary one-line source-upgrade bridges remain at paths persisted by old WAKE refs._
- [x] Prove browser signing and reload still work. _The real preview browser signed and reloaded an entry in 24.0s._
- [x] Prove an externally appended Guestbook event reaches state through `processEvent`. _The live ingress test appended directly to `/guestbook` and observed packaged state._
- [x] Prove existing Guestbook state survives the source move. _The exact deployed source-swap test passed in 16.2s._
- [x] Update the paired `iterate/config` pull request. _iterate/config#19 imports the package factory on both lanes and deletes the processor/ref._
- [x] Run package, type, lint, format, browser, preview, and trace checks. _All local checks and the 4m38 preview rollup pass; the exact telemetry window has zero errors._

## Implementation log

- Assumption: keeping the current durable key and processor storage shape is the compatibility boundary; source ownership may move without changing application identity.
- Assumption: duplicate wakeups during subscription migration are acceptable only if they are bounded and idempotent. They must not create duplicate entries or unexplained error telemetry.
- Red/green: the public contract test first failed because `./index.ts` did not exist, then passed after the factory dispatched HTTP to the physical ref and forwarded only `/guestbook` events.
- The packaged app appends an idempotent `subscription-removed` fact for `app-guestbook#guestbook`; project-worker `processEvent` is now the sole durable delivery spine.
- `project-ingress.e2e.test.ts` now appends an entry directly to the stream and waits for packaged state, while `guestbook-package-migration.e2e.test.ts` crosses from the former `createApp` ref to the physical worker with the same durable key.
- Local package build, package tests (170), full typecheck, lint, template typecheck, and template unit tests pass.
- Deployed preview proof: ingress/WebSocket suite 3/3 (45.1s), source migration 1/1 (16.2s), and browser sign/reload 1/1 (24.0s).
- Cloudflare audit for `os-preview-11`, 2026-07-24T13:43:00Z–13:46:00Z: 92 Guestbook-matching events, 82 info + 10 unset request rows, nine explicit `ok` outcomes, zero error-level events, script version `af7df206-50ce-490b-8675-aab60015c222`. Example trace: `a9989722bad8c475cfe044caa96c589e`.
