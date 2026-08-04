---
status: in-progress
size: medium
---

# Mobile: per-PR preview channels with in-app switcher and PR-body QRs

**Status summary:** spec committed first. Kills last-write-wins on the shared `preview` channel: PRs publish to their own channel, the app can switch channels via deep link, and every mobile PR gets tappable QRs in its body.

Today every publisher (merge-to-main CI, PR-branch agents) writes to the one `preview` channel, so whatever published last is what's on Misha's phone — his #2410 preview got silently replaced by an unrelated main merge within minutes. Decided 2026-08-04: per-PR channels, in-app switcher, QRs on PR bodies.

## Design

- `preview` channel becomes **main-only**. PRs publish to a channel named after their branch (sanitized: non `[a-z0-9._-]` chars → `-`).
- Channel switching uses `Updates.setUpdateRequestHeadersOverride({"expo-channel-name": ...})` — the headers-only override, which does **not** need `disableAntiBrickingMeasures` (override keys only have to exist in the embedded headers, and EAS builds embed `expo-channel-name`). Persisted natively in UserDefaults across restarts.
- Deep link `iterate://preview-channel/<channel>` opens a confirm screen (no auto-switch on link open) that applies the override, fetches, reloads.
- A managed PR-body section (markdownAnnotator, like loc-report) shows **both** QRs in `<details>` blocks for any PR touching `apps/mobile/**` — OTA deep-link QR and full-install QR — with the heuristic picking which is expanded: PR runtime matches the latest finished preview build → OTA open; otherwise install open (OTA still present: Misha may have installed this branch's native build earlier). QR PNGs upload to the existing `gh-attach-assets` release; images render inline from release URLs, wrapped in `<a>` so they're tappable when reading the PR on the phone.
- Native-change case: find a usable build for the PR's runtime, trigger one (`--no-wait`) if none.

## Checklist

- [ ] `apps/mobile/src/lib/preview-channel.ts`: set/clear channel override + AsyncStorage mirror (expo-updates has no getter)
- [ ] `apps/mobile/src/app/preview-channel/[channel].tsx`: deep-link confirm screen (switch → check → fetch → reload; friendly "nothing published/incompatible" outcome)
- [ ] Build info screen: show active channel override + "reset to default channel" action
- [ ] `write-build-info.mjs`: prefer `GITHUB_HEAD_REF` (PR head branch) over `GITHUB_REF_NAME` for the branch stamp
- [ ] `scripts/ci/publish-mobile-pr-preview.ts`: publish PR channel, decide js-only vs native, ensure build exists for native, generate + upload QRs, write PR-body section
- [ ] `.depot/workflows/mobile-pr-preview.yml`: pull_request on `apps/mobile/**`, per-PR concurrency (cancel-in-progress), contents:write + pull-requests:write
- [ ] unit tests for the decision + rendering logic (pure functions, DI'd exec — no mocks)
- [ ] README blurb in `apps/mobile/README.md`

## Notes

- Stacked on `mobile-fingerprint-sourceskips` (PR #2411) — without sourceSkips, script-only package.json edits would misclassify PRs as native.
- Follow-up (not here): clean up EAS channels/branches when PRs close; an in-app *list* of open PR channels (needs an authed EAS API proxy).
