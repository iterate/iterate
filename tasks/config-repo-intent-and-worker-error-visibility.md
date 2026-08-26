---
status: ready
size: medium
---

# Config repo intent + worker error visibility

**Status summary**: implemented — both gaps landed with specs (template sync
core + IDE button; durable build-failure rendering + `subscriptionHealth()`
rollup + polled dashboard sheet + `lastErrorAt`). Remaining: CI verification
and review follow-ups. Spec transcript:
[config-repo-intent-and-worker-error-visibility.interview.md](./config-repo-intent-and-worker-error-visibility.interview.md).

Two platform gaps from the 2026-08-25 misha-project incident: a config repo
pinned a July SDK whose skew broke agent births twice over (missing `this.itx`
getter, then a moved `iterate/github-ai-linter` entry after the bump), and
both failures were near-invisible — one surfaced only inside the agent's own
chat, the other only in a subscription `lastError` field reachable over RPC.

## Gap 1 — template intent + re-sync button

- **No new intent storage.** The durable `createRequest` already reduced onto
  repo processor state IS the intent: `{type: "github-public-template",
  owner, repo, path, ref}` from the picker, or `{type: "empty"}` for
  programmatic creates seeded from the embedded `PROJECT_REPO_INITIAL_FILES`.
  `empty` maps to the same GitHub reference the picker's "Default" option
  sends, so every repo is syncable. A pinned-SHA `ref` (previews) is stripped
  when resolving "latest head" → default-branch HEAD.
- **`repo.syncFromTemplate()`** on the `Repo` itx capability. Per-file
  three-way against the template content at the last sync (initially the
  seed/root commit): user-unchanged → take latest template;
  user-edited-but-template-unchanged → keep user's; both-changed → **skip and
  report**. One normal default-branch commit, never a reset; no line-level
  merging (git history covers the curious). Appends
  `repo/template-synced {templateCommitOid}` as the next sync's base.
  Returns `{commitOid, updated, skipped, templateCommitOid, upToDate?}`;
  clear error on non-templated repos. GitHub-linked repos need nothing
  special — the commit mirrors like any other.
- **UI**: a "Template" row in the repo IDE chrome — "Created from
  `<owner/repo/path>` @ `<ref>`" + an "Update to latest template" button.
  Dumb button, no dry-run; the result toast lists updated/skipped counts and
  paths (with a line noting skipped = files you edited).

## Gap 2 — worker error visibility

