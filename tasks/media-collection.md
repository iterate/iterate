---
status: in-progress
size: large
tags: [mobile, media, native, processors, ai, playwright]
follows: complete/2026-08-10-media-followups.md (PR #2464)
---

# Media collection (round 4 — the big one)

**Status summary:** just started. Everything deferred from the media capture
arc in one PR: background photo collection (the one native addition),
full-screen viewer chrome, a userland MediaApp processor with an `itx.media`
mount, an optional Cloudflare AI Search lane, and opt-in Playwright specs.

## Checklist

### A. Background photo collection (native)

- [ ] `expo-media-library` + app.json plugin (photo-library usage string) —
      the PR's one fingerprint bump; CI auto-builds the new preview binary
      on merge
- [ ] permission flow: three-way iOS prompt surfaced as
      `accessPrivileges: all | limited | none`; degrade gracefully on
      limited (soft banner, never a blocking screen)
- [ ] per-project "collect screenshots into this project" toggle,
      device-local state; sync runs on Media-screen open + manual "Sync now"
- [ ] sync pass (pure logic in `lib/media-sync.ts`, unit-tested): enumerate
      screenshot assets newest-first since the local cursor, cap per pass,
      hash → skip via `getEvent({idempotencyKey})` (cursor is disposable
      cache; the stream is the source of truth), upload + process through
      the existing capture pipeline, 3-wide
- [ ] library sync carries TRUE metadata the picker can't: `creationTime`
      (as `capturedAt`), `mediaSubtypes` screenshot flag, `source:
      "library-sync" | "picker"` on the payload
- [ ] `BGAppRefreshTask` stays OUT (old spec's M3): it is prototype-gated
      on-device and no device is available here; foreground triggers only

### B. Full-screen viewer chrome

- [ ] pinch-zoom + pan via `react-native-gesture-handler` (already a
      dependency; add `GestureHandlerRootView` at the app root) driven into
      core `Animated` — no reanimated
- [ ] tap toggles chrome: tags + description overlay, collapsed with "See
      more" expanding to a scrollable half-screen panel
- [ ] swipe-down dismisses (tap no longer closes)

### C. Userland MediaApp (zero apps/os changes)

- [ ] `packages/iterate/src/starter-apps/media/`: processor contract + fold
      reducing `media/captured` + `media/processed` into per-item state
      (latest processing wins), node-harness tests
- [ ] `MediaApp extends StreamProcessorDurableObject`, `streamPath =
      "/media"`, RPC verbs: `search({q, tags})`, `list()`, `get(stableKey)`
- [ ] worker ref + `wake-processor` subscription appended from the project
      worker's `project/worker-updated` hook (github-ai-linter shape)
- [ ] `provideCapability` mount at `media` (itx-expression recipe) so agents
      call `itx.media.search(...)` instead of the example-script dance;
      the catalogue example gets updated to prefer it
- [ ] `configs/default/worker.ts` wiring (field + processEvent line)
- [ ] live e2e: deploy the config worker to a dev project, capture a
      fixture, `itx.media.search` finds it

### D. Cloudflare AI Search (optional lane)

- [ ] tiny kernel passthrough: `itx.ai` gains the AI Search query surface
      (same precedent as run/toMarkdown — the binding already reaches it;
      no wrangler change), returning a clear "not configured" error when
      the deployment has no instance
- [ ] MediaApp.search tries AI Search first when configured, falls back to
      keyword-over-state; deployment setup documented (instance over the
      os-files R2 bucket, per-project folder filter) — creating instances
      per env is ops work left for later, the seam just has to be ready
- [ ] honest e2e or skip-with-reason depending on whether a dev instance
      can be created from the CLI

### E. Tests

- [ ] unit: sync-pass logic, viewer state machine (pure parts), processor
      fold (node harness)
- [ ] Playwright mobile specs, opt-in gated per repo convention
      (`test.skip(process.env.MOBILE_MEDIA_SPECS !== "1", ...)` — positive
      flag, never process.env.CI): media capture via web file input, search
      filtering, viewer open/chrome toggle. Misha unskips after #2460 lands
- [ ] existing media e2e lanes stay green

## Explicitly out (kept deferred)

- identify source app/website per item
- migration of pre-rename `/screenshots` dogfood data
- share-sheet extension; `BGAppRefreshTask`; silent-push sync
- embedding search beyond the AI Search lane above

## Guesses and assumptions

- [guess] screenshots-only for auto-collection (not the whole camera roll):
  matches the original ask; the picker still handles arbitrary photos
- [guess] sync cap 50/pass to start; no backfill job UI — opening the
  screen repeatedly walks history in capped bites via the cursor
- [guess] gesture-handler-without-reanimated is acceptable chrome quality
  for a first pass; reanimated can join a later native bump if it feels
  janky on device
- [guess] `itx.media` mount name (free today, cannot shadow built-ins)
- [guess] AI Search ships as a ready seam + fallback, not a hard dependency
  — per-env instance provisioning is ops follow-up

## Implementation log

- (starting) research pass established: AI Search was REMOVED from the
  stack in July 2026 (not currently in use); userland processor recipe =
  github-ai-linter starter-app shape; local-only Playwright gating =
  positive env flag; gesture-handler already a dependency with zero imports.
