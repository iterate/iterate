---
status: done
size: small
base: tasks-app-package-bridge (#2304)
---

# Bundle sizes on worker builder events

## Status summary

Implemented, tested, and verified against a real local dev build. Coordinator
events now carry `sizes` (module/asset bytes + counts) and a human-readable
`source` descriptor. Verification already produced the intended kind of
insight: the main stateless `worker.ts` bundle is NOT tiny today (~604 KiB,
barely bigger than the guestbook app's ~572 KiB) — see notes.

## Ask (from Misha, lightly interpreted)

> can we add bundle sizes on builder events. all the bundles should have
> different size. main stateless worker should be tiny. github-review-bot for
> example should be different

"Builder events" = the dynamic worker build coordinator telemetry
(`worker-build.started/coalesced/settled/reused` from
`observeCoordinatorEvent` in
`apps/os/src/domains/workers/worker-build-coordinator-durable-object.ts`).
Today they carry only `buildKey` (an opaque sha), `durationMs`, `waiters`,
`outcome`. You can't tell from the logs which worker was built nor how big the
bundle came out — so you can't verify that the main stateless `worker.ts`
bundle is tiny while e.g. the github review bot / todo app bundles are bigger
and all different.

## Plan

- [x] `artifact-store.ts`: a pure `workerBuildArtifactSizes(artifact)` returning
      `{ moduleBytes, moduleCount, assetBytes, assetCount }` — _UTF-8 bytes over
      every module representation (string / `js` / `cjs` / `text` / `json`) and
      every asset; derived on demand so no artifact schema bump_
- [x] `worker-build-coordinator.ts`: events gain `source` (all kinds) and
      `sizes` (settled+built, reused) — _`describeWorkerBuildSource` renders
      `createWorker:worker.ts` / `createApp:server=…,client=…`; sizes computed
      once at settle and cached with the retained artifact for reuse events_
- [x] Coordinator + sizes unit tests — _extended
      `worker-build-coordinator.test.ts` (event payload pinned incl. multibyte
      UTF-8) and `artifact-store.test.ts`_
- [x] Eyeball a real build log line locally and paste a sample into the PR
      body — _done via `pnpm dev` + `pnpm getin` + curling the `test` project
      hosts; sample below and in PR #2308_

## Assumptions (made while Misha was AFK)

- Raw (uncompressed) bytes, not gzip. These bundles go into Worker Loader, not
  over the wire to browsers, so raw size is the operative metric and it's
  deterministic. Gzip is an easy follow-up if wanted.
- No per-module breakdown on the event — logs have size budgets and the
  headline numbers answer "are these bundles actually different". A
  biggest-modules breakdown is a possible follow-up.
- Coordinator events are the right home (not the KV/memo cache-hit paths in
  `worker-loader.ts`): "builder events" happen when something builds. Cache
  hits reuse an artifact whose size was already reported at build time.
- No UI surface for now — this is log/observability only.

## Implementation notes

Real events from local dev (this branch, seeded template = packaged starter
apps):

```
worker-build.settled  source=createWorker:worker.ts
  sizes={ assetBytes: 0, assetCount: 0, moduleBytes: 618735, moduleCount: 1 }  durationMs=4142
worker-build.settled  source=createWorker:node_modules/iterate/dist/starter-apps/guestbook/configured-worker.mjs
  sizes={ assetBytes: 0, assetCount: 0, moduleBytes: 585958, moduleCount: 1 }  durationMs=1169
```

Finding: the sizes differ (good — each entry gets its own bundle), but the
main stateless worker is ~604 KiB, not tiny. Plausible causes worth chasing in
a follow-up: the template `worker.ts` imports every starter-app connector
top-level, and the `iterate` sdk itself may not tree-shake well (single
`sdk.ts` barrel). Now that the sizes are on every build event, that
investigation has numbers to steer by.
