---
status: in-progress
size: medium
tags: [mobile, media, agents, e2e]
follows: complete/2026-08-10-media-capture.md (PR #2462)
---

# Media followups (round 3)

**Status summary:** implemented, both live e2e lanes green against local
dev. All five checklist items done; deep-link resolver is origin-strict and
unit-tested; the agent-retrieval e2e finds the swimming lesson among decoys
through the same door agents use.

## Checklist

- [x] drawer label `Media` → `/media`, matching the `/repos` convention
      (Integrations in #2453 slots into the same drawer style)
- [x] clearer image paths _mediaFilePath in lib/media.ts_: files move from `/media/inbound/<sha256>-<name>`
      to `/media/<sha256>-<name>` — one namespace, so a media file's path
      *is* `/media/whatever.png`; document the mental model in the
      media-search example description (stream `/media` = events, files
      `/media/<hash>-<name>` = bytes; payload `path` is authoritative, so
      pre-rename captures keep resolving)
- [x] in-app deep-links for special streams _lib/in-app-links.ts + components/markdown.tsx_: the shared Markdown component's
      `onLinkPress` currently sends every URL to the system browser; add a
      small pure resolver mapping same-deployment URLs to in-app routes —
      `/media/...` → the Media screen (item focused via search), `/repos/...`
      → the repo screen — falling through to `Linking.openURL` otherwise.
      Extensible table so `/integrations/...` etc. can join later.
- [x] markdown-render media descriptions _media.tsx, collapsed rows clip via maxHeight_ in the list (reuse the chat
      `Markdown` component, preview mode collapsed / full when expanded)
- [x] agent-retrieval e2e reconstructing the sushi dogfood thread _e2e/media-agent-retrieval.e2e.test.ts, AppKit-rendered fixtures_: capture
      checked-in fake screenshots (a swimming-lesson email screenshot + two
      decoys), then run the media-search example the way an agent would and
      assert the swimming lesson's date/time is retrievable by keyword
      search over transcripts

## Guesses and assumptions

- [guess] `/media/<hash>-<name>` (drop `inbound/`) is the "clearer path" —
  hash prefix keeps content-addressed dedup, the flat namespace matches the
  question "is it /media/whatever.png?"
- [guess] deep-link focus lands on the Media screen with the search box
  prefilled from the linked filename, rather than a dedicated item route —
  cheaper, and search-by-filename uniquely finds the item
- [guess] the eval drives the media-search example via runScript (the same
  door agents use) rather than a full LLM agent turn — deterministic, cheap,
  and still proves the retrieval path end to end; a full agent-turn eval can
  layer on later

## Out of scope (tracked elsewhere)

- QR-scan freshness + state-mismatch switching (separate PR, in flight)
- full-screen viewer chrome (pinch-zoom, tap-toggled overlay, swipe-down)
- identify source app/website per item
- MediaProcessor reduced state + `itx.media` capability; embedding search

## Implementation log

- (starting) seam confirmed: `apps/mobile/src/components/markdown.tsx`
  `onLinkPress` is the single interception point for chat links.
