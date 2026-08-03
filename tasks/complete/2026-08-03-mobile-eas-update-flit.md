---
status: implemented
size: medium
---

# Mobile: OTA updates on merge + build info screen

**Status summary:** implemented, checks green (typecheck, tests, oxlint,
knip, expo export). Remaining: merge, then install the CI-triggered preview
build once and rebuild the dev client (new native modules).

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

- [x] expo-updates config _`expo install expo-updates expo-application` +
      `eas update:configure`, then switched runtimeVersion policy from its
      appVersion default to fingerprint (appVersion would let native-module
      merges silently strand old binaries); channels per profile in eas.json_
- [x] build stamping _`apps/mobile/scripts/write-build-info.mjs` →
      `src/build-info.json` (checked-in all-empty placeholder); runs via CI
      publish script and the `eas-build-pre-install` hook; also replaces the
      hand-maintained BUILD_TIMESTAMP in `src/lib/build-info.ts`_
- [x] Build info screen _`src/app/build-info.tsx`: bundle
      branch/commit/builder/time, update channel/runtime/id/published,
      app version/native build/install time, check-for-update-now button
      (guarded by `Updates.isEnabled` so Metro dev shows a note instead)_
- [x] Drawer item _"Build info" in `project-drawer.tsx`, below Switch
      project_
- [x] CI workflow _`.depot/workflows/mobile-eas-update.yml` → 
      `scripts/ci/publish-mobile-update.ts`; concurrency-serialized so
      updates publish in commit order; triggers a native preview build when
      no NEW/IN_QUEUE/IN_PROGRESS/FINISHED preview build matches the
      published runtime version_
- [x] README _"Dev ↔ preview: two builds, one phone" section_
- [x] typecheck / test / lint / knip green _plus `expo export --platform
      ios` as a bundle smoke_

## Post-merge notes

- First CI run will publish an update, find no preview build for the new
  fingerprint (expo-updates + expo-application are new native modules), and
  trigger one. Install it from its EAS page — that's the last manual preview
  install until the next native change.
- The dev client needs `pnpm --dir apps/mobile build:development:ios` for the
  same reason.
- The preview build Misha installed on 2026-08-03 (pre-expo-updates) can
  never receive OTA updates; it gets replaced by the above.
