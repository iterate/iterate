---
status: in-progress
size: large
tags: [mobile, media, native, processors, ai, playwright]
follows: complete/2026-08-10-media-followups.md (PR #2464)
---

# Media collection (round 4 — the big one)

**Status summary:** implemented; all local gates green, three live e2e
lanes green, opt-in Playwright spec verified end to end against the real
vision pipeline. Native pieces (media-library sync, viewer gestures) await
the post-merge EAS build + a real device. One open platform question logged
below (worker-updated delivery latency to fresh project workers).

## Checklist

### A. Background photo collection (native)

- [x] `expo-media-library` + app.json plugin (photo-library usage string) —
      the PR's one fingerprint bump; CI auto-builds the new preview binary
      on merge
- [x] permission flow: three-way iOS prompt surfaced as
      `accessPrivileges: all | limited | none`; degrade gracefully on
      limited (soft banner, never a blocking screen)
- [x] per-project "collect screenshots into this project" toggle,
      device-local state; sync runs on Media-screen open + manual "Sync now"
- [x] sync pass (pure logic in `lib/media-sync.ts`, unit-tested): enumerate
      screenshot assets newest-first since the local cursor, cap per pass,
      hash → skip via `getEvent({idempotencyKey})` (cursor is disposable
      cache; the stream is the source of truth), upload + process through
      the existing capture pipeline, 3-wide
- [x] library sync carries TRUE metadata the picker can't: `creationTime`
      (as `capturedAt`), `mediaSubtypes` screenshot flag, `source:
      "library-sync" | "picker"` on the payload
- [x] `BGAppRefreshTask` stays OUT (old spec's M3): it is prototype-gated
      on-device and no device is available here; foreground triggers only

### B. Full-screen viewer chrome

- [x] pinch-zoom + pan via `react-native-gesture-handler` (already a
      dependency; add `GestureHandlerRootView` at the app root) driven into
      core `Animated` — no reanimated
- [x] tap toggles chrome: tags + description overlay, collapsed with "See
      more" expanding to a scrollable half-screen panel
- [x] swipe-down dismisses (tap no longer closes)

### C. Userland MediaApp (zero apps/os changes)

- [x] `packages/iterate/src/starter-apps/media/`: processor contract + fold
      reducing `media/captured` + `media/processed` into per-item state
      (latest processing wins), node-harness tests
- [x] `MediaApp extends StreamProcessorDurableObject`, `streamPath =
      "/media"`, RPC verbs: `search({q, tags})`, `list()`, `get(stableKey)`
- [x] worker ref (guestbook-shaped project-worker fan-in, not wake-processor — media volume doesn't warrant it) appended from the project
      worker's `project/worker-updated` hook (github-ai-linter shape)
- [x] `provideCapability` mount at `media` (itx-expression recipe) so agents
      call `itx.media.search(...)` instead of the example-script dance;
      the catalogue example gets updated to prefer it
- [x] `configs/default/worker.ts` wiring (field + processEvent line)
- [x] live e2e: deploy the config worker to a dev project, capture a
      fixture, `itx.media.search` finds it

### D. Cloudflare AI Search (optional lane)

- [x] ~~tiny kernel passthrough: `itx.ai` gains the AI Search query
      surface~~ _added, then removed on Misha's call: a seam with no
      instance to serve it is dead kernel surface. FOLLOWUP: when an AI
      Search instance exists for a deployment (over the os-files R2 bucket,
      per-project folder filter), re-add the one-method passthrough
      (env.AI.autorag(id).search — note upstream deprecation in favor of a
      standalone binding) and wire MediaApp.search to prefer it_
- [~] MediaApp.search stays keyword-only for now — wiring untestable dead code against a nonexistent instance was worse than exposing the seam; scripts/agents can call itx.ai.aiSearch directly once an instance exists when configured, falls back to
      keyword-over-state; deployment setup documented (instance over the
      os-files R2 bucket, per-project folder filter) — creating instances
      per env is ops work left for later, the seam just has to be ready
- [x] honest e2e or skip-with-reason _seam is a passthrough; no dev instance exists to test against — documented, not faked_ depending on whether a dev instance
      can be created from the CLI

### E. Tests

- [x] unit: sync-pass logic, viewer state machine (pure parts), processor
      fold (node harness)
- [x] Playwright mobile specs, opt-in gated per repo convention
      (`test.skip(process.env.MOBILE_MEDIA_SPECS !== "1", ...)` — positive
      flag, never process.env.CI): media capture via web file input, search
      filtering, viewer open/chrome toggle. Misha unskips after #2460 lands
- [x] existing media e2e lanes stay green _plus the new media-app lane_

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

## Open platform question (found during e2e)

Delivery of `project/worker-updated` to a FRESH project's own worker did not
happen within 5 minutes in local dev — the root-stream `project-worker`
subscription (start: "now", onFailingEvent: skip) appears to back off long
when the receiver worker is still materializing, so the glue's itx.media
mount lags project creation. The mount contract itself is proven (the e2e
performs the same provide deterministically and the mounted dotted surface
answers). For existing projects the mount fires on their next worker update.
Worth a platform look: is the bootstrap backoff intended to be minutes, and
should a fresh deploy nudge redelivery?

## Additional log (round 4)

- provideCapability with a `types` string hits a compile gate; a failure
  there would get the worker-updated event skipped (onFailingEvent: skip),
  silently losing the mount. The glue mounts untyped + instructions instead.
- expo's regenerated typed routes rejected the loose InAppLink shape —
  now a concrete route-object union.
- the mobile e2e importing the starter-app dragged Cloudflare-typed modules
  into the mobile tsconfig — the worker ref lives in a dependency-free
  ref.ts module the e2e imports instead.
- CI caught what my mid-stage gate laziness missed (zod-schema-naming,
  spec-restricted-syntax, stale config-repo-template codegen) — full gates
  after every stage from now on.

## Review round (Misha, 2026-08-10)

- [x] no raw action timeouts in specs: adopted middlewright's
      require-timeout-comment oxlint rule from the PR-25 pkg.pr.new build
      (sha-pinned; local spinner-waiter patch still applies), scoped to the
      merged mobile specs; the two flagged waits now rely on the spinner
      waiter, and every remaining popup timeout carries a conforming
      one-line justification. FOLLOWUP: repo-wide enablement — 97 sites
      across specs/ (incl. #2460's files) need the same treatment.
- [x] AI spec is never CI-deterministic: split media.spec.ts — a
      deterministic lane (admin-seeded event, exact assertions, CI-able)
      and the live vision lane as a permanent opt-in (eval candidate)
- [x] negative assertions: the Media screen gained a "No results" empty
      state and the spec asserts it positively

## Round 2 (Misha, 2026-08-10 evening)

- [x] Auto-collect is fat-finger-proof: the row opens a confirm dialog
      (chevron affordance) with a "Collect back to" window — 1 day / 1 week
      default / 1 month / 3 months / 1 year — stored as an absolute date at
      confirm; the sync walk stops dead at the threshold. Spec asserts
      tap → explainer → Cancel → still Off.
- [x] PR videos re-recorded with middlewright VIDEO_MODE (video-rendered
      output: cursor overlays, captions, dead-air compression) from a
      fully-passing run.
