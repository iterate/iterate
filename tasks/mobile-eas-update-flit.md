---
status: in-progress
size: medium
---

# Mobile: OTA updates on merge + build info screen

**Status summary:** spec committed, implementation starting. Nothing wired yet.

The workflow Misha wants: flit freely between the Metro-connected dev client
(agent working on the app, laptop nearby) and a standalone preview build
(real usage, laptop off). Both builds overwrite each other (same bundle ID) —
that's fine. The missing piece: the preview build should track main
automatically, without a 15-minute native rebuild per merge.

## Approach

EAS Update. The preview binary embeds `expo-updates` pointed at the `preview`
channel; a Depot CI job on every merge to main publishes the JS bundle
(`eas update --channel preview`, seconds). Installed preview apps pull the
new JS on next launch. Native builds happen only when the project fingerprint
changes — CI detects that (no existing preview build with the update's
runtime version) and kicks off `eas build --profile preview --no-wait`.

`EXPO_TOKEN` lives in Doppler `_shared` (inherited by `os/prd`), readable in
CI via the existing `DOPPLER_TOKEN`.

## Checklist

- [ ] `expo install expo-updates expo-application`; configure `updates.url` +
      `runtimeVersion: {policy: "fingerprint"}` in app.json; channels in
      eas.json (`preview` → preview profile, `production` → production)
- [ ] `scripts/write-build-info.mjs` — stamps `src/build-info.json`
      (commit, branch, builtBy, builtAt) from git or EAS builder env vars;
      checked-in placeholder so Metro/typecheck work without running it;
      `eas-build-pre-install` hook runs it on EAS builders
- [ ] Build info screen (`src/app/build-info.tsx`): branch/commit/builder/
      time from build-info.json; channel, runtime version, update id,
      update published-at, embedded-vs-OTA from `expo-updates`; app install
      time from `expo-application`; a "check for update now" button
      (fetch + reload)
- [ ] Drawer item in `project-drawer.tsx` linking to it
- [ ] `.depot/workflows/mobile-eas-update.yml` — on push to main (mobile
      paths), publish update via `scripts/ci/publish-mobile-update.ts`,
      auto-trigger native preview build on fingerprint change
- [ ] README: document the dev ↔ preview flit workflow
- [ ] typecheck / test / lint / knip green

## Notes / decisions (made while Misha tests the first preview build)

- Same bundle ID everywhere, deliberately: installs overwrite, keychain
  survives, sign-in persists across flits.
- `expo-updates` + `expo-application` are new native modules → the first
  merge changes the fingerprint, so CI's first run self-heals by triggering
  a fresh preview build. The dev client needs one manual
  `pnpm --dir apps/mobile build:development:ios` after merge, same as any
  native-module change (README already documents that rhythm).
- Dev client gets no channel: it loads from Metro; the EAS Updates tab in
  the dev launcher is a bonus, not the mechanism.
