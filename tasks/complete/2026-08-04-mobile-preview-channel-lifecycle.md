---
status: done
size: medium
---

# Mobile preview channels: cleanup on PR close + in-app channel browser

**Status summary:** done. The two follow-ups deliberately left out of #2412: EAS channels/branches pile up forever once their PR closes, and discovering active channels requires finding the right PR body — the phone should just list them.

## Decisions

- **Cleanup**: new workflow on `pull_request: [closed]` over the same mobile paths → `scripts/ci/cleanup-mobile-pr-preview.ts` deletes the PR's EAS channel and branch (`channelForBranch` from `scripts/ci/mobile-preview.ts` keeps naming in lockstep) and the PR's QR assets from the `gh-attach-assets` release. Tolerant of absence — a PR whose preview never published must close clean.
- **Channel list transport**: an authenticated OS server route. The deployed worker already holds `EXPO_TOKEN` (deploy pushes the whole Doppler config as secrets), so it queries the EAS GraphQL API server-side; the repo is private so client-side/static alternatives (release assets, gists) don't work. Auth: a session-level itx method (Session.mobilePreviewChannels) — the phone already holds an authenticated session stub, so no new auth surface at all; the list is low-sensitivity (branch names) but not public.
- **App screen**: `preview-channels.tsx` listing active channels (name, latest update message, published-at), newest first, current override highlighted; tapping one routes to the existing `preview-channel/[channel]` confirm screen. Entry point next to Build info in the project drawer.

## Checklist

- [x] `scripts/ci/cleanup-mobile-pr-preview.ts` + `.depot/workflows/mobile-pr-preview-cleanup.yml`
- [x] ~~OS route serving the channel list from EAS GraphQL~~ _built, then removed: Misha ruled out shipping EXPO_TOKEN to the deployment. Channel discovery stays on PR-body QRs; a CI-pushed snapshot could enable a tokenless in-app list later_
- [x] ~~app: channels screen + drawer entry~~ _removed with the above_
- [x] tests: cleanup decision logic (pure, DI'd), channel-list response shaping; workflow schema test picks up the new yml
- [x] README: per-PR channels section gains the lifecycle story

## Notes

- Depends on scripts/ci/mobile-preview.ts landing via PR #2416 (shared helpers); rebase or merge that branch if it hasn't merged first.

## Implementation log

- EAS GraphQL query verified live against api.expo.dev before baking in (channels → latest update group message/createdAt/runtimeVersion).
- EXPO_TOKEN reaches the worker via OPTIONAL_SECRETS + Env.EXPO_TOKEN (same pattern as R2 keys); method reports available:false without it.
- itx contract regenerated (apps/os + packages/iterate mirrors) via generate:itx-api.
