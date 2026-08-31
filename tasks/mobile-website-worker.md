---
status: in-progress
size: large
branch: mobile-website
---

# mobile.iterate.com: the app's web surface leaves the kernel

## Status summary

Spec committed first; implementation follows on this branch. Move the four
`/m/*` routes + channel-status store out of apps/os into a tiny
zero-framework worker at `apps/mobile/website/`, served at
mobile.iterate.com, with os keeping 301s for already-printed QRs.

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

- [ ] envs.ts: `mobileWebsiteEnvs` (prd: worker `mobile-website-prd`,
      hostname `mobile.iterate.com`, dopplerProject os)
- [ ] `apps/mobile/website/`: package.json, tsconfig, wrangler.jsonc
      (route + R2 binding + required secret), worker.ts (router),
      channel-status.ts (moved, bucket/secret injected), tests (moved +
      admin-auth against the plain secret), vitest config
- [ ] scripts: deploy.ts + ensure-resources.ts (DNS record + R2 bucket,
      create-only) via shared deployApp/resolveEnvContext
- [ ] `.depot/workflows/deploy-mobile-website.yml` (deploy-tunnels
      template, doppler os/prd)
- [ ] os: delete the four routes + domains/mobile; add `/m/*` 301 catchall;
      remove EXPO-era comments pointing at os hosts
- [ ] CI scripts + mobile app point at mobile.iterate.com
- [ ] pnpm-workspace entry, knip.ts workspace entry, test.yml
      TEST_TELEMETRY_EXPECTED_WORKSPACES gains @iterate-com/mobile-website
- [ ] Docs: apps/mobile README, explainer footer/glossary hosts,
      docs/architecture.md mention if it lists workers
- [ ] Cutover runbook in PR body: deploy → ensure-resources → backfill PUT
      → verify /m/install/preview on the new host → confirm os 301s
