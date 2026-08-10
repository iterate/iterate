---
status: ready
size: medium
---

# Mobile bug-reporting infra

## Status summary

Implemented 2026-08-10 (spec grilled same day, see [interview log](mobile-bug-reporting.interview.md)). All three layers in: `githubUrl` stamping + 🐛 drawer item, session log (ring buffer + ephemeral mirroring + error boundary/global handler), and the clipboard report flow. Typecheck/lint/knip/tests green. Remaining: on-device verification of the end-to-end flow (needs a preview build from this PR, which CI produces).

## Original ask (verbatim)

> let's add some bug-reporting infra to the mobile app. what i want:
> for preview builds, show a bug emoji thing in the sidebar. it should just be a link to github which goes to the pull request for that build (i don't think we propagate this right now but it should be easy to do like the sha/preview branch etc.)
> that way i can screenshot and leave a screenshot. but i think we can go further too
>
> * we can store events for every interaction on the mobile app - screen navigations, errors etc.
> * for now i don't think they actually need to *drive* the mobile app because that'd get a bit complicated i think esp since we don't want to actually be remote-controlling the app from the cloud
> * but it can just be a factual log of what the user (currently, just me) did on the app
> * if there's a way to github deeplink to a PR with a comment template pre-filled then maybe we could do that. or basically whatever makes it possible to provide the agent working on a PR with maximal context about the session so the report is as helpful for the agent as possible

## Design

### Layer 1 — build → GitHub link

`apps/mobile/src/build-info.json` gains a `githubUrl` field, stamped by `apps/mobile/scripts/write-build-info.mjs`:

- PR-channel builds (`.depot/workflows/mobile-pr-preview.yml` → `scripts/ci/publish-mobile-pr-preview.ts`): the PR URL, from `readEventPayload()`.
- Main-channel builds (`mobile-eas-update.yml` → `publish-mobile-update.ts`): the commit page URL `github.com/<repo>/commit/<sha>` — the CI commit comment with QRs lives on that page. Deliberately NO `listPullRequestsAssociatedWithCommit` lookup (squash-merge stream, ambiguous multi-PR edge cases, no benefit).
- Local/dev builds: empty string; the drawer item hides.

Note: GitHub has no URL param to prefill a PR *comment* (only `issues/new?body=` exists, and that creates a new issue) — confirmed, ruled out. Hence the clipboard design in layer 3.

### Layer 2 — session event log

- **Ring buffer**: in-memory, last ~200 events, in `apps/mobile/src/lib/` — the source of truth for reports. Works regardless of which server the build points at, signed in or not.
- **Event kinds (v1)**, named per `docs/events.md`:
  - `events.iterate.com/mobile/screen-viewed` — one expo-router route-change listener (pathname + params).
  - `events.iterate.com/mobile/error-occurred` — new global JS error handler + new React error boundary (pre-existing gap, filled here) + upgrading the error-reporting catch blocks in `auth.ts` (not a wholesale console.log migration).
  - `events.iterate.com/mobile/rpc-failed` — at the itx seam.
- **No generic tap capture** in v1 (would need global Pressable wrapping; nav trail gets an agent close enough). Instead export `logEvent(type, payload)` as an escape hatch and seed it at a handful of existing meaningful-write callsites (`approver.ts`, preview-channel switching).
- **Ephemeral mirroring**: while a project connection is open, fire-and-forget append ring-buffer events with `ephemeral: true` to `project.streams.get("/mobile-events")` — live observability with no durable bloat (PR #2408 semantics). Must never block or slow the UI.
- **Errors are durable**: `error-occurred` also gets a durable (non-ephemeral) append at occurrence time — rare, high-value, survives DO restarts.
- Ruled out: `DeviceRpcTarget.append` (narrow notification-facts contract), PostHog-direct client calls (streams already export to PostHog on prd), local-only storage (no live visibility).

### Layer 3 — report flow

Single drawer item in `apps/mobile/src/components/project-drawer.tsx` (next to "Build info"): **🐛 Report bug**, visible only when `githubUrl` is non-empty. On tap:

1. Snapshot the ring buffer.
2. Durable-append a report event to `/mobile-events` embedding: snapshot, build-info, server baseUrl, channel, updateId. Await with a short (~2s) timeout.
3. Copy a markdown context block to the clipboard (expo-clipboard): build info, the itx reference to the report event (project + stream path + event id/offset — exactly what an agent needs to fetch it via `pnpm cli itx run`), and a trimmed human-readable nav tail, wrapped in `<details>` so it doesn't swamp the PR thread.
4. Toast: "context copied — paste into a comment", then open `githubUrl` in the browser. Misha pastes, attaches a screenshot, adds a sentence.

On append failure/timeout: clipboard block without the event reference, still open the link — the flow never blocks on the network.

No server-side GitHub comment posting in v1: `itx.integrations.github` is scoped to the current project's GitHub App installation, which won't reach `iterate/iterate` for dogfooding projects — and a silent-fallback path that almost never fires is an untested code path.

## Checklist

- [x] Stamp `githubUrl` in `write-build-info.mjs` (arg/env from CI publish scripts; empty locally); update `mobile-preview.test.ts` if it covers stamping _(env var `MOBILE_BUILD_GITHUB_URL` set by both publish scripts; the test file doesn't cover stamping, no changes needed)_
- [x] Ring buffer + `logEvent(type, payload)` module in `apps/mobile/src/lib/` _(`session-log.ts` — deliberately import-free so leaf modules like auth.ts can log without cycles; mirroring split into `session-log-mirror.ts`)_
- [x] `screen-viewed` router listener wired in `_layout.tsx` _(`ScreenViewLogger` component: render-time `logScreenView` with pathname dedupe instead of useEffect, per house rules)_
- [x] Global error handler + React error boundary → `error-occurred` (durable append at occurrence) _(`installSessionErrorLogger` chains onto ErrorUtils; `components/error-boundary.tsx` logs + offers reload)_
- [x] `rpc-failed` capture at the itx seam _(implemented as `query-failed`/`mutation-failed` via react-query cache subscriptions in `query.ts` — the one seam nearly every RPC rides; honest naming since not every query is an RPC)_
- [x] Ephemeral fire-and-forget mirroring to `/mobile-events` when project connection open _(`session-log-mirror.ts`; project context tracked from route params by the screen logger)_
- [x] Seed `logEvent` at approver.ts + preview-channel switch callsites _(`approval-signed`, `preview-channel-switched`; auth.ts error catches upgraded to `logError`)_
- [x] 🐛 drawer item + report flow (snapshot → durable report event → clipboard → toast → open browser) _(`bug-report.ts`; Alert doubles as the toast with an "Open GitHub" button; 2s append timeout)_
- [x] Verify the clipboard block renders well pasted into a GitHub comment (details block, no mangled markdown) _(inline-snapshot test on the pure builder `bug-report-markdown.ts`; needs one real paste check on-device once a preview build exists)_

## Out of scope

- Remote control / cloud-driving the app (explicitly ruled out by Misha)
- Server-side GitHub comment posting (revisit if dogfooding projects gain an `iterate/iterate` installation)
- Generic tap-level capture; session replay (rrweb-style)
- Android specifics; multi-user attribution; a bug-tracker UI in OS
- New agent-side tooling (existing `pnpm cli itx run` reads the report event)

## Guesses and assumptions

Carried from the [interview](mobile-bug-reporting.interview.md); flagged inline there as `[guess: ...]`:

- `githubUrl` as the field name (honest name over `prUrl` since it can hold a commit URL)
- Ring buffer size ~200; append timeout ~2s — implementer picks exact numbers
- Stream path `/mobile-events`
- Dogfooding projects' GitHub installations don't reach `iterate/iterate` (not verified per-project; fallback-as-primary is right regardless)
- Which callsites to seed with `logEvent` — implementer's choice, keep to a handful

## For the next pass (not v1)

- Opportunistic server-side comment posting when the project's GitHub installation reaches the target repo
- PostHog dashboards over the durable report events (prd streams already export)
- A `screen-viewed` trail viewer in the OS dashboard
