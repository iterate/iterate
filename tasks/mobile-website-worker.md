---
status: in-progress
size: large
branch: mobile-website
---

# mobile.iterate.com: the app's web surface leaves the kernel

## Status summary

Implemented and green (typecheck/lint/knip/format; website 19 tests,
scripts 291, os 3052, mobile 245). Scope grew mid-flight at Misha's ask:
mobile.iterate.com is also a **universal-link prefix** now — the worker
serves apple-app-site-association (team 5N6A5Q26NT, dug out of the build's
embedded.mobileprovision) for `/preview-channel/*`, bare paths are
canonical, and app.json gains the applinks entitlement (fingerprint moves →
this PR triggers the one build carrying it). Remaining: merge → first
deploy → cutover runbook below → phone-verify the universal link.

## Why (Misha, condensed)

apps/os is the kernel; apps/mobile is userland and gets no special
treatment — app-specific web surface shouldn't live in os. os is also not
optimized for page load at all (21MB bundle, startup-CPU-flaky deploys);
these phone-scan pages deserve a worker measured in KB.

## Decisions nailed down

- **Zero-framework.** Plain `export default { fetch }`, hand-rolled
  pathname match (four routes don't earn a router), HTML as template
  literals — which is what the handlers already are. Only runtime dep: the
  shared snapshot schema (zod via `@iterate-com/shared`). No react, no
  vite; wrangler bundles the TS entry directly (tunnels precedent).
- **The move IS the page-load optimization, not caching.** Dynamic pages
  stay `no-store` — "resolves the right build at scan time" is the product
  contract. Cold-start of a ~50KB worker + one R2 read is the whole latency
  story. Static/future assets (apple-app-site-association for universal
  links — a real reason this domain should exist) get long cache + etag.
- **Folder: `apps/mobile/website/`** (nested workspace package
  `@iterate-com/mobile-website`; pnpm-workspace gains the explicit path).
  Colocated with the app it serves.
- **prd-only, like tunnels.** QRs and the app's fetches only ever point at
  prd; preview e2e never touches `/m/*`; handlers are unit-tested. No
  preview env blocks, buckets, or GC. Hand-written wrangler.jsonc
  (`build: "checked-in-config"` via the shared deployApp pipeline).
- **Secrets: reuse os's admin bearer.** The CI writers already authenticate
  with `APP_CONFIG_ADMIN_API_SECRET` from doppler os/prd; the website's
  deploy runs under the same config and requires the same secret. No new
  doppler project.
- **Own R2 bucket** (`mobile-website-prd-state`, name-addressed,
  ensure-resources create-only) — no more `platform/` squatting in os's
  FILES_BUCKET. Cutover: backfill the `preview` snapshot with one PUT after
  first deploy (same op CI does per publish); delete the orphaned os key.
- **os keeps `/m/*` 301s** to mobile.iterate.com — QRs already printed in
  PR bodies and commit comments must keep working forever.

## What moves

| From (apps/os) | To (apps/mobile/website) |
| --- | --- |
| `src/routes/m.preview-channel.$channel.ts` | pathname match in worker |
| `src/routes/m.install.$channel.ts` | 〃 |
| `src/routes/m.install-manifest.$channel.ts` | 〃 |
| `src/routes/m.channel-status.$channel.ts` | 〃 |
| `src/domains/mobile/channel-status.ts` (+test) | `src/channel-status.ts` (+test) |

Pointers that change host (all via a new `mobileWebsiteEnvs` in envs.ts):
`scripts/ci/mobile-preview.ts` (interstitial/install/status URLs),
`apps/mobile/src/lib/build-state.ts` (`installPageUrl`, status fetch),
README/explainer copy.

## Checklist

- [x] envs.ts: `mobileWebsiteEnvs` (prd: worker `mobile-website-prd`,
      hostname `mobile.iterate.com`, dopplerProject os)
- [x] `apps/mobile/website/`: package.json, tsconfig, wrangler.jsonc
      (route + R2 binding + required secret), worker.ts (router),
      channel-status.ts (moved, bucket/secret injected), tests (moved +
      admin-auth against the plain secret), vitest config
- [x] scripts: deploy.ts + ensure-resources.ts (DNS record + R2 bucket,
      create-only) via shared deployApp/resolveEnvContext
- [x] `.depot/workflows/deploy-mobile-website.yml` (deploy-tunnels
      template, doppler os/prd)
- [x] os: delete the four routes + domains/mobile; add `/m/*` 301 catchall;
      remove EXPO-era comments pointing at os hosts
- [x] CI scripts + mobile app point at mobile.iterate.com
- [x] pnpm-workspace entry, knip.ts workspace entry, test.yml
      TEST_TELEMETRY_EXPECTED_WORKSPACES gains @iterate-com/mobile-website
- [x] Docs: apps/mobile README, explainer footer/glossary hosts,
      docs/architecture.md mention if it lists workers
- [x] Cutover runbook in PR body: deploy → ensure-resources → backfill PUT
      → verify /m/install/preview on the new host → confirm os 301s

## Universal links (added mid-flight)

- AASA covers ONLY `/preview-channel/*` — install/manifest pages must stay
  web pages (opening the old app would hide the Install button).
- PR-body tap links now use the bare universal-link path; the scan-path QR
  keeps the raw `iterate://` scheme (offline, instant, works on
  pre-entitlement binaries). One-QR consolidation is possible later once
  entitlement builds are the norm.
- Verify on device post-merge: install the new build, tap a PR body's OTA
  link → the app should open directly (no Safari hop).

## Cutover runbook (after merge)

1. deploy-mobile-website workflow runs on the merge (ensure-resources
   creates DNS + bucket, deploy + smoke).
2. Backfill the `preview` snapshot: one authenticated PUT to
   mobile.iterate.com/channel-status/preview (same op CI does per publish);
   the merge's own mobile publish may do it first if it runs after DNS is
   live.
3. Verify: GET mobile.iterate.com/install/preview shows "Install this
   build"; os.iterate.com/m/install/preview 301s there.
4. Delete the orphaned os FILES_BUCKET key
   `platform/mobile-channel-status/preview.json` (one-off; nothing reads it
   anymore).
