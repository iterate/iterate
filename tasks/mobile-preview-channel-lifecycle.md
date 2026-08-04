---
status: in-progress
size: medium
---

# Mobile preview channels: cleanup on PR close + in-app channel browser

**Status summary:** spec committed first. The two follow-ups deliberately left out of #2412: EAS channels/branches pile up forever once their PR closes, and discovering active channels requires finding the right PR body — the phone should just list them.

## Decisions

- **Cleanup**: new workflow on `pull_request: [closed]` over the same mobile paths → `scripts/ci/cleanup-mobile-pr-preview.ts` deletes the PR's EAS channel and branch (`channelForBranch` from `scripts/ci/mobile-preview.ts` keeps naming in lockstep) and the PR's QR assets from the `gh-attach-assets` release. Tolerant of absence — a PR whose preview never published must close clean.
- **Channel list transport**: an authenticated OS server route. The deployed worker already holds `EXPO_TOKEN` (deploy pushes the whole Doppler config as secrets), so it queries the EAS GraphQL API server-side; the repo is private so client-side/static alternatives (release assets, gists) don't work. Auth mechanism: whatever the mobile app already uses for OS app-lane routes — to be pinned down during implementation; the list is low-sensitivity (branch names) but not public.
- **App screen**: `preview-channels.tsx` listing active channels (name, latest update message, published-at), newest first, current override highlighted; tapping one routes to the existing `preview-channel/[channel]` confirm screen. Entry point next to Build info in the project drawer.

## Checklist

- [ ] `scripts/ci/cleanup-mobile-pr-preview.ts` + `.depot/workflows/mobile-pr-preview-cleanup.yml`
- [ ] OS route serving the channel list from EAS GraphQL (cache a minute or two; EAS rate limits are unknown)
- [ ] app: channels screen + drawer entry, tap-through to the confirm screen
- [ ] tests: cleanup decision logic (pure, DI'd), channel-list response shaping; workflow schema test picks up the new yml
- [ ] README: per-PR channels section gains the lifecycle story

## Notes

- Depends on scripts/ci/mobile-preview.ts landing via PR #2416 (shared helpers); rebase or merge that branch if it hasn't merged first.
