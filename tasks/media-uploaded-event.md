---
status: in-progress
size: large
branch: media-uploaded-event
---

# Media: durable `media/uploaded` event + server-side analysis

## Status summary

Not started yet (spec commit). The design is settled: the phone appends a
cheap durable `media/uploaded` event right after the bytes land, and analysis
moves server-side into the userland MediaApp processor (obligation pattern,
keepalive-recovered). Nothing implemented; checklist below.

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
  dedups at the phone's existing getEvent check — no duplicate rows.
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

- [ ] Starter app: `analysis.ts` — pipeline ported from buildProcessScript
      (bytes → toMarkdown → >1MB downscale → vision JSON parse), owns model +
      taxonomy + prompt; unit tests ported from the script tests.
- [ ] Starter app: contract v0.2.0 — consume uploaded + reanalyze-requested,
      emit processed (with error/requestOffset), state gains pendingAnalyses,
      MediaItem gains analysisError; reduce dedups uploaded-after-captured;
      wiped clears obligations.
- [ ] Starter app: MediaProcessor processEvent obligation branch + worker
      `recovery = true` + analyze dep wired off env.ITX.
- [ ] Starter app: harness tests — happy path, terminal failure keeps row,
      eviction mid-attempt revival, expiry without dialing AI, full-stream
      replay (throwing fake, zero calls, zero appends), reanalyze, dedup,
      wipe clears obligations.
- [ ] Mobile media.ts: uploaded/reanalyze event builders + types,
      buildProcessScript deleted, wipe script sweeps uploaded too,
      deriveMediaList births rows from uploaded + overlays processed
      (error-aware) + analysis status (pending/failed/done), dedup across
      captured+uploaded.
- [ ] Mobile media-sync.ts: pass = hash + put + append uploaded (no
      runScript); progress copy updated.
- [ ] Mobile media.tsx: capture mutation appends uploaded; rows show
      "Analyzing…" until processed lands, error state on terminal failure;
      Re-analyze appends reanalyze-requested. Minimal diff (sibling PR
      mobile-media-niggles touches the same screen).
- [ ] Mobile tests: media.test.ts reworked (script tests move to starter
      app), new derivation/back-compat/wipe coverage.
- [ ] e2e: media.e2e.test.ts + media-agent-retrieval.e2e.test.ts drive the
      new flow (put + append uploaded, wait for processed via
      stream.waitForEvent); media-app.e2e.test.ts (seeded captured) stays as
      the back-compat lane.
- [ ] Checks: typecheck, lint, knip, format, vitest.

## Implementation log

(running notes appended during implementation)
