---
status: in-progress
size: small
branch: mobile-itms-install
base: mobile-native-build-economy (#2555)
---

# Install the app from our own interstitial (itms-services)

## Status summary

Spec committed first; implementation follows in this branch. One coherent
change: the install page installs the app in place instead of bouncing
through expo.dev.

## The problem

`/m/install/<channel>` links the expo.dev build page, whose Install tap
fires `itms-services://` (native iOS dialog, background install, Safari
stays put). expo.dev takes no callback URL, so getting back to our page for
the "Open in app" step is a manual Back tap.

## The unlock

`eas build:list` exposes `artifacts.applicationArchiveUrl` — a **stable,
unsigned** expo.dev `.ipa` URL, valid until the build's `expirationDate`
(~90 days; verified live on build 6932e8e3). iOS installs ad-hoc apps from
any https manifest plist, so OS can serve the manifest itself and the
interstitial's Install button becomes
`itms-services://?action=download-manifest&url=<https manifest>` — install
happens ON our page, with "Open in app" sitting right below it.

## Design

1. **Snapshot grows three optional fields**
   (`packages/shared/src/mobile-channel-status.ts`): `ipaUrl`, `appVersion`,
   `bundleId`. Optional is justified here: old snapshots predate the fields,
   an old deployed worker's zod strips unknown keys from a new CI's PUT
   (deploy-order tolerance), and a freshly triggered build has no artifact
   yet. Absence of any of them = the interstitial keeps today's
   build-page-link behavior.
2. **CI writers fill them.** `ensureBuildForRuntime` (and the refresher's
   `build:view`) pass through `artifacts.applicationArchiveUrl`;
   `appVersion`/`bundleId` come from `app.json` (`expo.version`,
   `expo.ios.bundleIdentifier`). A PR build that finishes later gets its
   `ipaUrl` on the next push, same staleness contract as `buildFinished`.
3. **OS serves the manifest**: `/m/install-manifest/<channel>` renders the
   plist (kind software, bundle-identifier, bundle-version, title,
   software-package = ipaUrl) from the snapshot; 404 when the snapshot is
   missing or lacks the fields. `application/xml`, XML-escaped, no-store.
4. **Interstitial CTA**: when `buildFinished && ipaUrl && bundleId &&
   appVersion`, the primary button is the itms-services link ("installs in
   place — watch your home screen, then tap Open in app below"); the
   expo.dev build page demotes to a "build details" link. Otherwise
   unchanged. Manifest URL derives from the request's own origin, so
   previews serve their own.
5. **Explainer + README copy** updated (install now happens on the page).

## Not doing

- Signed/expiring manifest URLs: the ipa URL is already unguessable
  (content-hash path) and expires with the build; the manifest exposes
  nothing the build page didn't.
- display-image in the manifest: generic icon during install is fine.
- Android: iOS-only flow, like everything else here.

## Checklist

- [ ] Schema: optional `ipaUrl`/`appVersion`/`bundleId` + comment on why
      optional
- [ ] `mobile-preview.ts`: `InstallBuild.ipaUrl`; writers pass
      ipaUrl/appVersion/bundleId; refresher upgrades ipaUrl when the build
      finishes
- [ ] OS: `handleInstallManifestRequest` + thin route, plist rendering,
      404s, tests (incl. XML escaping)
- [ ] OS: interstitial itms CTA variant + demoted build-details link, tests
- [ ] Explainer + README copy
- [ ] Gauntlet: typecheck, lint, knip, format, scripts + os tests
