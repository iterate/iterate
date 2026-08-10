---
status: in-progress
size: medium
tags: [mobile, files, streams, ai]
supersedes: screenshots-collector (closed PR #2405 — simplified)
---

# Screenshots capture

**Status summary:** prototype implemented, live e2e green against local dev
(vision description + tags + idempotent event, end to end). Mobile side is
JS-only (ships OTA); the PR also carries a small os fix it exposed —
`ai.toMarkdown` now accepts bytes/base64 for `blob`, because a sandbox-made
Blob can't cross the RPC boundary (the documented agent recipe was broken).
Main missing pieces: real-phone dogfood pass, and the follow-ups listed at
the bottom (auto-sync, share sheet, embedding search).

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

- [x] `src/lib/screenshots.ts`: event type + payload, tag taxonomy, file
      path/idempotency-key derivation, pipeline script builder
      (JSON-embedded input, injection-safe), client-side search filter
      _apps/mobile/src/lib/screenshots.ts; script is evaluated (not string-asserted) in its unit test_
- [x] unit tests for script builder + search filter (root CI runs these)
      _7 tests incl. hostile-filename injection and dedup short-circuit_
- [x] `pickImages` gains a required `selectionLimit` param (chat passes 6,
      screenshots 20) _attachments.ts also now carries width/height_
- [x] Screenshots screen: capture → per-item progress → list with signed-url
      thumbnails, tag chips, search box; drawer item + route union
      _app/project/[projectId]/screenshots.tsx_
- [x] dedup: skip upload when `getEvent({ idempotencyKey })` already exists
      _client-side pre-check + server-side check inside the script + append idempotency key_
- [x] live e2e (`apps/mobile/e2e/screenshots.e2e.test.ts`): tiny PNG fixture
      through the whole pipeline — also the repo's first proof that
      image→toMarkdown works (cf-ai-to-markdown example is `e2eProven: false`)
      _passes against local dev; red-square fixture gets a real vision description_

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

- (found) `ai.toMarkdown({ name, blob: new Blob(...) })` — the documented
  recipe — fails from script sandboxes: capnweb can't serialize Blob
  ("Could not serialize object of type Blob"). Fixed at the product surface:
  `CfMarkdownDocument.blob` now takes the whole `FileData` union
  (bytes/base64/Blob), coerced server-side. Agent prompts, `__describe`, and
  the cf-ai-to-markdown example updated to the bytes form.
- (found) the coerced Blob needs a non-empty `type` — Workers AI's binding
  rejects `type: ""` with a bare zod "Too small: expected string to have >=1
  characters". `application/octet-stream` works; the converter picks the
  format from the `name` extension (result carries the real mimeType).
- (found) `@cf/meta/llama-3.2-3b-instruct` answers OpenAI-style
  (`choices[0].message.content`), not `.response` — tag parser handles both.
- default agent prompt was ~70 chars under its 17000-char ceiling; the recipe
  edit had to stay terse (agent-prompt-budgets.test.ts enforces it).
