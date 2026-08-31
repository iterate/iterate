---
status: in-progress
size: large
branch: mobile-native-build-economy
base: mobile-merged-qr (#2550)
---

# Mobile: native builds only on fingerprint change

## Status summary

Spec committed first; implementation not started yet. Main pieces planned:
stop building a native binary per PR, key builds on the runtime fingerprint
instead, make install links live-resolving interstitials, and teach the app
to say "this channel's JS needs a different native build" with a Download
button.

## The ask (Misha, verbatim-ish)

"No more native build on every push. too expensive. do a native build when
there are necessary changes (do we have some kind of fingerprinting
mechanism?); keep track of what the expected native build is, bake that into
the JS bundle; have the JS bundle say 'This JS bundle expects a different
native build' with a Download button taking us to the expo.dev link; for the
'native build installer that always works' link it can be an interstitial of
some kind. Don't regress the recent QR just-works guarantees."

## Where the cost actually is

We already fingerprint: `runtimeVersion` uses expo's fingerprint policy
(`apps/mobile/fingerprint.config.js`), and builds are only triggered when no
build matches. But `ensureBuildForPr` requires a build whose **channel**
matches the PR's channel (baked via the `preview-pr` profile rewrite, #2542).
No PR channel ever has a build, so **every mobile PR triggers a ~20-minute
EAS build** even when its fingerprint is identical to main's — that build
exists purely so that "install the build" lands you on the PR's JS without a
second scan. That convenience is what we're paying a build-per-PR for.

## Design

### 1. One native build per runtime fingerprint

- All CI builds use the plain `preview` profile (channel `preview`). Delete
  the `preview-pr` profile, `easJsonWithChannel`, `withProfileChannel`,
  `buildProfileForChannel`.
- `ensureBuildForPr({channel, runtime})` becomes
  `ensureBuildForRuntime({runtime})`: any FINISHED build with the runtime
  wins, else any in-progress one, else trigger `preview` (--no-wait).
- Consequences:
  - JS-only PRs (the common case): **zero builds**.
  - Native-change PRs: **one build**, and because it's channel-`preview`,
    the post-merge main publish finds it already FINISHED — no second build,
    and #2550's refresh job becomes a rare-path safety net instead of the
    normal native-merge path.
  - Sibling PRs with the same fingerprint share the build.

### 2. Install links become live interstitials (never stale)

New OS routes (public, like `m.preview-channel.$channel`):

- `/m/install/<channel>` — HTML interstitial: shows the channel's expected
  native build (from the status store below), a big link to its expo.dev
  install page ("build still running" state when not finished), and an
  **Open in app** deep link (`iterate://preview-channel/<channel>`) so the
  post-install channel switch is one tap on a page you already have open.
  Missing status → fallback: deep link + EAS builds-list link (what the
  current interstitial shows).
- `/m/channel-status/<channel>` — the same data as JSON (CORS `*`) for the
  app.

PR-body/commit-comment **install QRs encode `/m/install/<channel>`** — the
QR content is channel-stable, so a QR printed three pushes ago still
resolves to the right build today. OTA QRs keep encoding the raw
`iterate://preview-channel/<channel>` scheme URL (camera-scan path — no
browser hop; deliberate, don't regress).

Because both QR contents are now sha-independent, asset names drop the sha:
one OTA + one install PNG per PR (still cleaned up by the
`mobile-pr-<n>-` prefix), and two stable assets for main instead of two new
ones per merge.

### 3. The status store: CI-pushed, tokenless reads

`apps/mobile/README.md` records a deliberate decision NOT to ship
`EXPO_TOKEN` to the deployment, and hints at "a CI-pushed snapshot". So the
worker never calls the EAS API; CI pushes a per-channel snapshot to prd OS
at publish time:

- Shape: `{channel, runtimeVersion, buildId, installUrl, buildFinished,
  commit, message, publishedAt}`.
- Writers (all already-existing hooks, now writing status too):
  - `publish-mobile-pr-preview.ts` — on every PR push
  - `publish-mobile-update.ts` — on every merge (channel `preview`)
  - `refresh-mobile-main-qr.ts` — flips `buildFinished` when the build lands
  - `cleanup-mobile-pr-preview.ts` — deletes the channel's status on close
- Write path: admin-authenticated OS endpoint — `Authorization: Bearer
  $APP_CONFIG_ADMIN_API_SECRET` via `authenticateAdminApiSecret`
  (`apps/os/src/auth/admin.ts`); CI already runs under
  `doppler --project os --config prd`, which carries that secret. Storage:
  R2 `FILES_BUCKET` under the reserved `platform/` key prefix (project file
  keys start `prj_…` so no collision; R2 is read-after-write consistent,
  unlike KV, and needs no envs.ts id). Handler logic lives in a non-route
  module (the routes dir excludes tests) following
  `operator-session.ts`/`.test.ts`; zod-validate the body hard. Write
  failures fail the publish loudly — silent drift is the thing this task
  kills.
- Known staleness: a PR build that finishes after publish keeps
  `buildFinished: false` until the next push (nothing polls PR builds — by
  design, same as today's PR sections). The interstitial links the concrete
  build page either way, and that page is live truth.

### 4. The app says "you need a different native build"

Today `checkForUpdateAsync` can't distinguish "current" from "the channel
has newer JS this binary can't run" (the server filters by runtime — see
`build-state-core.ts` UpdateCheck docs). Close the gap with the status
endpoint:

- `build-state` gains a channel-status query against prd
  (`/m/channel-status/<channel>`); pure comparison lives in
  `build-state-core.ts`: status runtime ≠ binary runtime → new
  `UpdateStatus` kind `"incompatible"` carrying the install URL.
- Watched builds surface it as the update row / banner: "This channel's
  latest JS expects a different native build" + **Download** button
  (opens the interstitial).
- The QR confirm screen's switched-but-no-update note upgrades from "either
  nothing is published yet, or the PR has native changes" to the precise
  verdict + Download button.

### 5. Bake the expected runtime into the bundle

`write-build-info.mjs` stamps `runtimeFingerprint`: the publisher computes
the fingerprint (`npx expo-updates fingerprint:generate`) before stamping
and asserts post-publish that `eas update` agreed (loud failure on drift).
Build info shows it; it's the bundle's own record of which native build it
expects. (Detection of mismatch still rides the status endpoint — a bundle
that can't run never gets to report anything.)

## Explicitly not regressing (guarantees from the last few days)

- OTA QR = raw scheme URL, camera-scannable without a browser hop (#2542).
- Scanning always pulls the channel's latest + backend/identity mismatch
  cards (qr-scan-freshness).
- Merged PRs get main's section; close-vs-merge race guard; refresh job
  (#2550) — all kept, just re-pointed at interstitial links.
- The new-install guard (override cleared on first boot of a new binary)
  keeps its ordering trap defused: the interstitial's "Open in app" tap
  comes after install, which is the correct order by construction.
- The two-QR PR section stays two QRs (scan-direct OTA + install); what
  changes is that the install QR is channel-stable and always resolves.

## Checklist

- [ ] `mobile-preview.ts`: `ensureBuildForRuntime` (drop channel matching,
      always `preview` profile), delete the eas.json rewrite machinery,
      delete `preview-pr` from eas.json
- [ ] `mobile-preview.ts`: install links/QRs → `/m/install/<channel>`;
      sha-independent asset names; section copy updated (install no longer
      lands you on the PR channel by itself — the interstitial sequences it)
- [ ] OS: status store (admin-auth write endpoint + storage) with tests
- [ ] OS: `/m/install/$channel` interstitial + `/m/channel-status/$channel`
      JSON (CORS), fallback rendering when status is missing
- [ ] CI writers: publish-pr / publish-main / refresh / cleanup push status
- [ ] `write-build-info.mjs` + publishers: stamp `runtimeFingerprint`,
      assert it matches the published runtime
- [ ] App: `build-state-core` `"incompatible"` status + tests;
      channel-status query; Download button on the banner/Build info and the
      QR confirm screen's no-update path
- [ ] README (apps/mobile): per-PR channels section rewritten for the new
      build economics; note the status store
- [ ] Tests: scripts planners, OS routes, mobile core; specs where the web
      lane can exercise them