- **Build failures: push, durable.** When the build coordinator records a
  terminal build failure for the config repo head, append
  `project/worker-build-failed {commitOid, error}` to `/` (failure
  counterpart of the existing `project/worker-updated`).
  `ProjectWorkerHealthWarning` renders it red until a later `worker-updated`
  supersedes it, and cross-links to the config repo IDE page (where the sync
  button lives — the incident's fix path was literally "worker broken →
  update template").
- **Child-stream subscription health: pull.** A named project-level itx
  capability method doing server-side fan-out over recently-active agent
  streams + well-known platform streams, returning per-stream subscription
  entries (name, status, lag, confirmedOffset, lastError, lastErrorAt).
  Dashboard polls it via react-query only while open (~60s). The method IS
  the programmatic surface for agents. Name/placement: implementer's call.
- **Severity tiers**: halted → red badge; lagging/backoff (delivery not
  currently flowing) → amber badge; historical `lastError` with zero lag →
  returned in the result and shown as a quiet informational line in the
  sheet, never the badge (alarm fatigue kills the surface).
- **`lastErrorAt`** recorded next to `lastError` at write time — no
  migration; absent = unknown age.
- Userspace reaction crashes stay surfaced via agent chat + the pull view's
  persisted `lastError`; no new surface for them.

## Guesses and assumptions (from the interview — spot-check these)

- `{type: "empty"}` → default-template mapping [guess: the embedded seed IS
  the default template at some ref; "same applies for other templates"
  implies universal coverage].
- "Recently-active agents + well-known platform streams" as the fan-out
  bound [guess: no cheaper activity signal exists].
- Health-warning → config-repo-IDE cross-link [guess: cheap, incident-shaped].
- `lastErrorAt` addition [guess: cheap now, unlocks time-aware tiers later].

## Residual risks (implementer: turn these into specs where possible)

- Seeds substitute `iterateRepoPkgRef`/`iterateRepoPkgSpecOverrides` into
  package.json; a GitHub-fetched sync must re-apply the same substitution
  (reuse the `projectRepoSeedFiles` repointing) before diffing, or every sync
  reports package.json as changed.
- Once an owner hand-edits package.json (as in the incident), template
  changes to it are skipped-and-reported forever — accepted; say so in the
  toast copy.
- Old repos with pre-substitution history may report a noisy first sync —
  harmless (normal commit); cover with an integration spec.
- The fan-out bound may need a tighter activity signal if agent streams
  accumulate fast.

## Out of scope

Auto/scheduled re-sync; pkg.pr.new staleness; SDK export-layout changes;
notifications beyond the dashboard; the 7.5-minute processor-stall incident;
retrofitting intent onto repos beyond the `empty`→default mapping.

## Checklist

- [x] `repo.syncFromTemplate()`: template resolution (github-public-template
      + empty→default), three-way file plan, skip-and-report, normal commit,
      `repo/template-synced` event, package.json substitution re-applied
      _(template-sync.ts owns reference resolution + plan + orchestration;
      RepoDurableObject.syncFromTemplate runs it under the write serializer;
      RepoRpcTarget resolves intent from processor state; substitution
      generalized as `repointPackageJsonDependencies` in project-repo-seed.ts)_
- [x] integration specs: clean sync, user-edited-keep, both-changed-skip,
      repeated sync no-op (`upToDate`), first-sync-on-old-history
      _(template-sync.test.ts drives runTemplateSync through an in-memory
      repo/template fake — all five scenarios plus deletes and the
      pinned-seed substitution case)_
- [x] repo IDE "Template" row + button + result toast
      _(repo-template-panel.tsx, mounted above the GitHub panel in the gh
      sidebar view; toast lists updated/skipped paths and notes skipped =
      files you edited)_
- [x] `project/worker-build-failed` appended on terminal build failure;
      ProjectWorkerHealthWarning renders + supersession + cross-link; spec
      _(deviation: reuses the EXISTING `project/worker-update-failed`
      (#2299) instead of a duplicate event; worker-loader.ts appends it for
      no-commit failures — the coordinator DO is buildKey-shared across
      projects so the append lives where project context exists; reduced
      `worker` slot + selectWorkerBuildFailure render/supersede; specs in
      project-processor.test.ts + project-worker-health.test.ts)_
- [x] subscription-health itx method (fan-out, tiers, lastErrorAt) + spec
      _(`itx.subscriptionHealth()` on ProjectRpcTarget; pure selection +
      tier logic in domains/projects/subscription-health.ts with tests;
      `last_error_at` column via new sqlfu migration, stamped in nack and
      cleared with last_error, spec in stream-storage.test.ts)_
- [x] dashboard sheet: red/amber badges, informational lastError rows,
      react-query polling gated on visibility
      _(project-worker-health.tsx polls every 60s — react-query pauses the
      interval in hidden tabs; historical errors are quiet lines with an
      age label, never a badge)_
- [x] docs breadcrumb (apps/os/AGENTS.md or docs/) for both surfaces
      _(apps/os/README.md "Important Files" — one entry naming all three
      surfaces and their modules)_

## Implementation log

2026-08-25 — recon pass over the named code. Two findings that shape the build:

- `project/worker-update-failed {commitOid, error}` ALREADY exists
  (project-processor-contract.ts, added in #2299) and is appended on `/` when
  the commit-triggered readiness probe hits a terminal build failure. The
  interview's "no failure counterpart" was stale. **Deviation: reuse
  `project/worker-update-failed` instead of introducing a duplicate
  `project/worker-build-failed`.** The genuinely missing pieces: (a) a
  terminal build failure with NO new commit (the incident: platform-side SDK
  skew) appends nothing — fix by appending the same event from the worker
  build resolution when the failing source is the config repo head;
  (b) nothing reduces the outcome into project state; (c) nothing renders it.
- The build coordinator DO is keyed by content-hash buildKey shared across
  projects (identical seeded repos share one build), so appending from
  `#rememberTerminalFailure` itself is unworkable — the append happens where
  a build failure is observed WITH project context (worker-loader's
  resolveThroughBuild, which pins repo source to a commitOid before building).

Planned slices:

1. Template sync core: `downloadPublicGithubTemplate` returns
   `{commitOid, files}`; generalize the package.json repointing out of
   `projectRepoSeedFiles`; new `template-sync.ts` (reference resolution from
   createRequest incl. empty→default + pinned-SHA strip, pure three-way
   plan); `repo/template-synced` event + `lastTemplateSync` state slot
   (contract 0.8.0→0.9.0); `RepoDurableObject.syncFromTemplate` under the
   write serializer; `RepoRpcTarget.syncFromTemplate()`.
2. Repo IDE Template row + toast.
3. Worker-update-failed append from worker-loader on config-repo build
   failure; `worker` outcome slot reduced into project state; health warning
   renders red + cross-link; supersession via the slot holding the latest
   outcome.
4. `last_error_at` column (new sqlfu migration) written beside `last_error`,
   surfaced through cursor row, listSubscriptions (+ attempt/nextAttemptAt),
   describeSubscription, and runtime state.
5. Project-level `subscriptionHealth()` on ProjectRpcTarget: fan-out over
   `/` + well-known platform streams + agent streams ranked by the streams
   index `lastActivityAt` (cap 20 — the index IS the activity signal), tier
   classification (halted/lagging/informational) in a pure module.
6. Dashboard sheet: badges + informational rows + 60s react-query polling
   (visibility-gated by react-query's default refetchIntervalInBackground).
7. Docs breadcrumb + itx-api regeneration.

2026-08-25 (later) — all slices landed. Decisions made while implementing:

- Template-synced base advance: `repo/template-synced` records the latest
  template revision after EVERY run that read a newer one, commit or not and
  skips or not — so a both-changed skip is reported once per template change
  (at the moment of the sync whose toast explains it), not on every click.
  The task's "skipped-and-reported forever" reads as "never auto-updated
  again"; re-reporting stale skips on every click is exactly the alarm
  fatigue Q4 warned about.
- `downloadPublicGithubTemplate` now returns `{commitOid, files}` (the sync
  needs the revision identity; creation ignores it).
- The worker-loader append awaits inline on the (rare) failure path rather
  than using waitUntil — the loader is a plain function without an
  ExecutionContext, and a dangling promise could be cancelled at request end.
- "Recently-active agents" uses the project DO's streams index
  `lastActivityAt` (a real activity signal — better than the interview's
  guess that none exists cheaply), capped at 20.
- Known cosmetic flaw: the slice-3 commit message contains a shell-quoting
  artifact ("appendú", a swallowed word) — left as-is (no history rewrites);
  the squash-merge commit message comes from the PR body anyway.

2026-08-25 (later still) — playwright spec coverage + walkthrough videos
(missed convention, flagged by Misha): `specs/repo-ide-template-sync.spec.ts`
(provenance row → sync → toast → recorded base) and
`specs/project-worker-health.spec.ts` (a breaking config commit → red
sidebar warning → sheet with build error AND the polled child-stream rollup
rows → "Open config repo" → Template panel). The failure injection is a
plain `repo.commitFiles` of broken worker.ts — the real incident shape, no
test-only hooks. The sync button gained a `data-spinner` marker while
pending (the spec waiters key on it; also honest progress UI). Videos
recorded with VIDEO_MODE=1 and embedded in the PR body as bare
user-attachments URLs.

2026-08-25 (review round) — cursor bugbot raised two valid points, both
fixed in 0af4fa54f and their threads resolved: the loader-side failure
journal moved from a public append with a guessable key to the platform
door under the readiness probe's own internalStreamId key (un-claimable,
and the two sources now dedupe into one outcome per commit), and the health
sheet's description grew a third branch so child-stream-only trouble no
longer blames the root stream.

Round 2 (61de39ee5): cursor's high-severity follow-up was right — sharing
the probe's one-outcome-per-commit key would have silenced a later
platform-side failure of an already-successful commit, the exact incident
shape. The loader journal now keys by (commitOid, buildKey): the buildKey
folds in the deployment's package substitution, so platform skew journals a
new failure fact while retries of the same broken build dedupe. Plus lint
follow-ups: typed construction instead of as-const in the worker reduce,
an explained disposer cast, and metaphor-free comment wording. One CI
Previews round failed on a transient Cloudflare API error deploying the
auth app (code 10013, unrelated to this PR) — retried.

2026-08-26 — Misha's review (3b59d2460): `subscriptionHealth` takes
`{ agentStreamLimit? }` (default 20, hard cap 100, 0 = platform streams
only); sync commits carry Template-Reference / Template-Commit git trailers
(the durable event stays the three-way base's authority — messages are
user-editable, and empty→default must work before any sync commit). The
useQuery auto-poll question answered as by-design (the badge is the
discovery surface; visibility-gated). Follow-up idea left on the thread:
stamp the SEED commit with its template identity and derive
"commits on top of template Y@Z" from trailers — valuable for
GitHub-imported repos whose event history is gone.
