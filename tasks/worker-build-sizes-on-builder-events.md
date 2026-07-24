---
status: in-progress
size: small
base: tasks-app-package-bridge (#2304)
---

# Bundle sizes on worker builder events

## Status summary

Spec written, implementation not started. Stacked on #2304 because the payoff
story depends on the packaged-config world (iterate/config#20): once the config
repo is thin and every app builds from its own npm-package entry point, per-build
sizes in the logs are the sanity check that each worker gets its own tree-shaken
bundle.

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

- [ ] `artifact-store.ts`: a pure `workerBuildArtifactSizes(artifact)` returning
      `{ moduleBytes, moduleCount, assetBytes, assetCount }` (UTF-8 bytes over
      every module representation — string / `js` / `cjs` / `text` / `json` —
      and every asset). No artifact schema change, no KV shape change: sizes
      are derivable from the artifact, so compute-on-observe instead of
      store-and-version.
- [ ] `worker-build-coordinator.ts`: events gain
      - `source` (all kinds): compact human descriptor of what's building,
        derived from the request — `createWorker:worker.ts`,
        `createWorker:node_modules/iterate/dist/starter-apps/todo/configured-worker.mjs`,
        `createApp server=… client=…` — so a log line is interpretable without
        resolving the buildKey.
      - `sizes` (settled+built and reused): computed once when the flight
        settles, cached alongside the retained artifact so reused events don't
        re-encode megabytes of module text.
- [ ] Coordinator + sizes unit tests (extend
      `worker-build-coordinator.test.ts`, `artifact-store.test.ts`).
- [ ] Eyeball a real build log line locally (`pnpm dev`, hit a project app) and
      paste a sample into the PR body.

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

(running log)
