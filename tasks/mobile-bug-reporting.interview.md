# Interview log: mobile-bug-reporting

Grill-you session, 2026-08-10. Sub-claude (sonnet, grill-with-docs) asks; main claude answers standing in for Misha.
Dossier: /tmp/grillings/iterate/mobile-bug-reporting/dossier.md
Sub-claude session: 419f49d9-0ba7-4ed9-af19-28c23a0c44b5

---

## Q1 — main-channel builds have no PR: what does 🐛 link to?

Sub-claude verified: only `preview` (main) and per-PR branch channels are ever published by CI; `production` profile unused. Main pushes already get a commit comment (QRs) keyed to the exact sha.

Recommendation: link main-channel builds to the commit page (`github.com/<repo>/commit/<sha>`), not a `listPullRequestsAssociatedWithCommit` lookup (ambiguous multi-PR edge case, no benefit — the commit-comment thread is already where CI leaves build artifacts). One stamped field either way.

## A1

Agree — commit page for main-channel, PR for PR-channel, no PR lookup. Nit: don't call the field `prUrl` if it can hold a commit URL; call it `githubUrl` `[guess: naming taste — honest name beats specific name]`. Stamp via the existing `write-build-info.mjs` seam, passed from the CI publish scripts (`publish-mobile-pr-preview.ts` knows the PR from `readEventPayload()`; `publish-mobile-update.ts` knows the sha). Local/dev builds get empty string; drawer item hides when empty.

---

## Q2 — where does the session log live?

Sub-claude verified: `DeviceRpcTarget.append` is a narrow notification-facts contract (ruled out); PR #2408 added `ephemeral: true` stream events (10 MiB memory-only FIFO per DO incarnation, excluded from PostHog export).

Recommendation: `project.streams.get()` on a dedicated path `/mobile-events` (root `/` has chat/approval traffic); ephemeral for nav, durable for errors. Noted the drawer only renders inside `project/[projectId]/` routes, so signed-out is a non-issue for the button itself.

## A2

Mostly agree, but ephemeral-for-nav has a hole: if the DO restarts between bug and report (or the agent reads it hours later), the nav trail is gone — defeating "maximal agent context". Fix with snapshot-at-report-time:

- Client keeps a local in-memory ring buffer of last ~200 events — the source of truth for reports; works regardless of server, survives append failures `[guess: 200 is arbitrary]`.
- Additionally fire-and-forget append with `ephemeral: true` to `/mobile-events` while a project connection is open — live observability, no durable bloat, never blocks UI.
- Errors: durable append at occurrence, agreed.
- The report itself is a durable event that EMBEDS the ring-buffer snapshot — agent context doesn't depend on ephemeral retention.

Path `/mobile-events` agreed `[guess: path name taste]`.

---

## Q3 — auto-post a GitHub comment server-side, or just link out?

Sub-claude verified: GitHub has no URL param to prefill a PR comment (only `issues/new?body=` exists, and that's a new issue). `itx.integrations.github.get().octokit` is scoped to the current project's GitHub App installation — not necessarily `iterate/iterate`.

Recommendation: hybrid — try server-side comment via project octokit, silent fallback to plain link.

## A3

Assume the project connection does NOT reach `iterate/iterate` `[guess: haven't verified any specific project's installation; designing fallback-as-common-case is right regardless]`. Flip it: zero-credential path is primary; cut server-side commenting from v1 entirely (silent-fallback paths that almost never fire are untested code paths).

Primary flow:
1. Tap 🐛 → snapshot ring buffer → durable report event to `/mobile-events` (snapshot + build-info + recent errors + server baseUrl + channel + updateId).
2. Copy compact markdown context block to clipboard (expo-clipboard): build info, itx reference to the report event (project + stream path + event id/offset), trimmed nav tail — in a `<details>` block.
3. Open `githubUrl` in browser; Misha pastes + attaches screenshot.

Toast before opening: "context copied — paste into a comment." Agent side: fetches the report event via `pnpm cli itx run` against the right env; the clipboard block includes the exact reference. No new agent tooling in v1.

---

## Q4 — event granularity: taps too, or nav + errors only?

Recommendation: v1 = `screen-viewed` (one router listener), `error-occurred` (global handler + new error boundary + upgraded console.error sites), `rpc-failed` (itx seam). No generic tap capture (requires global Pressable wrapping; "navigated X then Y" gets an agent close enough).

## A4

Agree. Additions: the error boundary is a pre-existing gap — add it as part of this. Export a tiny `logEvent(type, payload)` escape hatch so screens can hand-instrument domain-significant interactions; seed it in a handful of existing meaningful-write callsites (approver.ts, preview-channel switching) `[guess: which callsites — implementer's choice]`. Don't migrate console.log wholesale — only upgrade actual error-reporting catches (auth.ts).

---

## Q5 — one drawer item? await the durable append before opening GitHub?

Recommendation: single 🐛 item; await the append (sub-second on an open connection), then copy + open; on failure/timeout copy without the event reference and still open.

## A5

Agree on both. Await with a short timeout (~2s `[guess: exact number implementer's choice, must feel instant]`). Toast either way.

---

## Termination

Sub-claude declared all branches resolved and said "Ready for Phase 2". Also verified along the way: `switchChannelAndReload` calls `reloadAsync()`, so channel-override staleness is a non-issue (fresh bundle = fresh `build-info.json`).
