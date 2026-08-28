---
status: in-progress
size: large
---

# Mobile: one module owns "which build am I on, and is it current?"

## Status

Both halves implemented on `mobile-build-state`
([#2542](https://github.com/iterate/iterate/pull/2542)). Done: the module and
its 11 unit tests, the app-global session, the rewritten Build info and QR
screens, the update banner, per-PR builds with the channel baked in, and the
docs. Not done: stamping the available update's commit message into app config
`extra` (see "corrections" — the cheap half of it landed, the config change did
not), and a device pass.

**Two plan claims turned out to be wrong. See [Corrections](#corrections).**

Two halves:

1. **Consolidate.** Every query and mutation about the running bundle, the
   native binary, the OTA channel and update freshness moves into one module.
   Build info and the QR confirm screen become dumb views over it.
2. **Fix the four things that are actually broken.** The native-build QR that
   drops you on the wrong channel; no "am I stale?" check on open; the
   `not signed in` lie; and Build info not showing what you asked it to show.

---

## How it works today

### The moving parts

| Thing | Where it lives | Who reads it |
| --- | --- | --- |
| **Bundle stamp** — branch, commit, message, builder, expected backend, test email | `src/build-info.json`, written by `apps/mobile/scripts/write-build-info.mjs` at publish time, compiled *into the JS bundle* | `src/lib/build-info.ts` → Build info, sign-in screen, QR screen |
| **Native binary facts** — version, build number, install time | `expo-application` | Build info |
| **Runtime fingerprint** — which JS a binary will accept | `Updates.runtimeVersion`, from `fingerprint.config.js` | Build info, CI's QR heuristic |
| **Default channel** — baked into the binary at build time | `Updates.channel`, from the `eas.json` build profile (`preview`, `development`) | Build info only |
| **Channel override** — "point this binary at a PR's JS" | native UserDefaults (write-only via `Updates.setUpdateRequestHeadersOverride`), mirrored into AsyncStorage because expo-updates has no getter | `src/lib/preview-channel.ts` |
| **Auto-continue marker** — one-shot "the Switch tap already consented" | AsyncStorage, survives the reload | `src/lib/preview-channel.ts` |
| **Last-seen binary identity** — detects a fresh install | AsyncStorage | `src/lib/native-install-guard.ts` |
| **Sign-in** | keychain, keyed per server base URL | `src/lib/auth.ts` + `storage.ts` |

### The screens

- **`src/app/build-info.tsx`** — three cards (Bundle / Updates / App), a
  *Check for update* button, a *Reset to default channel* button. Owns four of
  its own queries and mutations.
- **`src/app/preview-channel/[channel].tsx`** — the QR deep-link target. 435
  lines. Owns six queries/mutations: current override, freshness pull,
  phone state (server + signed-in email, sometimes two token refreshes),
  auto-continue, channel switch, apply-plan. Also owns the whole
  "this bundle expects a different backend" comparison UI.
- **`src/app/_layout.tsx`** — runs the new-install guard at the root and pops
  an `Alert` when it clears an override.
- **`src/app/index.tsx`** — reads the bundle stamp again to preselect a server
  and a login hint.

Four files, four separate readings of the same facts, no shared vocabulary.

### The CI side

`scripts/ci/publish-mobile-pr-preview.ts` (per PR) and
`publish-mobile-update.ts` (per merge to main) both:

1. stamp `build-info.json`,
2. `eas update --channel <branch-derived channel>`,
3. find or trigger a native build whose runtime fingerprint matches
   (`ensureBuildForRuntime`),
4. render two QR codes into the PR body (or a commit comment) via
   `renderPreviewSection`.

The **OTA QR** encodes `iterate://preview-channel/<channel>` — the camera
opens custom schemes directly. The tappable caption goes through an https
interstitial (`apps/os/src/routes/m.preview-channel.$channel.ts`) because
GitHub strips custom-scheme hrefs.

The **install QR** encodes an `expo.dev` build page URL. That URL carries no
channel.

Which one is expanded is decided by one heuristic: is the runtime fingerprint
of the update we just published equal to the fingerprint of *the newest
finished preview build in the whole EAS project*
(`latestInstalledRuntime()`)?

### Why the native-build QR doesn't work

Four independent reasons, all live:

1. **The install QR carries no channel.** A preview-profile binary boots on
   channel `preview`, which is main. Install it and you are running main's JS,
   not the PR's. The PR body says so in fine print and tells you to go scan
   the *other* QR.
2. **When you need the install QR, the OTA QR is collapsed.** They are
   mutually exclusive `<details open>` blocks. Exactly when the runtime
   differs — the one case where you must use both, install then switch — the
   switch link is folded away.
3. **The new-install guard force-clears the override.**
   `resetChannelOverrideForNewInstall()` fires on the first boot of any new
   binary. It is right in general (installing a build should mean running that
   build) but it also means install-then-switch has a strict ordering: switch
   *after* the install, never before. Nothing tells you that.
4. **The heuristic guesses about a phone it cannot see.**
   `latestInstalledRuntime()` reads the newest finished EAS build, not what is
   on the phone. An older binary on the phone, or a build still queued, and
   the wrong QR is expanded.

Net: the install path is "scan, install, come back, expand a collapsed
section, scan again, confirm" — with a silent wrong answer if you do it in the
other order.

### Why nothing tells you you're stale

`expo-updates` is left on its default `checkAutomatically: ON_LOAD`. So on
every launch it *does* check and download in the background — but it applies
on the **next** launch, and says nothing. The only visible freshness checks
are two explicit ones: the Build info button, and the QR screen's per-mount
pull. On a PR channel you can sit on JS from three pushes ago and the app will
look completely normal.

### Why it says "not signed in"

One string, in the QR screen's mismatch card:

```tsx
value={`${mismatch.current || "not signed in"} → ${mismatch.recommended}`}
```

`mismatch.current` is the email signed in **on the recommended server** — not
the app's session. Phone signed into prd, bundle stamped for `preview_7`, and
the card announces "not signed in", which reads as a claim about you.

Underneath: there is no app-global session at all. `hasSignIn(baseUrl)` and
`getSignedInEmail(baseUrl)` are re-derived from the keychain at each callsite,
per server URL, and two screens separately catch `SignInRequiredError` and
`router.replace("/")`.

> Needs a repro before I trust the diagnosis: if you also see it *outside* the
> QR screen, the cause is different (most likely the server base URL moved to
> a deployment you have no keychain entry for, so `getAccessToken` throws
> `SignInRequiredError("Not signed in.")` and bounces you to the sign-in
> screen). Say which screen you saw it on and I'll pin it.

### What Build info doesn't show

You asked for current OTA branch, the build's default OTA branch, and commit
messages. Today: `Updates.channel` and the override are both shown but
unlabelled as default-vs-current; the running bundle's commit message is
shown; the **available** update's commit message is not shown at all, because
nothing looks at it.

---

## Corrections

Both found while implementing, both change the design rather than the goal.

### 1. `eas.json` IS a fingerprint source

The plan said the channel was safe in `eas.json` because fingerprint never
reads it. Wrong — `expo-updates fingerprint:generate` lists it explicitly:

```
{"type":"file","filePath":"eas.json","reasons":["easBuild"],"hash":"331eee28…"}
```

Measured: changing one profile's `channel` moves the fingerprint from
`fdfdff89` to `793605ca`. Rewriting `eas.json` per PR would therefore have
given each PR's build its own runtime version — and that build would refuse
the very updates the PR publishes. The exact failure the plan claimed to be
avoiding.

(`preview` and `production` share a runtime today only because they live in
the *same file*: the bytes don't differ per profile.)

**Fix:** `fingerprint.config.js` gains `ignorePaths: ["eas.json"]`. Measured
again with the ignore in place: the channel change leaves the hash
byte-identical (`fca56340` both times).

Two consequences, both accepted:

- The baseline hash moves once (`fdfdff89` → `fca56340`), so every installed
  binary needs one rebuild. CI already triggers one when no build matches.
- `eas.json`'s other fields (`distribution`, `developmentClient`, `simulator`)
  stop bumping the runtime. They shape which *binary* you get, not which JS a
  binary can run, and each already lives on its own channel.

### 2. There is no honest "incompatible" update status

The plan wanted the app to distinguish "you're current" from "the channel has
newer JS your binary can't run". It can't. `checkForUpdateAsync` answers
`noUpdateAvailableOnServer` for both, because the update server filters by
runtime version *before* it replies.

Same reason the app can't say how many commits behind you are — only that
something newer exists. So the copy is "You're on the latest update this build
can run", and the banner names the commit instead of counting.

## The module

`apps/mobile/src/lib/build-state.ts`. One owner for the whole question.

Absorbs `build-info.ts`, `preview-channel.ts`, `native-install-guard.ts`, and
the queries currently inlined in the four screens. `expected-backend.ts` stays
as it is — it is pure, well tested, and about *backends*, not builds — but its
callers go through this module.

### Shape

```ts
// Pure. Every branch unit-tested in the node lane, no Expo imports.
export function describeBuildState(facts: BuildFacts): BuildState;

// Effectful. One query key, one mutation set. What the views use.
export function useBuildState(): BuildState;
export function useBuildActions(): BuildActions;

// Mounted once in _layout.tsx. Owns the on-open check and the stale banner.
export function UpdateWatcher(): JSX.Element | null;
```

```ts
type BuildState = {
  /** The JS actually executing. */
  running: {
    branch: string;
    commit: string;
    message: string;
    builtBy: string;
    publishedAt: Date | null;
    source: "metro" | "embedded" | "ota";
  };
  /** The binary underneath it. */
  binary: {
    version: string;
    buildNumber: string;
    runtimeVersion: string;
    installedAt: Date | null;
    /** The channel baked in at build time — "the default OTA branch for my
     *  build", and with per-PR builds also the branch the binary was made for. */
    defaultChannel: string;
  };
  /** What updates are actually fetched from — the override, else
   *  binary.defaultChannel. "Overridden" is just current !== defaultChannel. */
  channel: string;
  update:
    | { status: "current" }
    | { status: "behind"; latest: { commit: string; message: string; publishedAt: Date } }
    | { status: "pending" }          // downloaded, applies on reload
    | { status: "incompatible" }     // channel has newer JS this binary can't run
    | { status: "unsupported"; why: "metro" | "dev" }
    | { status: "checking" }
    | { status: "error"; message: string };
  /** Not on the binary's own channel, or not a main binary: watch on every open. */
  watched: boolean;
  /** From expected-backend.ts — what this bundle wants the app pointed at. */
  expectation: Recommendation;
};

type BuildActions = {
  switchChannel(channel: string | null): Promise<"reloading" | "no-update">;
  checkNow(): Promise<void>;
  applyPending(): Promise<never>;        // reloadAsync
  resetToDefaultChannel(): Promise<void>;
};
```

`describeBuildState` takes plain facts in — the stamp, the `Updates.*`
constants, the stored override, the result of a check — and returns the view
model. That is where every rule lives (is this watched? is this incompatible
or merely behind? is source embedded or OTA?), and it is testable without a
device.

### Getting the available update's commit message

`checkForUpdateAsync()` returns the manifest of the update it found, and
`manifest.extra.expoClient` is the app config as evaluated at publish time. So
if the stamp is *also* written into app config `extra.buildInfo` — not only
into `src/build-info.json` — we can show the branch, commit and message of an
update we have not downloaded yet. That is what turns "an update is available"
into "you're 1 behind: `fix the drawer glyph`".

Cost: `app.json` becomes `app.config.js` so it can read the stamp, and
`fingerprint.config.js` gains `ExpoConfigExtraSection` to its `sourceSkips` —
without it, every commit changes the fingerprint and strands every installed
binary. **Verify with `npx expo-updates fingerprint:generate` before and after
a stamp change; do not merge on assumption.**

If that turns out to be fragile, tier 1 without it still works: "a newer
update was published 12 minutes ago" from `manifest.createdAt` alone.

### What the views become

- **Build info** — one `useBuildState()` call, rows and four buttons. No
  queries of its own. Gains the rows you asked for:

  ```
  CHANNEL
    Current            specs-create-agent-sweep
    Default for build  specs-create-agent-sweep   (this build is the PR's)
  RUNNING JS
    Branch             specs/create-agent-sweep
    Commit             3f0e48f  Playwright sweep: adopt createAgent
    Published          14:22, 8 minutes ago
    Source             OTA update
  UPDATE
    Status             1 behind — "fix the drawer glyph", 2 minutes ago
    [ Update now ]
  ```

- **QR confirm screen** — keeps its two decisions (confirm before switching,
  auto-pull once on target) but reads state and calls actions instead of
  owning six queries. Target: under 200 lines.
- **`_layout.tsx`** — renders `<UpdateWatcher />` instead of an inline guard
  query and an `Alert`.
- **`index.tsx`** — reads `expectation` off the module.

---

## The four fixes

### 1. Per-PR native builds, so the install QR lands on the PR's channel

The install QR keeps pointing straight at the EAS install page and the OTA QR
keeps being a bare `iterate://` link. What changes is the **binary**: a PR's
build gets that PR's channel baked in, so installing it *is* being on the PR's
JS. No interstitial, no second scan, no ordering to get wrong.

**Where the channel can live.** Not in app config. `@expo/fingerprint`
normalizes the Expo config and strips nothing under `updates` except
`updates.url`, so putting `updates.requestHeaders["expo-channel-name"]` in
`app.config.js` would move the runtime fingerprint on every PR — which would
break the OTA path for every PR with no native changes. The channel has to
stay where it is today: **`eas.json`**, which fingerprint never reads. (That
is exactly why the `preview` and `development` profiles share a runtime
version today.)

`eas build` has no `--channel` flag (checked against eas-cli 21.0.1), so CI
sets it the same way it already sets the bundle stamp: write the working tree,
build, don't commit.

1. Add a `preview-pr` profile to `eas.json`, a copy of `preview`.
2. Before triggering, `publish-mobile-pr-preview.ts` rewrites that profile's
   `channel` to the PR's channel. `eas-cli` uploads the working tree, so the
   value travels with the job — same mechanism as `src/build-info.json`.
3. `eas build --profile preview-pr --no-wait`.

**One build per PR branch, not per push.** `ensureBuildForRuntime` becomes
`ensureBuildForPr({ channel, runtime })`: reuse a build whose runtime *and*
channel both match, otherwise trigger one. So the first push to a mobile PR
costs a build (~15–20 min, EAS build minutes — worth watching); every later
push reuses it and rides OTA. A mid-PR fingerprint change triggers a fresh
one, as today.

**Both QRs become individually correct.**

| QR | Gets you | Correct when |
| --- | --- | --- |
| OTA (`iterate://preview-channel/<channel>`) | the PR's JS on the binary you already have | your binary's runtime matches |
| Install (EAS build page) | a binary whose *own* channel is the PR's | always |

So the expansion heuristic stops mattering: pick wrong and you lose a scan,
not an afternoon. `latestInstalledRuntime()` stays only as the label that
decides which to expand.

**The new-install guard stops being a footgun.**
`resetChannelOverrideForNewInstall()` clears any override on the first boot of
a new binary. Today that means installing a PR build drops you onto main.
Once the binary's own channel *is* the PR's, clearing the override lands you
exactly where you wanted — the guard becomes purely protective. No change
needed to it, which is the point.

**Also fix while in here:** `ensureBuildForPr` should prefer a *finished*
build and render "build in progress — install link appears when it's done"
rather than linking a queued build as though it were installable.

### 2. Check on open

`UpdateWatcher`, mounted at the root:

- runs when `watched` is true (`channel !== binary.defaultChannel ||
  binary.defaultChannel !== "preview"` — an override, or a non-main binary,
  which with per-PR builds is now most of them);
- runs on mount **and** on `AppState` returning to `active`, so the check
  happens on every open rather than every cold start;
- shows a non-blocking banner — `1 behind: "fix the drawer glyph" · Update
  now` — rather than reloading under you mid-typing;
- when expo-updates has already downloaded it in the background,
  "Update now" is just `reloadAsync()`.

### 3. App-global sign-in

New `src/lib/session.ts` — small, one query key:

```ts
useSession(): { serverBaseUrl: string; signedIn: boolean; email: string | null };
```

Invalidated by sign-in, sign-out and server switch; nothing else re-derives
it. The QR mismatch card names the server it is talking about
(`preview 7 — needs a sign-in` rather than the bare `not signed in`), and the
two duplicated `SignInRequiredError → router.replace("/")` catches collapse
into one place.

### 4. Build info shows what you asked for

Covered by the module's `BuildState` — current channel, the build's default
channel, running commit + message, latest commit + message. Listed here so it
is checkable.

---

## Work

- [x] `src/lib/build-state.ts`: pure `describeBuildState` + `BuildState` type, with unit tests for every `update.status` branch — *split `build-state-core.ts` (pure, 11 tests) + `build-state.ts` (Expo/query binding), following the repo's existing `*-core.ts` idiom so the node lane can cover the rules*
- [x] Fold in `build-info.ts`, `preview-channel.ts`, `native-install-guard.ts`; delete them
- [x] `useBuildState` / `useBuildActions`
- [x] Rewrite `build-info.tsx` as a dumb view; add the channel/update rows
- [x] Rewrite `preview-channel/[channel].tsx` against the module; confirm + auto-pull behaviour intact, specs green
- [x] `src/lib/session.ts` + adopt it in `index.tsx`, `projects.tsx`, `chat.tsx`, the QR screen
- [x] Reword the mismatch card so it never claims you are signed out of the app — *`none on preview 3 → pr…` plus the real session underneath*
- [x] Stale banner + on-open check — *`components/update-banner.tsx`; the foreground trigger is react-query's `focusManager`, which `query.ts` already wires to AppState, so no listener of our own*
- [ ] Stamp into app config `extra.buildInfo`; `app.json` → `app.config.js`; add `ExpoConfigExtraSection` to `sourceSkips`; **verify the fingerprint does not move** — *not done; the reader below is in and falls back cleanly, so this is the only thing standing between "something newer exists" and "…and here's its commit message"*
- [x] Read the available update's stamp off `manifest.extra.expoClient.extra` — *`stampFromManifest`, shape-checked; returns `{}` until the config change above lands*
- [x] `eas.json`: add a `preview-pr` profile; CI rewrites its `channel` per PR before building
- [x] `ensureBuildForPr({channel, runtime})`: match on channel too, prefer finished builds, report in-progress ones honestly
- [x] Confirm the runtime fingerprint does **not** move when only `eas.json`'s channel changes — *it did move; see [Corrections](#corrections). `ignorePaths: ["eas.json"]` fixes it, measured either side*
- [x] `renderPreviewSection`: say what each QR now guarantees; the install one is no longer a half-measure
- [x] Web specs: the reworded mismatch card. ~~stale banner, "1 behind" row~~ — *web bundles report `update: unsupported`, so neither renders there; the rules behind them are covered in the node lane instead*
- [x] Update `apps/mobile/README.md` — the "Per-PR channels" section still said installing gets you a main binary

## Decisions I made without asking

- **Banner, not auto-reload**, when a newer update is found. Reloading under
  you mid-note is worse than being one push behind. Easy to flip.
- **`expected-backend.ts` survives.** It's pure, tested, and about backends,
  not builds. Folding it in would make the module a junk drawer.
- **Session is its own module**, not part of `build-state`. Different
  lifetime, different invalidation, and every screen needs it while only three
  need build state.
- **Per-PR native builds** over an https interstitial, per your call. If the
  build cost or latency turns out to be annoying, the interstitial
  (deep-link-then-install on one page) is still there as a fallback.

## Answered (annotation round 2)

- **Where the "not signed in" was seen:** don't remember — assume the QR
  confirm screen, i.e. covered by fix 3. If it shows up again after this
  lands, it's a second bug and gets its own hunt.
- **Stale banner scope:** overridden channels and non-`preview` binaries only.
  A phone tracking main stays silent, as now.
- **Build-per-PR cost:** accepted. A cleverer compromise (only build when the
  fingerprint actually differs) can come later if the wait bites.

## Implementation log

- `build-state-core.ts` is pure and `build-state.ts` is its Expo binding —
  the repo's existing `*-core.ts` split (`approver-core.ts`,
  `recent-photos-core.ts`, `media-sync-core.ts`). One conceptual owner, and
  the rules stay node-testable. `expected-backend.ts` reads the stamp from
  the core, so it stays Expo-free too.
- The banner component lives in `src/components/`, not exported from the
  module, matching where every other component lives.
- `BuildState.channel` is `string | null`, not `string`: a Metro bundle
  genuinely has no channel and the pure function shouldn't invent one.
- `isOverridden(state)` is a helper over `channel !== binary.defaultChannel`
  rather than stored state, per the annotation.
- The dead-sign-in redirect moved to the query cache's `onError` in
  `query.ts` — one place, and it now covers every screen rather than the two
  that happened to catch it.

### Still open

- No device pass yet. The web lane can't exercise OTA at all
  (`Updates.isEnabled` is false), so the banner, the on-open check and the
  install-then-run flow are unproven on hardware.
- The first PR to run this triggers a fresh EAS build, which is also the
  first real test of the channel-baking.
