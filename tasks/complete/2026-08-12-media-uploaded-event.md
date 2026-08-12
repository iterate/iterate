---
status: in-review
size: large
branch: media-uploaded-event
pr: https://github.com/iterate/iterate/pull/2481 (originally #2482, closed as superseded)
---

# Media: durable `media/uploaded` event + server-side analysis

## Status summary

Implemented, all checks green (typecheck, lint, knip, format, vitest across
os/iterate/mobile). Merged into branch mobile-media-niggles so PR #2481
carries this AND the screen niggles/toolbar rework (see
tasks/mobile-media-niggles.md); PR #2482 closed as superseded. Main pieces: phone appends a cheap durable
`media/uploaded` event after `files.put`; analysis moved into the userland
MediaApp processor as an obligation (recovery-enabled); mobile list shows
Analyzing…/failed states; e2e rewritten for the new flow. Not yet run: the
live e2e lane (needs a dev server) — CI's preview e2e covers it.

## Problem

The mobile Media capture flow (PR #2466) couples the durable record to
analysis success AND to the phone keeping its capnweb socket open ~5–15s per
item: after `files.put`, an awaited `capabilityHost.runScript` does
toMarkdown + vision and only THEN appends the durable `media/captured` event.
Observed in prod dogfooding:

- locking the phone mid-pass kills every in-flight item ("Peer closed
  WebSocket: 1001");
- a transient Workers AI failure ("8005: Internal server error") costs the
  whole item;
- failed items re-upload and re-analyze from scratch next pass; two items
  never came back because no pass completed while foregrounded.

## Design

Split durability from analysis, event-driven and server-side.

### New flow

```
before (phone drives everything, holds socket open):
  hash → files.put → runScript(toMarkdown + vision + append captured)   ~5-15s/item

after (phone does the cheap durable part only):
  phone:  hash → files.put → stream.append(media/uploaded)              ~fast
  server: MediaApp processor reacts to media/uploaded (obligation) →
          toMarkdown + vision → append media/processed (error field on
          terminal failure)
```

### Event vocabulary (all on `/media`)

- `media/uploaded` (NEW, phone-appended): metadata only — stableKey, path,
  filename, contentType, width, height, source, capturedAt, isScreenshot.
  Idempotency key = existing `mediaIdempotencyKey` scheme
  (`media-captured-<hash>[-g<gen>]`), so wipe-generation semantics are
  preserved AND a stableKey already recorded as legacy `media/captured`
  dedups at the phone's existing getEvent check (and, failing that, at the
  stream's same-key rejection) — no duplicate rows.
- `media/reanalyze-requested` (NEW, phone-appended): `{ stableKey }`, key
  `media-reanalyze-<stableKey>-<nonce>`. Replaces the phone-driven reprocess
  script; Re-analyze is now durable too.
- `media/processed` (EXISTING, now the analysis settlement): gains
  `error: string | null` (result union in the payload — one terminal event
  per obligation, per docs/writing-stream-processors.md) and
  `requestOffset: number | null` (the uploaded/reanalyze event it settles).
  Success overlays processing fields; failure sets `error` and leaves prior
  fields alone. Failures never lose the item — the row exists from uploaded.
- `media/captured` (LEGACY): still folded and rendered everywhere; no longer
  appended by anything. Old items keep working.
- `media/wiped`: unchanged, but the wipe script's file sweep now reads
  uploaded events too.

### Seam: the userland MediaApp processor (starter app), not an OS domain

Considered three homes for the server-side reaction:

1. **OS-side domain processor** (like email): needs per-project subscription
   wiring at creation for a product-level feature — invasive, and puts a
   userland concern in the platform.
2. **Capability-host script re-request**: reuses script obligations but adds
   a second processor just to request scripts, and retries/settlement
   semantics don't fit.
3. **The MediaApp DO itself** (chosen): it already owns the /media vocabulary
   and fold, already receives committed /media events (project-worker fan-in
   → `syncEvent` → catchUp), is DO-hosted so alarms + keepalive work
   (`recovery = true`), and has full project itx (`env.ITX`) for
   ai.toMarkdown / ai.run / files / images. `GithubAiLinterProcessor` is the
   exact precedent: a userland starter-app obligation processor doing AI
   calls with `recovery = true` and injected deps.

The MediaProcessor stops being a pure fold: `reduce` additionally tracks open
analysis obligations (`pendingAnalyses`), and `processEvent` (under
`delivery.caughtUp`) starts undriven attempts / settles expired ones,
following the obligation pattern. Contract/implementation stay in
processor.ts (existing starter-app shape); the analysis pipeline itself moves
to a new `analysis.ts` (ported from `buildProcessScript`'s script body), with
the vision model, taxonomy, and prompt — the server now owns the analysis
vocabulary (mobile keeps a display-only tag list with a sync note, same
hand-sync convention as search semantics).

### Obligation semantics (guesses flagged)

- Attempt = up to 3 tries with short backoff (in-attempt retries cover the
  transient Workers AI 8005 class); final failure settles terminally with
  `error`. _Guess: 3 tries / 2s+8s backoff._
- Obligation expiry: 24h from the requesting event's `createdAt` — a wake
  later than that settles as expired failure without dialing AI (staleness
  doctrine). Rows stay; Re-analyze works. _Guess: 24h._
- Settlement idempotency key: `analysis-settled@<stableKey>:<requestOffset>`
  (state-derived, deterministic per obligation); same-key/different-body
  races tolerate-as-settlement (`isIdempotencyConflict`), the ai-linter
  shape.
- No `…-started` event: analysis is safe to re-run (idempotent appends),
  like Agent adoption.
- Eviction recovery: keepalive alarm → revival → caughtUp pass restarts
  still-open obligations from reduced state.

## Checklist

- [x] Starter app: `analysis.ts` — pipeline ported from buildProcessScript
      (bytes → toMarkdown → >1MB downscale → vision JSON parse), owns model +
      taxonomy + prompt; unit tests ported from the script tests. _In
      packages/iterate/src/starter-apps/media/analysis.ts + analysis.test.ts;
      the script-injection tests died with the script._
- [x] Starter app: contract v0.2.0 — consume uploaded + reanalyze-requested,
      emit processed (with error/requestOffset), state gains pendingAnalyses,
      MediaItem gains analysisError; reduce dedups uploaded-after-captured;
      wiped clears obligations. _processor.ts._
- [x] Starter app: MediaProcessor processEvent obligation branch + worker
      `recovery = true` + analyze dep wired off env.ITX. _worker.ts
      createProcessor injects analyze/now/sleep; #startOrSettle logic lives
      in processEvent's caughtUp branch._
- [x] Starter app: harness tests — happy path, terminal failure keeps row,
      eviction mid-attempt revival, expiry without dialing AI, full-stream
      replay (throwing fake, zero calls, zero appends), reanalyze, dedup,
      wipe clears obligations. _media-analysis.test.ts via
      makeProcessorHarness; also in-attempt retry on virtual time._
- [x] Mobile media.ts: uploaded/reanalyze event builders + types,
      buildProcessScript deleted, wipe script sweeps uploaded too,
      deriveMediaList births rows from uploaded + overlays processed
      (error-aware) + analysis status (pending/failed/done), dedup across
      captured+uploaded. _MediaListItem.analysis drives the UI badge._
- [x] Mobile media-sync.ts: pass = hash + put + append uploaded (no
      runScript); progress copy updated. _"Uploading n of m new…"; failed
      now counts upload failures only._
- [x] Mobile media.tsx: capture mutation appends uploaded; rows show
      "Analyzing…" until processed lands, error state on terminal failure;
      Re-analyze appends reanalyze-requested. Minimal diff (sibling PR
      mobile-media-niggles touches the same screen). _Pending cards say
      "Uploading…"; MediaRow renders the analysis badge/error._
- [x] Mobile tests: media.test.ts reworked (script tests move to starter
      app), new derivation/back-compat/wipe coverage. _Pending/failed/
      reanalyze status derivation, captured+uploaded dedup, both-birth-types
      wipe sweep._
- [x] e2e: media.e2e.test.ts + media-agent-retrieval.e2e.test.ts drive the
      new flow (put + append uploaded, wait for processed via
      stream.waitForEvent); media-app.e2e.test.ts (seeded captured) stays as
      the back-compat lane. _120s waits per settlement (same real-time AI
      cost the awaited-runScript path had; e2e testTimeout is 180s)._
- [x] Checks: typecheck, lint, knip, format, vitest. _All green; knip
      required unexporting analysis-internal consts._

## Implementation log

- Chose per-stableKey obligation keying (`pendingAnalyses` keyed by
  stableKey, storing requestOffset) so a reanalyze while an initial analysis
  is pending collapses to one obligation — latest request wins; the
  settlement clears the key's entry either way.
- The harness's MemoryStream rejects same-key/different-body appends exactly
  like production — the "uploaded after captured" dedup test had to use a
  distinct key, which documented the real primary dedup (the stream door).
- deriveMediaList's analysis state: latest request offset (uploaded birth or
  reanalyze) vs latest settlement offset; request newer → pending; settled
  with error → failed; else done. Legacy captured rows are born "done".
- specs/mobile/media.spec.ts untouched: the deterministic lane seeds legacy
  captured events (now the explicit back-compat surface) and the opt-in AI
  lane's "Analyzing…" wait still matches the new row badge.
- Post-wipe "Analyzing… forever" investigation (preview_8/nustom): live
  probes proved the fold generation-correct — one driven catchUp advanced
  the stuck checkpoint 252→498, folded the wipe, opened all 19 obligations,
  and analyses settled immediately. Root cause of the stall was the
  /media→project-worker fan-in not driving the processor after a preview
  redeploy (platform issue, flagged separately), NOT obligation dedup.
  Verification did surface one real settle-path gap, now fixed: a LATE
  settlement answering a superseded requestOffset (pre-wipe attempt racing
  Delete-all + re-upload) no longer clears/poisons the fresh obligation
  (fold guard + matching phone-derivation guard), with harness pins for
  wipe → re-upload re-analysis, post-wipe arrivals, and replay-with-wipe.
