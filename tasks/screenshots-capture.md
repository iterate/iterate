---
status: in-progress
size: medium
tags: [mobile, files, streams, ai]
supersedes: screenshots-collector (closed PR #2405 — simplified)
---

# Screenshots capture

**Status summary:** prototype in progress. Simplified cut of the
screenshots-collector spec (#2405): no rules engine, no OCR layers, no
media-library sync, no server-side processor. Capture screenshots from the
phone, describe them with `itx.ai.toMarkdown`, auto-tag with a cheap LLM,
persist on a stream, search from the phone. Ships OTA today (JS-only).

## What it is

The mobile app gets a **Screenshots** screen (drawer item). You pick
screenshots from the photo library (PHPicker — no new permission, no native
module). For each:

1. bytes → `itx.files` at `/screenshots/inbound/<sha256>-<filename>`
2. one `capabilityHost.runScript` call runs server-side:
   `files.bytes → ai.toMarkdown` (Cloudflare's vision model writes a
   natural-language description) → `ai.run` cheap text model multi-tags the
   description → appends `events.iterate.com/screenshots/captured` to the
   `/screenshots` stream, idempotency-keyed by content hash
3. the screen lists captures newest-first from
   `streams.get('/screenshots').getEvents(...)` with client-side search over
   description + tags

"Semantic search" for the prototype = keyword search over the vision model's
descriptions ("train ticket" matches because the description says train
ticket). True embedding search is a follow-up — the repo has no Vectorize
binding today.

## Where metadata lives (the persistence question)

**Stream + files**, mirroring email ingress:

- bytes: `itx.files` (R2), content-hash keyed — retries overwrite, never dup
- metadata + markdown + tags: event payloads on the `/screenshots` stream —
  the platform's canonical home for facts-with-history
- NOT a repo/workspace (screenshots aren't review/diff material, volume too
  high), NOT kv (policy knobs only, 64KiB caps)
- follow-up home for real querying: a screenshots stream processor with
  reduced state (the email pattern); the event vocabulary is designed so that
  processor can be added later without re-ingesting

## Tags

Multi-tag, overlap allowed (deliberately not first-match-wins). Starter
taxonomy, LLM may also add up to 2 novel kebab-case tags:

`transient` (OTP codes, one-off confirmations) · `media` (posts/articles/
memes worth keeping) · `logistics` (tickets, bookings, travel) · `receipt` ·
`bug-report` (software misbehaving) · `iterate` (about iterate itself) ·
`code` (code/terminal/dev tools) · `conversation` (chat/email screenshots) ·
`reference` (info to keep long-term)

Taxonomy is data in `apps/mobile/src/lib/screenshots.ts` — expect churn.

## Checklist

- [ ] `src/lib/screenshots.ts`: event type + payload, tag taxonomy, file
      path/idempotency-key derivation, pipeline script builder
      (JSON-embedded input, injection-safe), client-side search filter
- [ ] unit tests for script builder + search filter (root CI runs these)
- [ ] `pickImages` gains a required `selectionLimit` param (chat passes 6,
      screenshots 20)
- [ ] Screenshots screen: capture → per-item progress → list with signed-url
      thumbnails, tag chips, search box; drawer item + route union
- [ ] dedup: skip upload when `getEvent({ idempotencyKey })` already exists
- [ ] live e2e (`apps/mobile/e2e/screenshots.e2e.test.ts`): tiny PNG fixture
      through the whole pipeline — also the repo's first proof that
      image→toMarkdown works (cf-ai-to-markdown example is `e2eProven: false`)

## Explicitly cut from #2405 (still good ideas, later)

- media-library auto-sync of the Screenshots album (`expo-media-library` =
  native module = fingerprint bump = new EAS build; the picker ships today)
- rules engine, OCR layer, obligation-pattern LLM step
- server-side processor + `alreadySynced` reconciliation
- backfill job, `BGAppRefreshTask`

## Guesses and assumptions

- [guess] "capture" = pick-from-library, since that ships OTA today; the
  share-sheet extension and auto-sync are the obvious next asks
- [guess] tag taxonomy above — derived from Misha's examples; the LLM's
  novel-tag allowance is the pressure valve
- [guess] tagging model `@cf/meta/llama-3.2-3b-instruct` over the description
  text (not the pixels) — cheap, good enough for a prototype
- [guess] search stays client-side over one `getEvents` page until volume
  hurts, then the processor + reduced state follow-up

## Implementation log

- (starting) design derived from two exploration passes; all seams verified
  against main @ 207823a45: `runScript` arbitrary code, `append` idempotency
  replay, `getEvent({idempotencyKey})`, `files.put` base64 `FileData`,
  toMarkdown image support via Cloudflare converter.
