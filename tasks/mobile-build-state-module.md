---
status: needs-annotation
size: large
---

# Mobile: one module owns "which build am I on, and is it current?"

## Status

Not started. This is a plan for annotation, not a log.

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
    /** The channel baked in at build time — "the default OTA branch for my build". */
    defaultChannel: string;
  };
  channel: {
    /** What updates are actually fetched from — override, else default. */
    current: string;
    isOverride: boolean;
  };
  update:
    | { status: "current" }
    | { status: "behind"; latest: { commit: string; message: string; publishedAt: Date } }
    | { status: "pending" }          // downloaded, applies on reload
    | { status: "incompatible" }     // channel has newer JS this binary can't run
    | { status: "unsupported"; why: "metro" | "dev" }
    | { status: "checking" }
    | { status: "error"; message: string };
  /** Non-default binary, or a channel override: watch this one on every open. */
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
    Current            specs-create-agent-sweep   (override)
    Default for build  preview
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

### 1. One QR that always works

Replace the two mutually-exclusive QRs with **one**, encoding an https
interstitial that carries the channel *and* the build:

```
https://os.iterate.com/m/pr/<channel>?build=<easBuildId>
```

The page (extending `m.preview-channel.$channel.ts`):

1. immediately attempts `iterate://preview-channel/<channel>`;
2. if still visible after ~1.5s, the app isn't installed — show a large
   **Install this build** button pointing at the EAS page;
3. *always* keep an **Open in app** button on screen, so the post-install
   return trip is one tap on a page already open in Safari.

Scan → install if needed → tap Open → confirm → on the PR's channel. No
heuristic about what is on your phone, no collapsed section, no wrong order to
get wrong. The runtime-fingerprint comparison stays, demoted to a label
("this PR changes native code — you'll need the install step").

`ensureBuildForRuntime` also gets fixed to prefer a **finished** build and to
say "build in progress" rather than linking a queued one as if it were
installable.

Keep a collapsed second block with the raw EAS link for when you want it.

> **Alternative worth arguing about:** bake the PR's channel into a per-PR
> native build so a fresh install boots straight onto the PR's JS. Correct in
> one step, but it is a full EAS build per PR (~15–20 min, no reuse across
> branches) and it likely moves the fingerprint per PR. I don't think it's
> worth it — say if you disagree.

### 2. Check on open

`UpdateWatcher`, mounted at the root:

- runs when `watched` is true (`isOverride || defaultChannel !== "preview"`);
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

- [ ] `src/lib/build-state.ts`: pure `describeBuildState` + `BuildState` type, with unit tests for every `update.status` branch
- [ ] Fold in `build-info.ts`, `preview-channel.ts`, `native-install-guard.ts`; delete them
- [ ] `useBuildState` / `useBuildActions` over one query key
- [ ] Rewrite `build-info.tsx` as a dumb view; add the channel/update rows
- [ ] Rewrite `preview-channel/[channel].tsx` against the module; keep the confirm + auto-pull behaviour and every existing spec green
- [ ] `src/lib/session.ts` + adopt it in `index.tsx`, `projects.tsx`, `chat.tsx`, the QR screen
- [ ] Reword the mismatch card so it never claims you are signed out of the app
- [ ] `UpdateWatcher` + AppState foreground check + stale banner
- [ ] Stamp into app config `extra.buildInfo`; `app.json` → `app.config.js`; add `ExpoConfigExtraSection` to `sourceSkips`; **verify the fingerprint does not move**
- [ ] Read the available update's stamp off `manifest.extra.expoClient.extra`
- [ ] `m/pr/<channel>?build=<id>` interstitial with deep-link-then-install fallback
- [ ] `renderPreviewSection`: one primary QR; install link demoted to a collapsed block
- [ ] `ensureBuildForRuntime`: prefer finished builds, report in-progress ones honestly
- [ ] Web specs: stale banner, "1 behind" row, the reworded mismatch card (the `build-info-override` localStorage seam already supports this)
- [ ] Update `apps/mobile/README.md` — the "Per-PR channels" section describes the two-QR flow being removed

## Decisions I made without asking

- **Banner, not auto-reload**, when a newer update is found. Reloading under
  you mid-note is worse than being one push behind. Easy to flip.
- **`expected-backend.ts` survives.** It's pure, tested, and about backends,
  not builds. Folding it in would make the module a junk drawer.
- **Session is its own module**, not part of `build-state`. Different
  lifetime, different invalidation, and every screen needs it while only three
  need build state.
- **No per-PR native builds** (see the alternative above).

## Open questions

1. Which screen were you on when it said "not signed in"? If it was the QR
   confirm screen, fix 3 covers it; anywhere else and there's a second bug.
2. Do you want the stale banner on main/preview too, or only on overridden
   channels and non-preview binaries as specified?
3. Is one QR per PR right, or do you want the raw EAS install link kept
   visible rather than collapsed?
